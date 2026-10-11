import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { AppError } from '../http/errors.js';
import type { Intent, Project, Receipt, Status, Store } from '../tokenization/types.js';

interface IntentRow extends QueryResultRow {
  kind: 'Tokenize' | 'Settle' | 'Subscribe' | 'Open'; round_pda: string | null; buyer_wallet: string | null;
  gross_amount_micro_usd: string | null;
  id: string; project_id: string; identity_id: string; request_key: string; request_hash: string;
  transaction_base64: string; message_base64: string; signature: string; last_valid_block_height: string;
  project_pda: string; receipt_mint: string; status: Status;
}
function intent(row: IntentRow): Intent {
  return {
    kind: row.kind, roundPda: row.round_pda, buyerWallet: row.buyer_wallet,
    ...(row.gross_amount_micro_usd ? {grossAmountMicroUsd:String(row.gross_amount_micro_usd)} : {}),
    id: row.id, projectId: row.project_id, identityId: row.identity_id,
    requestKey: row.request_key, requestHash: row.request_hash,
    transaction: row.transaction_base64, message: row.message_base64,
    signature: row.signature, lastValidBlockHeight: Number(row.last_valid_block_height),
    projectPda: row.project_pda, receiptMint: row.receipt_mint, status: row.status,
  };
}

