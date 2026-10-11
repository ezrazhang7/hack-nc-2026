import { beforeEach,afterEach,expect,test,vi } from 'vitest';
import type { Pool } from 'pg';
import { databaseFixture } from './purchase-helpers.js';
import { identityId } from './helpers.js';
import { registerBankFixtures } from '../../src/purchase/banking/fixtures.js';
import { projectEvent } from '../../src/purchase/indexing/projector.js';
import { roundId } from './purchase-helpers.js';
import { projectId,founder } from './helpers.js';
import { Indexer,type ChainEvent } from '../../src/purchase/indexing/indexer.js';

let fixture:Awaited<ReturnType<typeof databaseFixture>>;
beforeEach(async()=>{fixture=await databaseFixture();},30_000);
afterEach(async()=>{await fixture.database.close();vi.restoreAllMocks();});
const manifest={generation:'g1',accounts:[
  {role:'PARTICIPANT',identityId,providerAccountId:'source01',providerCustomerId:'customer01',nickname:'Demo Checking'},
  {role:'TREASURY',identityId:null,providerAccountId:'treasury01',providerCustomerId:'treasurycustomer',nickname:'Demo Treasury'},
]};
test('fixture registration reads bank ownership, replays safely and never creates bank accounts',async()=>{
  await fixture.database.exec('DELETE FROM banking_accounts');
  vi.spyOn(fixture.bank,'account').mockImplementation(async id=>({id,customerId:id==='source01' ? 'customer01' : 'treasurycustomer',
    nickname:'Synthetic fixture',dollars:id==='source01' ? 1000 : 0}));
  expect(await registerBankFixtures(fixture.pool,fixture.bank,manifest,'g1','treasury01')).toEqual({generation:'g1',accounts:2});
  await fixture.database.exec("UPDATE banking_accounts SET active=false WHERE role='PARTICIPANT'");
  vi.spyOn(fixture.bank,'account').mockImplementation(async id=>({id,customerId:id==='source01' ? 'customer01' : 'treasurycustomer',nickname:'Synthetic fixture',dollars:10}));
  await registerBankFixtures(fixture.pool,fixture.bank,manifest,'g1','treasury01');
  expect((await fixture.database.query('SELECT count(*) AS n FROM banking_accounts')).rows).toEqual([{n:2}]);
  expect((await fixture.database.query("SELECT active FROM banking_accounts WHERE role='PARTICIPANT'")).rows).toEqual([{active:false}]);
  expect(fixture.bank.writes).toBe(0);
});
test('fixture ownership and initial balances fail closed and registration rolls back',async()=>{
  await fixture.database.exec('DELETE FROM banking_accounts');
  fixture.bank.dollars=999;
  await expect(registerBankFixtures(fixture.pool,fixture.bank,manifest,'g1','treasury01')).rejects.toMatchObject({code:'FIXTURE_BALANCE_INVALID'});
  expect((await fixture.database.query('SELECT count(*) AS n FROM banking_accounts')).rows).toEqual([{n:0}]);
  vi.spyOn(fixture.bank,'account').mockImplementation(async id=>({id,customerId:'wrong-customer',nickname:'Synthetic fixture',dollars:1000}));
  await expect(registerBankFixtures(fixture.pool,fixture.bank,manifest,'g1','treasury01')).rejects.toMatchObject({code:'BANK_PROOF_MISMATCH'});
  expect(fixture.bank.writes).toBe(0);
});
function event(signature:string,eventIndex:number):ChainEvent {
  return {programId:'fixture-program',signature,instructionIndex:2,eventIndex,slot:'100',
    eventType:'MockWalletFunded',payload:{amount:'100000000'}};
}
function indexer() {
  // PGlite has one connection; these sequential tests model the dedicated advisory-lock connection.
  const pool={query:fixture.pool.query,connect:async()=>({query:fixture.pool.query,release:()=>undefined})} as unknown as Pool;
  const chain={programAddress:()=> 'fixture-program',signatures:vi.fn(async()=>[{signature:'newest'},{signature:'older'}]),
    finalizedEvents:vi.fn(async signature=>[event(signature,0),event(signature,1)])};
  return {indexer:new Indexer(pool,chain),chain};
}
test('finalized indexer keeps multiple events in an instruction and deduplicates replay',async()=>{
  const {indexer:worker,chain}=indexer();
  await worker.backfill();await worker.backfill();
  expect((await fixture.database.query('SELECT count(*) AS n FROM chain_events')).rows).toEqual([{n:4}]);
  expect((await fixture.database.query('SELECT last_signature FROM indexer_state')).rows).toEqual([{last_signature:'newest'}]);
  expect(chain.signatures).toHaveBeenLastCalledWith(undefined,'newest');
  expect(chain.finalizedEvents.mock.calls[0]).toEqual(['older']);
});
test('missing finalized history retains cursor and the next pass recovers all events',async()=>{
  const {indexer:worker,chain}=indexer();
  await fixture.database.query('INSERT INTO indexer_state(program_id,last_signature) VALUES($1,$2)',['fixture-program','prior']);
  chain.finalizedEvents.mockImplementationOnce(async signature=>[event(signature,0),event(signature,1)]);
  chain.finalizedEvents.mockRejectedValueOnce(new Error('history unavailable'));
  await expect(worker.backfill()).rejects.toThrow('history unavailable');
  expect((await fixture.database.query('SELECT last_signature FROM indexer_state')).rows).toEqual([{last_signature:'prior'}]);
  await worker.backfill();
  expect((await fixture.database.query('SELECT count(*) AS n FROM chain_events')).rows).toEqual([{n:4}]);
  expect((await fixture.database.query('SELECT last_signature FROM indexer_state')).rows).toEqual([{last_signature:'newest'}]);
});

