import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { Keypair,SystemProgram,TransactionMessage,VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PgStore } from '../../src/purchase/db/store.js';
import { FundingStore } from '../../src/purchase/banking/store.js';
import { FundingService } from '../../src/purchase/banking/service.js';
import { BankError,type Bank,type BankTransfer,type NessieProfile } from '../../src/purchase/banking/adapter.js';
import type { Funding,FundingProof,FundingTx,PurchaseChain,RoundInfo,SubscriptionState } from '../../src/purchase/banking/types.js';
import { PurchaseStore } from '../../src/purchase/rounds/purchase-store.js';
import { PurchaseService } from '../../src/purchase/rounds/purchase-service.js';
import { TestChain,founder,identityId,projectId,relayer,sessionHash,sessionToken,preparedTransaction } from './helpers.js';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createPurchaseRouter } from '../../src/purchase/router.js';
import { coreSchemaSql } from '../helpers/pglite-schema.js';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { createRoundsRouter } from '../../src/routes/rounds.js';
import { modelHash } from '../../src/valuation/model-value.js';
import { modelDocument } from '../../src/valuation/service.js';
import { AppError } from '../../src/purchase/http/errors.js';

export const profile:NessieProfile={id:'unit-fixture-only',baseUrl:'https://bank.example',capabilitiesVerified:true,
  verificationReference:'unit-test-fixture; not live validation',verifiedAt:'2026-10-10T00:00:00.000Z',
  createEnvelope:'objectCreated',readEnvelope:'direct',historyEnvelope:'array',historyPagination:'none',
  successStatuses:['completed'],pendingStatuses:['pending'],rejectedStatuses:['rejected'],definitiveNoEffectHttpStatuses:[422]};
