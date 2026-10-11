import { Indexer } from './indexing/indexer.js';
import { projectEvent } from './indexing/projector.js';
import { randomUUID } from 'node:crypto';
import bundledIdl from '../../idl/prospecto.json' with {type:'json'};
import type {Idl} from '@coral-xyz/anchor';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { BankError, NessieBank, resolveNessieProfile } from './banking/adapter.js';
import { FundingService, type BankingOptions } from './banking/service.js';
import { FundingStore } from './banking/store.js';
import { PgStore } from './db/store.js';
import { PurchaseService } from './rounds/purchase-service.js';
import { PurchaseStore } from './rounds/purchase-store.js';
import { SolanaChain } from './solana/client.js';
import type { PurchaseChain } from './banking/types.js';

export function makePurchaseServices(pool:Pool, chain:PurchaseChain, banking:BankingOptions,
  bankFor:ConstructorParameters<typeof FundingService>[4]) {
  const store=new PgStore(pool);
  const funding=new FundingService(new FundingStore(pool),store,chain,banking,bankFor);
  const subscriptions=new PurchaseService(new PurchaseStore(pool),store,chain);
  const indexer=chain instanceof SolanaChain ? new Indexer(pool,chain,projectEvent) : null;
  return {store,chain,funding,subscriptions,indexer,async reconcile(identityId:string,allowDispatch=false) {
    // Bounded, per-identity jobs survive the response through Vercel waitUntil. No new bank write on GET.
    const owner=randomUUID();
    if(indexer) {try {await indexer.backfill();} catch {console.error(JSON.stringify({operation:'chain_ingest',errorCode:'RECOVERY_PENDING'}));}}
    for (let n=0;n<3;n++) if(!await funding.tick(owner,identityId,allowDispatch)) break;
    for (const logical of (await subscriptions.store.list(identityId)).slice(0,10)) {
      try {await subscriptions.refresh(logical);await subscriptions.crank(logical);}
      catch {console.error(JSON.stringify({operation:'purchase_reconcile',intentId:logical.id,errorCode:'RECOVERY_PENDING'}));}
      finally {await subscriptions.store.checked(logical.id);}
    }
  }};
}
export type PurchaseServices=ReturnType<typeof makePurchaseServices>;
export async function loadPurchaseServices(pool:Pool, config:Config):Promise<PurchaseServices|undefined> {
  if (!config.PURCHASES_ENABLED) return undefined;
  if (!config.PROGRAM_ID || !config.PAYMENT_MINT || !config.RELAYER_SECRET_KEY)
    throw new Error('Purchases require PROGRAM_ID, PAYMENT_MINT, RELAYER_SECRET_KEY (the compiled IDL is bundled).');
  const profile=resolveNessieProfile(config,config.NESSIE_PROFILE_PATH ? await readFile(config.NESSIE_PROFILE_PATH,'utf8') : undefined);
  if (config.NESSIE_ENABLED && (!profile || !config.NESSIE_API_KEY || !config.NESSIE_TREASURY_ACCOUNT_ID))
    throw new Error('Nessie requires NESSIE_BASE_URL, NESSIE_API_KEY and NESSIE_TREASURY_ACCOUNT_ID.');
  const chain=await SolanaChain.fromConfig({rpcUrl:config.SOLANA_RPC_URL,programId:config.PROGRAM_ID,paymentMint:config.PAYMENT_MINT,
    relayerSecretKey:config.RELAYER_SECRET_KEY,...(config.PROGRAM_IDL_PATH ? {idlPath:config.PROGRAM_IDL_PATH} : {idl:bundledIdl as Idl})});
  return makePurchaseServices(pool,chain,{generation:config.DEMO_GENERATION_ID,enabled:config.NESSIE_ENABLED,paused:config.FUNDING_PAUSED,
    treasuryProviderId:config.NESSIE_TREASURY_ACCOUNT_ID ?? '',profile}, saved=>{
      if (!config.NESSIE_API_KEY || !config.NESSIE_BASE_URL || new URL(saved.baseUrl).origin!==new URL(config.NESSIE_BASE_URL).origin) throw new BankError('uncertain','BANK_PROFILE_UNAVAILABLE');
      return new NessieBank(saved,config.NESSIE_API_KEY);
    });
}
