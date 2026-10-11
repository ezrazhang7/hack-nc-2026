import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {ChainEvent} from './indexer.js';
import {recordRoundOpenedWithClient} from '../../rounds/service.js';
const integer=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n);
const address=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const fields=(payload:unknown)=>z.record(z.string(),z.unknown()).parse(payload);
const get=(p:Record<string,unknown>,key:string)=>Object.entries(p).find(([k])=>k.replaceAll('_','').toLowerCase()===key.replaceAll('_','').toLowerCase())?.[1];
const hex=(value:unknown)=>Buffer.from(z.array(z.number().int().min(0).max(255)).length(32).parse(value)).toString('hex');
/** Resolve foreign keys before inserting the immutable canonical event. */
export async function eventMapping(db:PoolClient,event:ChainEvent):Promise<{projectId:string|null;roundId:string|null}> {
  const p=fields(event.payload),kind=event.eventType.replaceAll('_','').toLowerCase();
  if(kind==='projectcreated') {
    const h=Buffer.from(z.array(z.number().int().min(0).max(255)).length(16).parse(get(p,'project_id'))).toString('hex');
    return {projectId:`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`,roundId:null};
  }
  const round=address.safeParse(get(p,'round'));
  if(round.success) {
    const result=kind==='roundopened'
      ? await db.query<{id:string;project_id:string}>('SELECT r.id,r.project_id FROM rounds r JOIN projects p ON p.id=r.project_id WHERE p.solana_project_pda=$1 AND r.round_number=$2',[address.parse(get(p,'project')),z.number().int().min(1).max(65535).parse(get(p,'round_number'))])
      : await db.query<{id:string;project_id:string}>('SELECT id,project_id FROM rounds WHERE solana_round_pda=$1',[round.data]);
    if(!result.rows[0]) throw new Error('Finalized round has no database mapping.');
    return {projectId:result.rows[0].project_id,roundId:result.rows[0].id};
  }
  const project=address.safeParse(get(p,'project'));
  if(project.success) {
    const result=await db.query<{id:string}>('SELECT id FROM projects WHERE solana_project_pda=$1',[project.data]);
    if(!result.rows[0]) throw new Error('Finalized project has no database mapping.');
    return {projectId:result.rows[0].id,roundId:null};
  }
  return {projectId:null,roundId:null};
}
/** Apply only finalized program events, in the same transaction as their canonical dedupe record. */
export async function projectEvent(db:PoolClient,event:ChainEvent,eventId:string) {
  const p=fields(event.payload);
  const kind=event.eventType.replaceAll('_','').toLowerCase();
  if(kind==='projectcreated') {
    const bytes=z.array(z.number().int().min(0).max(255)).length(16).parse(get(p,'project_id'));
    const h=Buffer.from(bytes).toString('hex');const id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    const founder=address.parse(get(p,'founder_wallet')),project=address.parse(get(p,'project')),mint=address.parse(get(p,'receipt_mint'));
    const result=await db.query(`UPDATE projects SET solana_project_pda=$2,receipt_mint=$3,founder_wallet=$4 WHERE id=$1
      AND (founder_wallet IS NULL OR founder_wallet=$4) AND (solana_project_pda IS NULL OR solana_project_pda=$2)
      AND EXISTS(SELECT 1 FROM wallets w WHERE w.identity_id=projects.founder_identity_id AND w.address=$4 AND w.revoked_at IS NULL) RETURNING id`,[id,project,mint,founder]);
    if(!result.rowCount) throw new Error('Project event mapping does not match a verified founder.');
    return;
  }
  const round=address.safeParse(get(p,'round'));if(!round.success) return;
  let mapping=await db.query<{id:string;project_id:string}>(`SELECT id,project_id FROM rounds WHERE solana_round_pda=$1`,[round.data]);
  if(kind==='roundopened') {
    const project=address.parse(get(p,'project'));
    const number=z.number().int().min(1).max(65535).parse(get(p,'round_number'));
    mapping=await db.query<{id:string;project_id:string}>(`SELECT r.id,r.project_id FROM rounds r JOIN projects p ON p.id=r.project_id WHERE p.solana_project_pda=$1 AND r.round_number=$2`,[project,number]);
    if(!mapping.rows[0]) throw new Error('Opened round has no immutable draft mapping.');
    await recordRoundOpenedWithClient(db,mapping.rows[0].id,{roundPda:round.data,projectPda:project,receiptMint:address.parse(get(p,'receipt_mint')),roundNumber:number,
      opensAt:integer.parse(get(p,'opens_at')),closesAt:integer.parse(get(p,'closes_at')),unitPriceMicroUsd:integer.parse(get(p,'unit_price_micro_usd')),
      maxUnits:integer.parse(get(p,'max_units')),targetAmount:integer.parse(get(p,'target_amount')),maxSubscriptionAmount:integer.parse(get(p,'max_subscription_amount')),
      modelHash:hex(get(p,'model_hash')),evidenceRoot:hex(get(p,'evidence_root'))});
  }
  const row=mapping.rows[0];if(!row) throw new Error('Round event mapping is missing.');
  const metrics:Array<[string,string]>=[];
  if(kind==='subscriptionaccepted') {
    metrics.push(['SUBSCRIPTION_GROSS_MICRO_USD',integer.parse(get(p,'gross_amount'))]);
    const buyer=address.parse(get(p,'buyer_wallet'));
    const identity=await db.query<{identity_id:string}>('SELECT identity_id FROM subscription_intents WHERE round_id=$1 AND wallet_address=$2',[row.id,buyer]);
    if(!identity.rows[0]) throw new Error('Subscription event has no eligible identity reservation.');
    const identityId=identity.rows[0].identity_id;
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`participant:${row.project_id}:${identityId}`]);
    const prior=await db.query(`SELECT 1 FROM market_metrics WHERE project_id=$1 AND metric_code='NEW_PARTICIPANT' AND dimensions->>'identityId'=$2 LIMIT 1`,[row.project_id,identityId]);
    if(!prior.rows.length) await db.query(`INSERT INTO market_metrics(observed_at,project_id,round_id,chain_event_id,metric_code,value,dimensions) VALUES(now(),$1,$2,$3,'NEW_PARTICIPANT',1,$4)`,[row.project_id,row.id,eventId,{identityId}]);
    // Add this event's delta; log order across transactions does not need to match wall-clock order.
    await db.query('UPDATE rounds SET total_committed_micro_usd=total_committed_micro_usd+$2::bigint WHERE id=$1',[row.id,metrics[0]![1]]);
  } else if(kind==='roundfinalized') await db.query('UPDATE rounds SET status=$2::round_status WHERE id=$1',[row.id,integer.parse(get(p,'total_committed'))==='0' ? 'EXPIRED' : 'FINALIZED']);
  else if(kind==='roundcancelled') await db.query("UPDATE rounds SET status='REFUNDING' WHERE id=$1",[row.id]);
  else if(kind==='allocationminted') for(const [code,key] of [['SUBSCRIPTION_ACCEPTED_MICRO_USD','accepted_amount'],['RECEIPT_UNITS_MINTED','units'],['PROTOCOL_FEE_MICRO_USD','fee'],['FOUNDER_REWARD_MICRO_USD','founder_reward']]) metrics.push([code!,integer.parse(get(p,key!))]);
  else if(kind==='excessrefunded') metrics.push(['REFUND_MICRO_USD',integer.parse(get(p,'amount'))]);
  for(const [code,value] of metrics) await db.query(`INSERT INTO market_metrics(observed_at,project_id,round_id,chain_event_id,metric_code,value) VALUES(now(),$1,$2,$3,$4,$5)`,[row.project_id,row.id,eventId,code,value]);
}
