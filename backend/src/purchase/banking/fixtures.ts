import { z } from 'zod';
import type { Pool } from 'pg';
import type { Bank } from './adapter.js';
import { AppError } from '../http/errors.js';

const mappingSchema=z.object({
  role:z.enum(['PARTICIPANT','TREASURY']),identityId:z.uuid().nullable(),
  providerAccountId:z.string().min(1).max(128),providerCustomerId:z.string().min(1).max(128),
  nickname:z.string().min(1).max(100),
}).strict().refine(row=>(row.role==='TREASURY')===(row.identityId===null));
export const manifestSchema=z.object({
  generation:z.string().min(1).max(100),accounts:z.array(mappingSchema).min(2).max(100),
}).strict();

/** Register already-created synthetic accounts. This function never writes to Nessie. */
export async function registerBankFixtures(pool:Pool,bank:Bank,input:unknown,expectedGeneration:string,treasuryProviderId:string) {
  const manifest=manifestSchema.parse(input);
  if (manifest.generation!==expectedGeneration || manifest.accounts.filter(row=>row.role==='TREASURY').length!==1
    || manifest.accounts.find(row=>row.role==='TREASURY')?.providerAccountId!==treasuryProviderId
    || new Set(manifest.accounts.map(row=>row.providerAccountId)).size!==manifest.accounts.length
    || new Set(manifest.accounts.filter(row=>row.identityId).map(row=>row.identityId)).size!==manifest.accounts.length-1) {
    throw new AppError('FIXTURE_MAPPING_INVALID','Fixture generation, treasury or ownership mappings conflict.');
  }
  const observed=[];
  for(const row of manifest.accounts) {
    const value=await bank.account(row.providerAccountId);
    if(value.id!==row.providerAccountId || value.customerId!==row.providerCustomerId) throw new AppError('BANK_PROOF_MISMATCH','Fixture account ownership mismatch.');
    observed.push(value);
  }
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fixtures:${manifest.generation}`]);
    for(const [index,row] of manifest.accounts.entries()) {
      const existing=await client.query<{generation:string;identity_id:string|null;role:string;provider_customer_id:string}>(
        'SELECT * FROM banking_accounts WHERE provider_account_id=$1 FOR UPDATE',[row.providerAccountId]);
      const prior=existing.rows[0];
      if(prior) {
        if(prior.generation!==manifest.generation || prior.identity_id!==row.identityId || prior.role!==row.role
          || prior.provider_customer_id!==row.providerCustomerId) throw new AppError('FIXTURE_MAPPING_INVALID','Existing bank mapping cannot be reassigned.');
        continue;
      }
      if(row.identityId) {
        const identity=await client.query(`SELECT 1 FROM identities WHERE id=$1 AND verified_at IS NOT NULL AND status='ACTIVE' AND risk_flags='[]'::jsonb`,[row.identityId]);
        if(!identity.rowCount) throw new AppError('IDENTITY_NOT_VERIFIED','Participant requires an eligible verified identity.');
      }
      const balance=observed[index]!.dollars;
      if(balance!==(row.role==='PARTICIPANT' ? 1000 : 0)) throw new AppError('FIXTURE_BALANCE_INVALID','Fresh fixtures require $1,000 per participant and $0 treasury.');
      await client.query(`INSERT INTO banking_accounts(generation,identity_id,role,provider_account_id,provider_customer_id,nickname,last_observed_balance_usd,last_observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())`,[manifest.generation,row.identityId,row.role,row.providerAccountId,row.providerCustomerId,row.nickname,balance]);
    }
    await client.query('COMMIT');
    return {generation:manifest.generation,accounts:manifest.accounts.length};
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
