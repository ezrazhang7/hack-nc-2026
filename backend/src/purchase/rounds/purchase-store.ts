import { VersionedTransaction } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../http/errors.js';
import { FundingStore } from '../banking/store.js';
import type { RoundInfo, SubscriptionState } from '../banking/types.js';
import { allocation } from './allocation.js';

export interface SubscriptionIntent {
  id:string;identityId:string;roundId:string;wallet:string;gross:string;key:string;requestHash:string;
  chainIntentId:string|null;ordinal:number;preview:unknown;
}
interface SubRow {
  id:string;identity_id:string;round_id:string;wallet_address:string;gross_amount_micro_usd:string;idempotency_key:string;request_hash:string;
  chain_intent_id:string|null;ordinal:number;preview:unknown;
}
const sub=(row:SubRow):SubscriptionIntent => ({id:row.id,identityId:row.identity_id,roundId:row.round_id,wallet:row.wallet_address,gross:String(row.gross_amount_micro_usd),
  key:row.idempotency_key,requestHash:row.request_hash,chainIntentId:row.chain_intent_id,ordinal:row.ordinal ?? 0,preview:row.preview});
export class PurchaseStore {
  readonly transactions:FundingStore;
  constructor(readonly pool:Pool) { this.transactions=new FundingStore(pool); }
  async byKey(identityId:string,key:string):Promise<SubscriptionIntent|null> {
    const result=await this.pool.query<SubRow>(`SELECT s.*,COALESCE((SELECT max(ordinal) FROM subscription_chain_attempts a WHERE a.subscription_intent_id=s.id),0) AS ordinal
      FROM subscription_intents s WHERE s.identity_id=$1 AND s.idempotency_key=$2`,[identityId,key]);return result.rows[0] ? sub(result.rows[0]) : null;
  }
  async round(id:string):Promise<{id:string;projectId:string;address:string}|null> {
    const result=await this.pool.query<{id:string;project_id:string;solana_round_pda:string}>('SELECT * FROM rounds WHERE id=$1',[id]);
    const row=result.rows[0];return row ? {id:row.id,projectId:row.project_id,address:row.solana_round_pda} : null;
  }
  async eligibility(identityId:string,roundId:string,wallet:string):Promise<void> {
    const result=await this.pool.query<{founder:boolean;team:boolean;flagged:boolean;wallet:boolean}>(`SELECT
      p.founder_identity_id=$1 AS founder,EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.identity_id=$1) AS team,
      (i.status<>'ACTIVE' OR i.risk_flags<>'[]'::jsonb) AS flagged,EXISTS(SELECT 1 FROM wallets w WHERE w.identity_id=$1 AND w.address=$3 AND w.revoked_at IS NULL AND w.chain='solana') AS wallet
      FROM rounds r JOIN projects p ON p.id=r.project_id JOIN identities i ON i.id=$1 WHERE r.id=$2 AND i.verified_at IS NOT NULL`,[identityId,roundId,wallet]);
    const value=result.rows[0];
    if (!value?.wallet) throw new AppError('WALLET_NOT_VERIFIED','Verify this wallet before subscribing.',409);
    if (value.founder || value.team) throw new AppError('SELF_SUBSCRIPTION_FORBIDDEN','Founder and team identities cannot participate in their own project.',409);
    if (value.flagged) throw new AppError('FORBIDDEN','Identity is not eligible for participation.',403);
  }
  async reserve(identityId:string,roundId:string,wallet:string,gross:string,key:string,requestHash:string):Promise<SubscriptionIntent> {
    return this.transactions.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`subscription:${identityId}`]);
      const prior=await client.query<SubRow>('SELECT * FROM subscription_intents WHERE identity_id=$1 AND idempotency_key=$2 FOR UPDATE',[identityId,key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash!==requestHash) throw new AppError('IDEMPOTENCY_CONFLICT','Subscription key was used for different inputs.',409);
        const count=await client.query<{ordinal:number}>('SELECT COALESCE(max(ordinal),0) AS ordinal FROM subscription_chain_attempts WHERE subscription_intent_id=$1',[prior.rows[0].id]);
        return sub({...prior.rows[0],ordinal:count.rows[0]?.ordinal ?? 0});
      }
      const existing=await client.query('SELECT 1 FROM subscription_intents WHERE identity_id=$1 AND round_id=$2',[identityId,roundId]);
      if (existing.rowCount) throw new AppError('ALREADY_SUBSCRIBED','Recover the existing participation intent; changing wallets does not create another allocation.',409);
      const result=await client.query<SubRow>(`INSERT INTO subscription_intents(id,identity_id,round_id,wallet_address,gross_amount_micro_usd,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[randomUUID(),identityId,roundId,wallet,gross,key,requestHash]);
      return sub(result.rows[0]!);
    });
  }
  async bind(value:SubscriptionIntent,chainIntentId:string,preview:unknown):Promise<SubscriptionIntent> {
    return this.transactions.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`subscription:${value.identityId}`]);
      const row=await client.query<SubRow>('SELECT * FROM subscription_intents WHERE id=$1 FOR UPDATE',[value.id]);
      const current=row.rows[0];if (!current) throw new AppError('NOT_FOUND','Subscription intent not found.',404);
      const exists=await client.query<{ordinal:number}>('SELECT ordinal FROM subscription_chain_attempts WHERE chain_intent_id=$1',[chainIntentId]);
      if (exists.rows[0]) return sub({...current,ordinal:exists.rows[0].ordinal});
      if (current.chain_intent_id!==value.chainIntentId) throw new AppError('ALREADY_SUBSCRIBED','Another preparation completed; recover the original request.',409);
      await client.query('INSERT INTO subscription_chain_attempts(subscription_intent_id,ordinal,chain_intent_id) VALUES($1,$2,$3)',[value.id,value.ordinal+1,chainIntentId]);
      const t=await client.query<{transaction_base64:string}>('SELECT transaction_base64 FROM tokenization_intents WHERE id=$1',[chainIntentId]);
      const blockhash=VersionedTransaction.deserialize(Buffer.from(t.rows[0]!.transaction_base64,'base64')).message.recentBlockhash;
      const result=await client.query<SubRow>(`UPDATE subscription_intents s SET chain_intent_id=$2,preview=$3,prepared_message=decode(t.message_base64,'base64'),
 message_hash=encode(sha256(decode(t.message_base64,'base64')),'hex'),signature=t.signature,blockhash=$4,last_valid_block_height=t.last_valid_block_height
 FROM tokenization_intents t WHERE s.id=$1 AND t.id=$2 RETURNING s.*`,[value.id,chainIntentId,preview,blockhash]);
      return sub({...result.rows[0]!,ordinal:value.ordinal+1});
    });
  }
  async owned(identityId:string,id:string):Promise<SubscriptionIntent|null> {
    const result=await this.pool.query<SubRow>(`SELECT s.*,COALESCE((SELECT max(ordinal) FROM subscription_chain_attempts a WHERE a.subscription_intent_id=s.id),0) AS ordinal
      FROM subscription_intents s WHERE s.identity_id=$1 AND s.id=$2`,[identityId,id]);return result.rows[0] ? sub(result.rows[0]) : null;
  }
  async chainSignatureOwned(identityId:string,logicalId:string,signature:string):Promise<boolean> {
    const result=await this.pool.query(`SELECT 1 FROM subscription_intents s JOIN subscription_chain_attempts a ON a.subscription_intent_id=s.id
      JOIN tokenization_intents t ON t.id=a.chain_intent_id WHERE s.identity_id=$1 AND s.id=$2 AND t.signature=$3`,[identityId,logicalId,signature]);return result.rowCount===1;
  }
  async list(identityId?:string):Promise<SubscriptionIntent[]> {
    const result=await this.pool.query<SubRow>(`SELECT s.*,COALESCE((SELECT max(ordinal) FROM subscription_chain_attempts a WHERE a.subscription_intent_id=s.id),0) AS ordinal
      FROM subscription_intents s WHERE ($1::uuid IS NULL OR s.identity_id=$1) ORDER BY s.last_checked_at LIMIT 1000`,[identityId ?? null]);return result.rows.map(sub);
  }
  async mirror(value:SubscriptionIntent,round:RoundInfo,state:SubscriptionState,signature:string):Promise<void> {
    if (state.gross!==value.gross) throw new AppError('CHAIN_STATE_INVALID','Subscription gross amount does not match its identity reservation.',503);
    const cancelled=round.status==='refunding';
    const settled=allocation({grossAmountMicroUsd:state.gross,totalCommittedMicroUsd:round.totalCommitted,unitPriceMicroUsd:round.price,maxUnits:round.maxUnits,cancelled});
    if (state.minted && (cancelled || state.accepted!==settled.acceptedMicroUsd || state.units!==settled.units)) throw new AppError('CHAIN_STATE_INVALID','Allocation differs from the frozen round formula.',503);
    if (state.refunded && state.refundedAmount!==settled.refundMicroUsd) throw new AppError('CHAIN_STATE_INVALID','Refund differs from the finalized round formula.',503);
    if ((state.minted || state.refunded) && !['finalized','expired','refunding'].includes(round.status)) throw new AppError('CHAIN_STATE_INVALID','Settlement is recorded on an open round.',503);
    await this.pool.query(`INSERT INTO subscriptions(id,round_id,identity_id,wallet_address,requested_amount_micro_usd,accepted_amount_micro_usd,protocol_fee_micro_usd,founder_reward_micro_usd,
      allocated_units,refunded_amount_micro_usd,minted,refunded,round_status,solana_signature,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'FINALIZED')
      ON CONFLICT(id) DO UPDATE SET accepted_amount_micro_usd=EXCLUDED.accepted_amount_micro_usd,protocol_fee_micro_usd=EXCLUDED.protocol_fee_micro_usd,founder_reward_micro_usd=EXCLUDED.founder_reward_micro_usd,
      allocated_units=EXCLUDED.allocated_units,refunded_amount_micro_usd=EXCLUDED.refunded_amount_micro_usd,minted=EXCLUDED.minted,refunded=EXCLUDED.refunded,
      round_status=EXCLUDED.round_status,status='FINALIZED',updated_at=now()`,[value.id,value.roundId,value.identityId,value.wallet,state.gross,
      state.minted ? state.accepted : '0',state.minted ? settled.feeMicroUsd : '0',state.minted ? settled.founderRewardMicroUsd : '0',
      state.minted ? state.units : '0',state.refunded ? state.refundedAmount : '0',state.minted,state.refunded,round.status,signature]);
  }
  async rows(identityId:string,roundId?:string) {
    const result=await this.pool.query<{id:string;round_id:string;project_id:string;wallet:string;gross_amount:string;accepted_amount:string;
      fee_amount:string;founder_reward:string;allocated_units:string;refunded_amount:string;minted:boolean;refunded:boolean;round_status:string;signature:string}>(
      `SELECT s.*,s.allocated_units::text AS allocated_units,s.wallet_address AS wallet,s.requested_amount_micro_usd::text AS gross_amount,s.accepted_amount_micro_usd::text AS accepted_amount,s.protocol_fee_micro_usd::text AS fee_amount,s.founder_reward_micro_usd::text AS founder_reward,s.refunded_amount_micro_usd::text AS refunded_amount,s.solana_signature AS signature,r.project_id FROM subscriptions s JOIN rounds r ON r.id=s.round_id WHERE s.identity_id=$1 AND ($2::uuid IS NULL OR s.round_id=$2)`,[identityId,roundId ?? null]);
    return result.rows;
  }
  async checked(id:string) {await this.pool.query('UPDATE subscription_intents SET last_checked_at=now() WHERE id=$1',[id]);}
  async settlementAttempt(roundPda:string,wallet:string):Promise<{ordinal:number;key:string|null}> {
    const result=await this.pool.query<{status:string;idempotency_key:string}>("SELECT status,request_key AS idempotency_key FROM tokenization_intents WHERE round_pda=$1 AND buyer_wallet=$2 AND kind='Settle' ORDER BY created_at",[roundPda,wallet]);
    const active=result.rows.find(row=>!['Failed','Expired'].includes(row.status));return {ordinal:result.rows.length+1,key:active?.idempotency_key ?? null};
  }
}
