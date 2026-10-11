import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppError } from '../http/errors.js';
import { profileSchema, type BankAccount, type BankTransfer, type NessieProfile } from './adapter.js';
import { hash } from './canonical.js';
import type { AccountMapping, Funding, FundingStatus, FundingTx } from './types.js';

interface FundingRow extends QueryResultRow {
  id: string; generation: string; identity_id: string; wallet_address: string; amount_micro_usd: string;
  source_banking_account_id: string; treasury_banking_account_id: string; idempotency_key: string; request_hash: string; status: FundingStatus;
  correlation_tag: string; provider_profile: string; bank_proof_hash: string | null;
  provider_transfer_id: string | null; last_error: string | null; lease_owner: string | null; fencing_counter: number; poll_count: number;
}
const funding = (row: FundingRow): Funding => ({
  id: row.id, generation: row.generation, identityId: row.identity_id, wallet: row.wallet_address, amount: String(row.amount_micro_usd),
  sourceId: row.source_banking_account_id, treasuryId: row.treasury_banking_account_id, key: row.idempotency_key, requestHash: row.request_hash,
  status: row.status, tag: row.correlation_tag, profile: profileSchema.parse(JSON.parse(row.provider_profile)), proofHash: row.bank_proof_hash,
  providerTransferId: row.provider_transfer_id, lastError: row.last_error, leaseOwner: row.lease_owner, fence: Number(row.fencing_counter), pollCount: row.poll_count,
});
interface AccountRow extends QueryResultRow {
  id: string; generation: string; identity_id: string | null; role: 'PARTICIPANT' | 'TREASURY'; provider_account_id: string;
  provider_customer_id: string; nickname: string; active: boolean; last_observed_balance_usd: string | null; last_observed_at: Date | null;
}
const account = (row: AccountRow): AccountMapping => ({
  id: row.id, generation: row.generation, identityId: row.identity_id, role: row.role,
  providerAccountId: row.provider_account_id, providerCustomerId: row.provider_customer_id,
  nickname: row.nickname, active: row.active, balanceDollars: row.last_observed_balance_usd, observedAt: row.last_observed_at,
});
const transitions: Record<FundingStatus, FundingStatus[]> = {
  CREATED: ['BANK_DISPATCHED','BANK_REJECTED','NEEDS_REVIEW'],
  BANK_DISPATCHED: ['BANK_PENDING','BANK_CONFIRMED','BANK_UNKNOWN','BANK_REJECTED','NEEDS_REVIEW'],
  BANK_PENDING: ['BANK_CONFIRMED','BANK_REJECTED','BANK_UNKNOWN','NEEDS_REVIEW'],
  BANK_UNKNOWN: ['BANK_PENDING','BANK_CONFIRMED','BANK_REJECTED','NEEDS_REVIEW'],
  BANK_CONFIRMED: ['MINT_PREPARED','COMPLETED','NEEDS_REVIEW'],
  MINT_PREPARED: ['MINT_SUBMITTED','COMPLETED','NEEDS_REVIEW'],
  MINT_SUBMITTED: ['MINT_CONFIRMED','MINT_PREPARED','COMPLETED','NEEDS_REVIEW'],
  MINT_CONFIRMED: ['MINT_SUBMITTED','MINT_PREPARED','COMPLETED','NEEDS_REVIEW'],
  COMPLETED: [], BANK_REJECTED: [], NEEDS_REVIEW: [],
  COMPENSATION_PREPARED: [], COMPENSATION_PENDING: [], COMPENSATION_UNKNOWN: [], COMPENSATED: [],
};
export class LeaseLost extends Error {}

