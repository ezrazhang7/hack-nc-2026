import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Bank, BankProvisioner } from './adapter.js';
import { AppError } from '../http/errors.js';

export const STARTING_BALANCE_DOLLARS = 1000;
const NICKNAME = 'Everyday Checking';

/**
 * Self-service replacement for the operator fixture manifest (registerBankFixtures): the first
 * eligible request for an identity creates one Nessie customer and Checking account with the
 * $1,000 seed balance and maps it (NESSIE_PURCHASE_FLOW §3 seed rules).
 *
 * Bank POSTs have no idempotency guarantee, so nothing is blindly retried: the customer carries a
 * deterministic, non-identifying tag and every attempt first looks it up. A crash or an uncertain
 * write is reconciled by the next attempt finding what was already created. A per-identity
 * advisory lock serializes attempts; more than one tagged customer or account goes to review.
 */
export async function provisionBankAccount(pool: Pool, bank: Bank & BankProvisioner,
  options: { generation: string; treasuryProviderId: string }, identityId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bank-provision:${options.generation}:${identityId}`]);
    const mapped = await client.query("SELECT 1 FROM banking_accounts WHERE generation=$1 AND identity_id=$2 AND role='PARTICIPANT'", [options.generation, identityId]);
    if (mapped.rowCount) { await client.query('COMMIT'); return; }
    const eligible = await client.query(`SELECT 1 FROM identities WHERE id=$1 AND verified_at IS NOT NULL AND status='ACTIVE' AND risk_flags='[]'::jsonb`, [identityId]);
    if (!eligible.rowCount) throw new AppError('IDENTITY_NOT_VERIFIED', 'Sign in to open a bank account.', 409);

    await ensureTreasury(client, bank, options);

    const tag = `px${createHash('sha256').update(`${options.generation}:${identityId}`).digest('hex').slice(0, 24)}`;
    const customers = await bank.customersByLastName(tag);
    if (customers.length > 1) throw new AppError('BANK_ACCOUNT_NOT_READY', 'Bank account setup needs review.', 409);
    const customerId = customers[0] ?? await bank.createCustomer(tag);
    const accounts = await bank.checkingAccounts(customerId);
    if (accounts.length > 1) throw new AppError('BANK_ACCOUNT_NOT_READY', 'Bank account setup needs review.', 409);
    const accountId = accounts[0]?.id ?? await bank.createChecking(customerId, NICKNAME, STARTING_BALANCE_DOLLARS);

    const observed = await bank.account(accountId);
    if (observed.customerId !== customerId) throw new AppError('BANK_PROOF_MISMATCH', 'Bank account ownership mismatch.', 503);
    await client.query(`INSERT INTO banking_accounts(generation,identity_id,role,provider_account_id,provider_customer_id,nickname,last_observed_balance_usd,last_observed_at)
      VALUES($1,$2,'PARTICIPANT',$3,$4,$5,$6,now())`, [options.generation, identityId, accountId, customerId, observed.nickname, observed.dollars]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Registers the configured treasury account for this generation once (it receives funding transfers). */
async function ensureTreasury(client: import('pg').PoolClient, bank: Bank, options: { generation: string; treasuryProviderId: string }) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bank-treasury:${options.generation}`]);
  const existing = await client.query<{ provider_account_id: string }>("SELECT provider_account_id FROM banking_accounts WHERE generation=$1 AND role='TREASURY'", [options.generation]);
  if (existing.rows[0]) {
    if (existing.rows[0].provider_account_id !== options.treasuryProviderId) throw new AppError('BANK_ACCOUNT_NOT_READY', 'Treasury mapping does not match configuration.', 409);
    return;
  }
  const treasury = await bank.account(options.treasuryProviderId);
  await client.query(`INSERT INTO banking_accounts(generation,identity_id,role,provider_account_id,provider_customer_id,nickname,last_observed_balance_usd,last_observed_at)
    VALUES($1,NULL,'TREASURY',$2,$3,$4,$5,now())`, [options.generation, treasury.id, treasury.customerId, treasury.nickname, treasury.dollars]);
}