export class PgStore implements Store {
  constructor(readonly pool: Pool) {}
  private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async session(_token: string): Promise<string | null> { throw new Error('Use Better Auth identity resolution.'); }
  async project(id: string): Promise<Project | null> {
    const result = await this.pool.query<{ id: string; founder_identity_id: string; founder_wallet: string }>(
      `SELECT p.id,p.founder_identity_id,COALESCE(p.founder_wallet,(SELECT address FROM wallets w WHERE w.identity_id=p.founder_identity_id AND revoked_at IS NULL ORDER BY is_primary DESC,created_at LIMIT 1)) AS founder_wallet FROM projects p WHERE p.id=$1`, [id]);
    const row = result.rows[0];
    return row ? { id: row.id, founderIdentityId: row.founder_identity_id, founderWallet: row.founder_wallet } : null;
  }
  async verifiedWallet(identityId: string, wallet: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM wallets WHERE identity_id = $1 AND address = $2 AND revoked_at IS NULL AND chain = $3',
      [identityId, wallet, 'solana']);
    return result.rowCount === 1;
  }
  async findByKey(identityId: string, key: string): Promise<Intent | null> {
    const result = await this.pool.query<IntentRow>('SELECT * FROM tokenization_intents WHERE identity_id = $1 AND request_key = $2', [identityId, key]);
    return result.rows[0] ? intent(result.rows[0]) : null;
  }

  async reserve(value: Intent): Promise<Intent> {
    return this.tx(async client => {
      // Serialize both the per-identity key and per-project reservation, across API instances.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`identity:${value.identityId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`project:${value.projectId}`]);
      const duplicate = await client.query<IntentRow>('SELECT * FROM tokenization_intents WHERE identity_id = $1 AND request_key = $2', [value.identityId, value.requestKey]);
      const existing = duplicate.rows[0];
      if (existing) {
        if (existing.request_hash !== value.requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This request key was used for different inputs.', 409);
        return intent(existing);
      }
      if (value.kind === 'Tokenize') {
        const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND receipt_mint IS NOT NULL', [value.projectId]);
        if (project.rowCount) throw new AppError('ALREADY_TOKENIZED', 'Project tokenization is finalized.', 409);
      }
      const active = value.kind === 'Tokenize'
        ? await client.query("SELECT 1 FROM tokenization_intents WHERE project_id = $1 AND kind = 'Tokenize' AND status NOT IN ('Failed', 'Expired')", [value.projectId])
        : await client.query("SELECT 1 FROM tokenization_intents WHERE round_pda = $1 AND buyer_wallet = $2 AND kind = $3 AND status NOT IN ('Failed', 'Expired')", [value.roundPda, value.buyerWallet,value.kind]);
      if (active.rowCount) throw new AppError('TOKENIZATION_IN_PROGRESS', 'Recover the existing project tokenization before preparing another.', 409);
      await client.query(`INSERT INTO tokenization_intents
        (id, project_id, identity_id, request_key, request_hash, transaction_base64, message_base64,
         signature, last_valid_block_height, project_pda, receipt_mint, status, kind, round_pda, buyer_wallet,gross_amount_micro_usd)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [value.id, value.projectId, value.identityId, value.requestKey, value.requestHash,
        value.transaction, value.message, value.signature, value.lastValidBlockHeight, value.projectPda, value.receiptMint, value.status,
        value.kind, value.roundPda, value.buyerWallet,value.grossAmountMicroUsd ?? null]);
      await client.query('INSERT INTO tokenization_observations(intent_id, status) VALUES ($1,$2)', [value.id, value.status]);
      return value;
    });
  }
  async findBySignature(identityId: string, signature: string): Promise<Intent | null> {
    const result = await this.pool.query<IntentRow>('SELECT * FROM tokenization_intents WHERE identity_id = $1 AND signature = $2', [identityId, signature]);
    return result.rows[0] ? intent(result.rows[0]) : null;
  }
  async markSubmitted(id: string, signedTx?: string): Promise<void> {
    await this.tx(async client => {
      if (signedTx) await client.query('UPDATE tokenization_intents SET signed_transaction_base64=$2 WHERE id=$1 AND (signed_transaction_base64 IS NULL OR signed_transaction_base64=$2)', [id,signedTx]);
      const result = await client.query("UPDATE tokenization_intents SET status = 'Submitted', updated_at = now() WHERE id = $1 AND status = 'Prepared' RETURNING id", [id]);
      if (result.rowCount) await client.query("INSERT INTO tokenization_observations(intent_id, status) VALUES ($1,'Submitted')", [id]);
      const row = await client.query<{ status: Status }>('SELECT status FROM tokenization_intents WHERE id = $1 FOR UPDATE', [id]);
      if (!row.rows[0] || ['Failed', 'Expired'].includes(row.rows[0].status)) throw new AppError('TRANSACTION_EXPIRED', 'Prepare a new transaction with a new request key.', 409);
    });
  }
  async signedTransaction(id:string):Promise<string|null> {
    const result=await this.pool.query<{signed_transaction_base64:string|null}>('SELECT signed_transaction_base64 FROM tokenization_intents WHERE id=$1',[id]);
    return result.rows[0]?.signed_transaction_base64 ?? null;
  }
  async observe(value: Intent, status: Status, receipt: Receipt | null): Promise<void> {
    await this.tx(async client => {
      const result = await client.query<IntentRow>('SELECT * FROM tokenization_intents WHERE id = $1 FOR UPDATE', [value.id]);
      const row = result.rows[0];
      if (row) await client.query('UPDATE tokenization_intents SET last_checked_at = now() WHERE id = $1', [value.id]);
      if (!row || row.status !== value.status || row.status === status || ['Failed', 'Expired', 'Finalized'].includes(row.status)) return;
      if (row.status === 'Confirmed' && ['Prepared', 'Submitted', 'Unknown'].includes(status)) return;
      if (status === 'Finalized') {
        if (!receipt || receipt.receiptMint !== row.receipt_mint || receipt.projectPda !== row.project_pda) {
          throw new AppError('CHAIN_STATE_INVALID', 'Finalized receipt does not match the prepared project.', 503);
        }
        await client.query('UPDATE projects SET solana_project_pda = $1, receipt_mint = $2 WHERE id = $3',
          [receipt.projectPda, receipt.receiptMint, row.project_id]);
      }
      await client.query('UPDATE tokenization_intents SET status = $1, updated_at = now() WHERE id = $2', [status, value.id]);
      await client.query('INSERT INTO tokenization_observations(intent_id, status) VALUES ($1,$2)', [value.id, status]);
    });
  }
  async pending(): Promise<Intent[]> {
    const result = await this.pool.query<IntentRow>("SELECT * FROM tokenization_intents WHERE status IN ('Prepared','Submitted','Unknown','Confirmed') ORDER BY last_checked_at LIMIT 100");
    return result.rows.map(intent);
  }
  async submissionKey(identityId: string, key: string, hash: string): Promise<void> {
    const result = await this.pool.query<{ request_hash: string }>(`INSERT INTO transaction_submission_keys(identity_id, request_key, request_hash)
      VALUES ($1,$2,$3) ON CONFLICT (identity_id, request_key) DO UPDATE
      SET request_key = EXCLUDED.request_key RETURNING request_hash`, [identityId, key, hash]);
    if (result.rows[0]?.request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This submission key was used for another transaction.', 409);
  }
  async rateLimit(identityId: string, limit: number): Promise<boolean> {
    const result = await this.pool.query<{ hits: number }>(`INSERT INTO rate_limits(bucket, window_start)
      VALUES ($1,date_trunc('minute',now())) ON CONFLICT (bucket, window_start)
      DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`, [identityId]);
    return (result.rows[0]?.hits ?? limit + 1) <= limit;
  }
}