export const roundId='00000000-0000-4000-8000-000000000004';
export const projectFounderId='00000000-0000-4000-8000-000000000005';
export const projectFounder=Keypair.generate();
export const walletTwo=Keypair.generate();
export class FakeBank implements Bank {
  writes=0;dollars=1000;transferRows:BankTransfer[]=[];outcome:'ok'|'lost-after-write'|'lost-before-write'|'no-effect'='ok';
  async account(id:string) {return {id,customerId:id==='source01' ? 'customer01' : 'treasurycustomer',nickname:'Demo Checking',dollars:this.dollars};}
  async createTransfer(payerId:string,payeeId:string,dollars:number,tag:string) {
    this.writes++;
    if (this.outcome==='no-effect') throw new BankError('no-effect');
    if (this.outcome==='lost-before-write') throw new BankError('uncertain');
    const transfer={id:`transfer${this.writes}`,payerId,payeeId,dollars,tag,providerStatus:'pending',state:'pending' as const};
    this.transferRows.push(transfer);
    if (this.outcome==='lost-after-write') throw new BankError('uncertain');
    return transfer.id;
  }
  async transfer(id:string) {const row=this.transferRows.find(item=>item.id===id);if (!row) throw new BankError('uncertain');return row;}
  async history(_id:string) {return this.transferRows;}
  succeed() {for (const row of this.transferRows) {row.state='success';row.providerStatus='completed';}}
}
function fullySigned() {
  const blockhash=Keypair.generate().publicKey.toBase58();
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:relayer.publicKey,recentBlockhash:blockhash,
    instructions:[SystemProgram.transfer({fromPubkey:relayer.publicKey,toPubkey:relayer.publicKey,lamports:1})]}).compileToV0Message());
  tx.sign([relayer]);return {transaction:Buffer.from(tx.serialize()).toString('base64'),message:Buffer.from(tx.message.serialize()).toString('base64'),
    signature:bs58.encode(tx.signatures[0]!),blockhash,lastValidBlockHeight:100,projectPda:projectFounder.publicKey.toBase58(),receiptMint:projectFounder.publicKey.toBase58()};
}
export class FakePurchaseChain extends TestChain implements PurchaseChain {
  fundingPrepared=0;fundingSubmitted=0;plans=new Map<string,Funding>();funded=new Map<string,FundingProof>();
  fundingStatuses=new Map<string,FundingTx['status']>();payment='100000000';holdings='99';
  subscription:SubscriptionState|null=null;
  round:RoundInfo={address:Keypair.generate().publicKey.toBase58(),projectId,projectPda:projectFounder.publicKey.toBase58(),founderWallet:projectFounder.publicKey.toBase58(),
    opensAt:'1',closesAt:'1000',price:'1000000',maxUnits:'100',target:'100000000',totalCommitted:'0',maxSubscription:'100000000',status:'open',paused:false};
  async prepareFunding(value:Funding):Promise<FundingTx> {
    this.fundingPrepared++;const tx=fullySigned();this.plans.set(tx.signature,structuredClone(value));
    return {...tx,messageHash:'ab'.repeat(32),status:'Prepared'};
  }
  async fundingReceipt(value:Funding) {return this.funded.get(value.id) ?? null;}
  async fundingTxStatus(tx:FundingTx) {return this.fundingStatuses.get(tx.signature) ?? 'Unknown';}
  async paymentBalance(_wallet:string) {return this.payment;}
  async roundInfo(_address:string) {return this.round;}
  async prepareSubscription(_round:RoundInfo,_wallet:string,_amount:string) {this.prepared=preparedTransaction();return this.prepared;}
  async subscriptionState(_roundAddress:string,_wallet:string) {return this.subscription;}
  override async balance(_projectId:string,_wallet:string) {return this.holdings;}
  override async submit(raw:Uint8Array) {
    const tx=VersionedTransaction.deserialize(raw);const signature=bs58.encode(tx.signatures[0]!);
    if (this.plans.has(signature)) {this.fundingSubmitted++;this.fundingStatuses.set(signature,'Submitted');return;}
    await super.submit(raw);
  }
  mineFunding() {
    for (const [signature,plan] of this.plans) {this.fundingStatuses.set(signature,'Finalized');this.funded.set(plan.id,
      {intentId:plan.id,wallet:plan.wallet,amount:plan.amount,mint:'fixture-mint',proofHash:plan.proofHash!,funded:true});}
  }
  override async prepareSettlement(_roundPda:string,_buyerWallet:string) {
    if (this.round.closesAt!=='0' && this.round.status==='open') throw new AppError('ROUND_NOT_CLOSED','Not closed.',409);
    const tx=fullySigned();this.prepared=tx;return {...tx,projectId};
  }
}
export async function databaseFixture() {
  const database=new PGlite();
  await database.exec(coreSchemaSql());
  const native=await readFile(new URL('../../../db/migrations/0001_market_schema.sql',import.meta.url),'utf8');
  await database.exec(native.slice(native.indexOf('create table chain_events ('),native.indexOf('-- Operations ---')));
  const metrics=native.slice(native.indexOf('create table market_metrics ('),native.indexOf('-- Real-time aggregates')).replace(/\) with \(\s*tsdb\.[\s\S]*?\n\);/g,');');
  await database.exec(metrics);
  for(const name of ['rate_limits','indexer_state']) {
    const start=native.indexOf(`create table ${name} (`);await database.exec(native.slice(start,native.indexOf('\n);',start)+4));
  }
  await database.exec((await readFile(new URL('../../../db/migrations/0004_purchase_runtime.sql',import.meta.url),'utf8')).split('-- migrate:down')[0]);
  const query=async (sql:string,parameters?:unknown[]) => {const result=await database.query(sql,parameters);return {rows:result.rows,rowCount:/^\s*SELECT\b/i.test(sql) ? result.rows.length : result.affectedRows};};
  let unlocked=Promise.resolve();
  const pool={query,connect:async () => {
    const predecessor=unlocked;let release!:()=>void;unlocked=new Promise<void>(resolve=>{release=resolve;});await predecessor;
    return {query,release};
  }} as unknown as Pool;
  const identity=new PgStore(pool),fundingStore=new FundingStore(pool),purchaseStore=new PurchaseStore(pool);
  const chain=new FakePurchaseChain(),bank=new FakeBank();
  const funding=new FundingService(fundingStore,identity,chain,{generation:'g1',enabled:true,paused:false,treasuryProviderId:'treasury01',profile},()=>bank);
  const subscriptions=new PurchaseService(purchaseStore,identity,chain);
  for(const [id,label] of [[identityId,'buyer'],[projectFounderId,'founder']]) {
    const user=await database.query<{id:string}>(`INSERT INTO auth."user"(name,email,"emailVerified","createdAt","updatedAt") VALUES('Synthetic',$1,true,now(),now()) RETURNING id`,[`${label}@unc.edu`]);
    await database.query("INSERT INTO identities(id,auth_user_id,campus_email_hash,verification_status,verified_at) VALUES($1,$2,$3,'VERIFIED',now())",[id,user.rows[0]!.id,id!.replaceAll('-','').padEnd(64,'0')]);
  }
  for (const [wallet,id] of [[founder.publicKey.toBase58(),identityId],[walletTwo.publicKey.toBase58(),identityId],[projectFounder.publicKey.toBase58(),projectFounderId]]) {
    await database.query('INSERT INTO wallets(address,identity_id,verified_signature) VALUES($1,$2,$3)',[wallet,id,'synthetic-test-proof']);
  }
  const seed=JSON.parse(await readFile(new URL('../../../db/seeds/valuation-v0.1.json',import.meta.url),'utf8'));
  await database.query(`INSERT INTO model_versions(id,effective_at,stage_weights,factor_weights,normalization_rules,scenario_parameters,demand_parameters,model_hash)
    VALUES($1,now(),$2,$3,$4,$5,$6,$7)`,[seed.id,...['stage_weights','factor_weights','normalization_rules','scenario_parameters','demand_parameters'].map(k=>JSON.stringify(seed[k])),modelHash(modelDocument(seed))]);
  await database.query("INSERT INTO projects(id,slug,name,stage,status,founder_identity_id,founder_wallet) VALUES($1,'demo','Demo','IDEA','PUBLISHED',$2,$3)",[projectId,projectFounderId,projectFounder.publicKey.toBase58()]);
  const snapshot=await database.query<{id:string;calculated_at:Date}>(`INSERT INTO valuation_snapshots(valuation_run_id,project_id,model_version_id,model_hash,declared_stage,effective_stage,
   current_operating_value,scenario_value,model_reference_value,round_implied_value,unit_price_micro_usd,scenario_details,assumptions,input_hash,evidence_root)
   VALUES(gen_random_uuid(),$1,$2,$3,'IDEA','IDEA',0,1000000,1000000,1000000,1000000,'{}','{}',$3,$3) RETURNING id,calculated_at`,[projectId,seed.id,modelHash(modelDocument(seed))]);
  await database.query(`INSERT INTO rounds(id,project_id,solana_round_pda,round_number,opens_at,closes_at,unit_price_micro_usd,max_units,target_amount_micro_usd,max_subscription_micro_usd,
   model_version_id,valuation_snapshot_id,valuation_calculated_at,model_hash,evidence_root)
   VALUES($1,$2,$3,1,now(),now()+interval '1 day',1000000,100,100000000,100000000,$4,$5,$6,$7,$7)`,[roundId,projectId,chain.round.address,seed.id,snapshot.rows[0]!.id,snapshot.rows[0]!.calculated_at,modelHash(modelDocument(seed))]);
  await database.query(`INSERT INTO banking_accounts(generation,identity_id,role,provider_account_id,provider_customer_id,nickname)
    VALUES('g1',$1,'PARTICIPANT','source01','customer01','Demo Checking'),('g1',NULL,'TREASURY','treasury01','treasurycustomer','Demo Treasury')`,[identityId]);
  const app=new Hono();
  app.route('/api',createPurchaseRouter(identity,chain,'http://localhost:8787',{store:identity,chain,funding,subscriptions,indexer:null,reconcile:async()=>{}},async context=>{
    if(context.req.header('Cookie')!==headers.Cookie) throw new HTTPException(401);
    return {identityId};
  }));
  async function tick() {await database.exec("UPDATE funding_intents SET next_attempt_at=now()-interval '1 second'");return funding.tick('worker-one');}
  return {database,pool,identity,fundingStore,purchaseStore,chain,bank,funding,subscriptions,app,tick};
}
export const headers={Origin:'http://localhost:8787','Content-Type':'application/json',Cookie:`prospecto_session=${sessionToken}`,'Idempotency-Key':'funding-key-one'};