test('canonical event links and financial metrics commit once; malformed events roll back',async()=>{
  const event:ChainEvent={programId:'fixture-program',signature:'allocation-event',instructionIndex:1,eventIndex:0,slot:'101',eventType:'AllocationMinted',payload:{round:fixture.chain.round.address,buyer_wallet:founder.publicKey.toBase58(),accepted_amount:'100000000',units:'99',fee:'1000000',founder_reward:'400000'}};
  const chain={programAddress:()=> 'fixture-program',signatures:async()=>[],finalizedEvents:async()=>[event]};
  const worker=new Indexer(fixture.pool,chain,projectEvent);
  await worker.ingest(event.signature);await worker.ingest(event.signature);
  expect((await fixture.database.query('SELECT project_id,round_id FROM chain_events')).rows).toEqual([{project_id:projectId,round_id:roundId}]);
  expect((await fixture.database.query('SELECT count(*) AS n,sum(value)::text AS total FROM market_metrics')).rows).toEqual([{n:4,total:'101400099'}]);
  event.signature='bad-allocation';(event.payload as Record<string,unknown>).fee='-1';
  await expect(worker.ingest(event.signature)).rejects.toThrow();
  expect((await fixture.database.query('SELECT count(*) AS n FROM chain_events')).rows).toEqual([{n:1}]);
});

test('first finalized participant is counted once and replay does not inflate commitment',async()=>{
  await fixture.purchaseStore.reserve(identityId,roundId,founder.publicKey.toBase58(),'100000000','participant-test-key','aa'.repeat(32));
  const event:ChainEvent={programId:'fixture-program',signature:'subscription-event',instructionIndex:0,eventIndex:0,slot:'102',eventType:'SubscriptionAccepted',payload:{round:fixture.chain.round.address,buyer_wallet:founder.publicKey.toBase58(),gross_amount:'100000000'}};
  const worker=new Indexer(fixture.pool,{programAddress:()=> 'fixture-program',signatures:async()=>[],finalizedEvents:async()=>[event]},projectEvent);
  await worker.ingest(event.signature);await worker.ingest(event.signature);
  expect((await fixture.database.query("SELECT value::text AS value FROM market_metrics WHERE metric_code='NEW_PARTICIPANT'")).rows).toEqual([{value:'1'}]);
  expect((await fixture.database.query('SELECT total_committed_micro_usd::text AS amount FROM rounds WHERE id=$1',[roundId])).rows).toEqual([{amount:'100000000'}]);
});