export class FundingStore {
  constructor(readonly pool: Pool) {}
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async owned(identityId: string, id: string): Promise<Funding | null> {
    const result = await this.pool.query<FundingRow>('SELECT * FROM funding_intents WHERE identity_id=$1 AND id=$2', [identityId,id]);
    return result.rows[0] ? funding(result.rows[0]) : null;
  }
  async byKey(identityId: string, key: string): Promise<Funding | null> {
    const result = await this.pool.query<FundingRow>('SELECT * FROM funding_intents WHERE identity_id=$1 AND idempotency_key=$2', [identityId,key]);
    return result.rows[0] ? funding(result.rows[0]) : null;
  }
  async mapping(identityId: string, generation: string): Promise<AccountMapping | null> {
    const result = await this.pool.query<AccountRow>("SELECT * FROM banking_accounts WHERE identity_id=$1 AND generation=$2 AND role='PARTICIPANT'", [identityId,generation]);
    return result.rows[0] ? account(result.rows[0]) : null;
  }
  async accounts(value: Funding): Promise<{ source: AccountMapping; treasury: AccountMapping }> {
    const result = await this.pool.query<AccountRow>('SELECT * FROM banking_accounts WHERE id IN ($1,$2)', [value.sourceId,value.treasuryId]);
    const source = result.rows.find(row => row.id === value.sourceId); const treasury = result.rows.find(row => row.id === value.treasuryId);
    if (!source || !treasury || source.generation !== value.generation || treasury.generation !== value.generation
      || source.identity_id !== value.identityId || source.role !== 'PARTICIPANT' || treasury.role !== 'TREASURY') {
      throw new AppError('BANK_ACCOUNT_NOT_READY', 'Bank mappings require review.', 409);
    }
    return { source: account(source), treasury: account(treasury) };
  }
  async create(identityId: string, wallet: string, amount: string, key: string, options: {
    generation: string; enabled: boolean; paused: boolean; treasuryProviderId: string; profile: NessieProfile | null;
  }): Promise<Funding> {
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`funding:${identityId}`]);
      const prior = await client.query<FundingRow>('SELECT * FROM funding_intents WHERE identity_id=$1 AND idempotency_key=$2', [identityId,key]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.wallet_address !== wallet || String(row.amount_micro_usd) !== amount || row.generation !== options.generation) throw new AppError('IDEMPOTENCY_CONFLICT','This funding key was used for different inputs.',409);
        return funding(row);
      }
      if (!options.enabled || !options.profile) throw new AppError('BANK_UNAVAILABLE','Bank transfers are unavailable right now.',503);
      const control = await client.query<{ paused: boolean }>('SELECT paused FROM funding_controls FOR UPDATE');
      if (options.paused || control.rows.some(row=>row.paused)) throw new AppError('BANK_UNAVAILABLE','New wallet funding is paused.',503);
      const walletResult = await client.query(`SELECT 1 FROM wallets w JOIN identities i ON i.id=w.identity_id
        WHERE w.identity_id=$1 AND w.address=$2 AND w.revoked_at IS NULL AND w.chain='solana' AND i.verified_at IS NOT NULL AND i.status='ACTIVE' AND i.risk_flags='[]'::jsonb`, [identityId,wallet]);
      if (!walletResult.rowCount) throw new AppError('WALLET_NOT_VERIFIED','Funding requires an eligible verified wallet.',409);
      const mappings = await client.query<AccountRow>('SELECT * FROM banking_accounts WHERE generation=$1 AND (identity_id=$2 OR role=$3) FOR UPDATE', [options.generation,identityId,'TREASURY']);
      const source = mappings.rows.find(row => row.role === 'PARTICIPANT'); const treasury = mappings.rows.find(row => row.role === 'TREASURY');
      if (!source?.active || !treasury?.active || treasury.provider_account_id !== options.treasuryProviderId || source.provider_account_id === treasury.provider_account_id) {
        throw new AppError('BANK_ACCOUNT_NOT_READY','Your bank account is not open yet.',409);
      }
      const pending = await client.query("SELECT 1 FROM funding_intents WHERE source_banking_account_id=$1 AND status NOT IN ('BANK_REJECTED','COMPENSATED','COMPLETED')", [source.id]);
      if (pending.rowCount) throw new AppError('FUNDING_IN_PROGRESS','Recover the existing funding intent first.',409);
      // Lifetime limits span wallets and generations; only proven no-effect outcomes release usage.
      const quota = await client.query<{ used: string; hourly: boolean }>(`SELECT COALESCE(sum(amount_micro_usd),0)::text AS used,
        COALESCE(bool_or(created_at > now()-interval '1 hour'),false) AS hourly FROM funding_intents
        WHERE identity_id=$1 AND status NOT IN ('BANK_REJECTED','COMPENSATED')`, [identityId]);
      if (quota.rows[0]?.hourly || BigInt(quota.rows[0]?.used ?? '0') + BigInt(amount) > 1_000_000_000n) throw new AppError('FUNDING_LIMIT','One funding per hour and $1,000 lifetime mock funding per identity are allowed.',409);
      const id = randomUUID(); const tag = `prospecto:funding:${id}`;
      const fingerprint = hash({ operation:'funding', mode:'NESSIE', generation:options.generation, walletAddress:wallet,
        amountMicroUsd:amount, sourceId:source.id, treasuryId:treasury.id, profileId:options.profile.id });
      const result = await client.query<FundingRow>(`INSERT INTO funding_intents
        (id,generation,identity_id,wallet_address,amount_micro_usd,source_banking_account_id,treasury_banking_account_id,idempotency_key,request_hash,status,correlation_tag,provider_profile,mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CREATED',$10,$11,'NESSIE') RETURNING *`,
        [id,options.generation,identityId,wallet,amount,source.id,treasury.id,key,fingerprint,tag,JSON.stringify(options.profile)]);
      await client.query("INSERT INTO funding_transitions(funding_intent_id,to_status,actor,reason) VALUES($1,'CREATED',$2,'REQUEST_ACCEPTED')", [id,identityId]);
      return funding(result.rows[0]!);
    });
  }
  async claim(owner: string, identityId?:string, allowDispatch=true): Promise<Funding | null> {
    return this.tx(async client => {
      const result = await client.query<FundingRow>(`SELECT * FROM funding_intents WHERE status NOT IN
        ('COMPLETED','BANK_REJECTED','NEEDS_REVIEW','COMPENSATED','COMPENSATION_PREPARED','COMPENSATION_PENDING','COMPENSATION_UNKNOWN')
        AND ($1::uuid IS NULL OR identity_id=$1) AND ($2 OR status<>'CREATED') AND mode='NESSIE'
        AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`,[identityId ?? null,allowDispatch]);
      const row = result.rows[0]; if (!row) return null;
      const claimed = await client.query<FundingRow>("UPDATE funding_intents SET lease_owner=$2,lease_expires_at=now()+interval '60 seconds',fencing_counter=fencing_counter+1 WHERE id=$1 RETURNING *", [row.id,owner]);
      return funding(claimed.rows[0]!);
    });
  }
  private async locked(client: PoolClient, lease: Funding) {
    const result = await client.query<FundingRow>('SELECT * FROM funding_intents WHERE id=$1 AND lease_owner=$2 AND fencing_counter=$3 AND lease_expires_at>now() FOR UPDATE', [lease.id,lease.leaseOwner,lease.fence]);
    const row = result.rows[0]; if (!row || row.status !== lease.status) throw new LeaseLost();
    return row;
  }
  async claimCompleted(owner:string):Promise<Funding|null> {
    return this.tx(async client=>{
      const result=await client.query<FundingRow>(`SELECT * FROM funding_intents f WHERE status='COMPLETED'
        AND audited_at<now()-interval '5 minutes' AND (lease_expires_at IS NULL OR lease_expires_at<now())
        AND NOT EXISTS(SELECT 1 FROM funding_incidents i WHERE i.funding_intent_id=f.id)
        ORDER BY audited_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!result.rows[0]) return null;
      const claimed=await client.query<FundingRow>(`UPDATE funding_intents SET lease_owner=$2,
        lease_expires_at=now()+interval '60 seconds',fencing_counter=fencing_counter+1,audited_at=now() WHERE id=$1 RETURNING *`,[result.rows[0].id,owner]);
      return funding(claimed.rows[0]!);
    });
  }
  async recordObservation(lease:Funding,transfer:BankTransfer):Promise<void> {
    await this.tx(async client=>{
      await this.locked(client,lease);
      await client.query('INSERT INTO banking_observations(funding_intent_id,observation_hash,sanitized_response) VALUES($1,$2,$3)',
        [lease.id,hash(transfer),transfer]);
    });
  }
  private async advanceIn(client: PoolClient, lease: Funding, next: FundingStatus, reason: string, evidenceHash: string | null = null) {
    await this.locked(client,lease);
    if (next !== lease.status && !transitions[lease.status].includes(next)) throw new Error('Invalid funding transition.');
    await client.query('UPDATE funding_intents SET poll_count=CASE WHEN status<>$2 THEN 0 ELSE poll_count END,status=$2,last_error=$3,updated_at=now() WHERE id=$1', [lease.id,next,/UNKNOWN|MISMATCH|REJECTED|REVIEW|INSUFFICIENT|NOT_VERIFIED|FROZEN/.test(reason) ? reason : null]);
    if (next !== lease.status) await client.query('INSERT INTO funding_transitions(funding_intent_id,from_status,to_status,actor,reason,evidence_hash) VALUES($1,$2,$3,$4,$5,$6)', [lease.id,lease.status,next,lease.leaseOwner,reason,evidenceHash]);
  }
  async advance(lease: Funding, next: FundingStatus, reason: string): Promise<void> {
    await this.tx(client => this.advanceIn(client,lease,next,reason)); if (lease.status!==next) lease.pollCount=0;lease.status = next;
  }
  async dispatch(lease: Funding, requestHash: string): Promise<void> {
    await this.tx(async client => {
      await this.locked(client,lease);
      await client.query("INSERT INTO banking_attempts(funding_intent_id,request_hash,dispatch_state,attempt_ordinal,purpose,correlation_tag,sent_at) VALUES($1,$2,'DISPATCHED',1,'FUNDING',$3,now())", [lease.id,requestHash,lease.tag]);
      await this.advanceIn(client,lease,'BANK_DISPATCHED','BANK_WRITE_RESERVED',requestHash);
    }); lease.status = 'BANK_DISPATCHED';lease.pollCount=0;
  }
  async bindTransferId(lease: Funding, id: string): Promise<void> {
    try {await this.tx(async client => {
      const row = await this.locked(client,lease);
      if (row.provider_transfer_id && row.provider_transfer_id !== id) throw new AppError('BANK_PROOF_MISMATCH','Bank transfer mismatch.',503);
      await client.query('UPDATE funding_intents SET provider_transfer_id=$2 WHERE id=$1', [lease.id,id]);
      await client.query('UPDATE banking_attempts SET provider_transfer_id=$2 WHERE funding_intent_id=$1', [lease.id,id]);
    });} catch(error) {
      if (typeof error==='object' && error!==null && 'code' in error && error.code==='23505') throw new AppError('BANK_PROOF_MISMATCH','Provider transfer is already bound to another intent.',503);
      throw error;
    } lease.providerTransferId = id;
  }
  async observeTransfer(lease: Funding, transfer: BankTransfer, proofHash: string | null): Promise<void> {
    const next: FundingStatus = transfer.state === 'success' ? 'BANK_CONFIRMED' : transfer.state === 'rejected' ? 'BANK_REJECTED' : 'BANK_PENDING';
    await this.tx(async client => {
      await this.locked(client,lease);
      await client.query(`UPDATE banking_attempts SET dispatch_state='RESPONDED',provider_transfer_id=$2,provider_status=$3,
        sanitized_response=$4,observed_at=now() WHERE funding_intent_id=$1`, [lease.id,transfer.id,transfer.providerStatus,transfer]);
      await client.query('UPDATE funding_intents SET provider_transfer_id=$2,bank_proof_hash=COALESCE(bank_proof_hash,$3) WHERE id=$1', [lease.id,transfer.id,proofHash]);
      await this.advanceIn(client,lease,next,next,hash(transfer));
    }); if (lease.status!==next) lease.pollCount=0;lease.status = next; lease.providerTransferId = transfer.id; if (proofHash) lease.proofHash = proofHash;
  }
  async review(lease: Funding, reason: string): Promise<void> {
    await this.tx(async client => {
      if (lease.status==='COMPLETED') {
        // Keep the proved mint history, even when another funding on this source is already active.
        await this.locked(client,lease);
        await client.query('UPDATE funding_intents SET last_error=$2,updated_at=now() WHERE id=$1',[lease.id,reason]);
      } else await this.advanceIn(client,lease,'NEEDS_REVIEW',reason);
      await client.query('UPDATE banking_accounts SET active=false WHERE id=$1', [lease.sourceId]);
      await client.query('INSERT INTO funding_incidents(funding_intent_id,reason) VALUES($1,$2) ON CONFLICT DO NOTHING', [lease.id,reason]);
      await client.query('INSERT INTO funding_controls(generation,paused,reason) VALUES($1,true,$2) ON CONFLICT(generation) DO UPDATE SET paused=true,reason=EXCLUDED.reason', [lease.generation,reason]);
    }); if(lease.status!=='COMPLETED') lease.status = 'NEEDS_REVIEW';
  }
  async observedAccount(mapping: AccountMapping, observed: BankAccount): Promise<void> {
    if (mapping.providerAccountId !== observed.id || mapping.providerCustomerId !== observed.customerId) throw new AppError('BANK_PROOF_MISMATCH','Bank account ownership mismatch.',503);
    await this.pool.query('UPDATE banking_accounts SET last_observed_balance_usd=$2,last_observed_at=now() WHERE id=$1', [mapping.id,observed.dollars]);
  }
  async otherReservations(lease: Funding): Promise<bigint> {
    const result = await this.pool.query<{ total: string }>("SELECT COALESCE(sum(amount_micro_usd),0)::text AS total FROM funding_intents WHERE source_banking_account_id=$1 AND id<>$2 AND status NOT IN ('BANK_REJECTED','COMPENSATED','COMPLETED')", [lease.sourceId,lease.id]);
    return BigInt(result.rows[0]?.total ?? '0');
  }
  async latestTx(id: string): Promise<FundingTx | null> {
    const result = await this.pool.query<{ signed_tx: Buffer; message_hash: string; signature: string; blockhash: string; last_valid_block_height: string; status: FundingTx['status'] }>('SELECT * FROM funding_chain_attempts WHERE funding_intent_id=$1 ORDER BY attempt_ordinal DESC LIMIT 1', [id]);
    const row = result.rows[0]; return row ? { transaction:Buffer.from(row.signed_tx).toString('base64'),messageHash:row.message_hash,signature:row.signature,blockhash:row.blockhash,lastValidBlockHeight:Number(row.last_valid_block_height),status:row.status[0]!+row.status.slice(1).toLowerCase() as FundingTx['status'] } : null;
  }
  async saveTx(lease: Funding, tx: FundingTx): Promise<void> {
    await this.tx(async client => {
      await this.locked(client,lease);
      await client.query(`INSERT INTO funding_chain_attempts(funding_intent_id,attempt_ordinal,message_hash,signed_tx,signature,blockhash,last_valid_block_height,status)
        SELECT $1,COALESCE(max(attempt_ordinal),0)+1,$2,$3,$4,$5,$6,$7 FROM funding_chain_attempts WHERE funding_intent_id=$1`, [lease.id,tx.messageHash,Buffer.from(tx.transaction,'base64'),tx.signature,tx.blockhash,tx.lastValidBlockHeight,tx.status.toUpperCase()]);
      await this.advanceIn(client,lease,'MINT_PREPARED','GUARDED_MINT_PREPARED',tx.messageHash);
    }); lease.status = 'MINT_PREPARED';lease.pollCount=0;
  }
  async txStatus(lease: Funding, tx: FundingTx, status: FundingTx['status']): Promise<void> {
    await this.tx(async client => { await this.locked(client,lease); await client.query('UPDATE funding_chain_attempts SET status=$2 WHERE signature=$1', [tx.signature,status.toUpperCase()]); });
  }
  async release(lease: Funding): Promise<void> {
    const delay = [2,5,10,30,60][Math.min(lease.pollCount,4)] ?? 60;
    await this.pool.query("UPDATE funding_intents SET lease_expires_at=NULL,lease_owner=NULL,poll_count=poll_count+1,next_attempt_at=now()+($4 * interval '1 second') WHERE id=$1 AND lease_owner=$2 AND fencing_counter=$3", [lease.id,lease.leaseOwner,lease.fence,delay]);
  }
  async active(identityId: string, generation: string): Promise<Funding | null> {
    const result = await this.pool.query<FundingRow>("SELECT * FROM funding_intents WHERE identity_id=$1 AND generation=$2 AND status NOT IN ('COMPLETED','BANK_REJECTED','COMPENSATED') ORDER BY created_at DESC LIMIT 1", [identityId,generation]);
    return result.rows[0] ? funding(result.rows[0]) : null;
  }
  async activity(identityId: string): Promise<Array<{ id: string; amount: string; status: FundingStatus; createdAt: Date }>> {
    const result = await this.pool.query<FundingRow & { created_at: Date }>('SELECT * FROM funding_intents WHERE identity_id=$1 ORDER BY created_at DESC LIMIT 50', [identityId]);
    return result.rows.map(row => ({ id:row.id,amount:row.amount_micro_usd,status:row.status,createdAt:row.created_at }));
  }
  async paused(generation:string):Promise<boolean> {
    const result=await this.pool.query<{paused:boolean}>('SELECT COALESCE(bool_or(paused),false) AS paused FROM funding_controls');return result.rows[0]?.paused ?? false;
  }
}
