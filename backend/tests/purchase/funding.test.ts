import { afterEach,beforeEach,describe,expect,test,vi } from 'vitest';
import { databaseFixture,headers,profile,walletTwo } from './purchase-helpers.js';
import { founder,identityId,sign } from './helpers.js';
import { hash,fundingDollars } from '../../src/purchase/banking/canonical.js';
import { FundingService } from '../../src/purchase/banking/service.js';
import { LeaseLost } from '../../src/purchase/banking/store.js';

let fixture:Awaited<ReturnType<typeof databaseFixture>>;
beforeEach(async()=>{vi.spyOn(console,'error').mockImplementation(()=>undefined);fixture=await databaseFixture();},30_000);
afterEach(async()=>{await fixture.database.close();vi.restoreAllMocks();});
const create=()=>fixture.funding.create(identityId,founder.publicKey.toBase58(),'100000000','funding-key-one');
describe('Nessie funding persistence and recovery',()=>{
  test('late bank reversal preserves completion, freezes source and pauses new generations',async()=>{
    const accepted=await create();await fixture.tick();fixture.bank.succeed();await fixture.tick();await fixture.tick();
    fixture.chain.mineFunding();await fixture.tick();
    await fixture.database.exec("UPDATE funding_intents SET audited_at=now()-interval '6 minutes',created_at=now()-interval '2 hours'");
    await fixture.funding.create(identityId,founder.publicKey.toBase58(),'100000000','new-funding-key');
    fixture.bank.transferRows[0]!.state='rejected';fixture.bank.transferRows[0]!.providerStatus='rejected';
    await fixture.funding.auditCompleted('audit-worker');
    expect(await fixture.funding.owned(identityId,accepted.fundingId)).toMatchObject({status:'COMPLETED',nextAction:'CONTACT_OPERATOR',confirmation:'finalized'});
    expect(await fixture.fundingStore.paused('another-generation')).toBe(true);
    expect((await fixture.database.query('SELECT active FROM banking_accounts WHERE provider_account_id=$1',['source01'])).rows).toEqual([{active:false}]);
    expect((await fixture.database.query('SELECT count(*) AS n FROM funding_incidents')).rows).toEqual([{n:1}]);
    expect(fixture.bank.writes).toBe(1);expect(fixture.chain.fundingPrepared).toBe(1);
  });
  test('audit outages do not undo completion and banking evidence is append-only',async()=>{
    const accepted=await create();await fixture.tick();fixture.bank.succeed();await fixture.tick();await fixture.tick();
    fixture.chain.mineFunding();await fixture.tick();
    await fixture.database.exec("UPDATE funding_intents SET audited_at=now()-interval '6 minutes'");
    vi.spyOn(fixture.bank,'transfer').mockRejectedValue(new Error('temporary outage'));
    await fixture.funding.auditCompleted('audit-worker');
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('COMPLETED');
    expect(await fixture.fundingStore.paused('g1')).toBe(false);
    expect((await fixture.database.query('SELECT count(*) AS n FROM banking_observations')).rows).toEqual([{n:3}]);
    await expect(fixture.database.exec("UPDATE banking_observations SET sanitized_response='{}'")).rejects.toThrow(/append-only/);
    await expect(fixture.database.exec('DELETE FROM funding_transitions')).rejects.toThrow(/append-only/);
  });
  test('funding completes only after verified bank success and finalized receipt',async()=>{
    const accepted=await create();expect(accepted.status).toBe('CREATED');
    await fixture.tick();expect(fixture.bank.writes).toBe(1);expect(fixture.chain.fundingPrepared).toBe(0);
    await fixture.tick();expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_PENDING');
    fixture.bank.succeed();await fixture.tick();expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_CONFIRMED');
    await fixture.tick();expect(fixture.chain.fundingPrepared).toBe(1);
    await fixture.tick();expect(fixture.chain.fundingSubmitted).toBe(1);
    const tx=(await fixture.fundingStore.latestTx(accepted.fundingId))!;fixture.chain.fundingStatuses.set(tx.signature,'Confirmed');
    await fixture.tick();expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('MINT_CONFIRMED');
    fixture.chain.mineFunding();await fixture.tick();expect(await fixture.funding.owned(identityId,accepted.fundingId)).toMatchObject({status:'COMPLETED',confirmation:'finalized',simulation:true,mode:'NESSIE'});
    expect(fixture.bank.writes).toBe(1);
  });
  test('same-key replay and lost responses do not create another bank intent',async()=>{
    const first=await create();await fixture.tick();const replay=await create();expect(replay.fundingId).toBe(first.fundingId);
    await expect(fixture.funding.create(identityId,walletTwo.publicKey.toBase58(),'100000000','funding-key-one')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect((await fixture.funding.byKey(identityId,'funding-key-one')).fundingId).toBe(first.fundingId);
    expect(fixture.bank.writes).toBe(1);
  });
  test('new keys and a second wallet cannot bypass unresolved funding or identity limits',async()=>{
    await create();await expect(fixture.funding.create(identityId,walletTwo.publicKey.toBase58(),'100000000','second-key')).rejects.toMatchObject({code:'FUNDING_IN_PROGRESS'});
    await fixture.tick();fixture.bank.succeed();await fixture.tick();await fixture.tick();fixture.chain.mineFunding();await fixture.tick();
    await expect(fixture.funding.create(identityId,walletTwo.publicKey.toBase58(),'100000000','second-key')).rejects.toMatchObject({code:'FUNDING_LIMIT'});
  });
  test('concurrent requests reserve one source account atomically',async()=>{
    const results=await Promise.allSettled([create(),fixture.funding.create(identityId,walletTwo.publicKey.toBase58(),'100000000','second-key')]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect((await fixture.database.query('SELECT count(*) AS n FROM funding_intents')).rows).toEqual([{n:1}]);
  });
  test('POST timeout after effect recovers through history without repeating POST',async()=>{
    fixture.bank.outcome='lost-after-write';const accepted=await create();await fixture.tick();
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_UNKNOWN');
    fixture.bank.succeed();await fixture.tick();await fixture.tick();fixture.chain.mineFunding();await fixture.tick();
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('COMPLETED');expect(fixture.bank.writes).toBe(1);
  });
  test('a crash after dispatch reservation never authorizes another POST',async()=>{
    const accepted=await create();const lease=(await fixture.fundingStore.claim('crashed-worker'))!;
    await fixture.fundingStore.dispatch(lease,'cd'.repeat(32));await fixture.fundingStore.release(lease);
    await fixture.tick();await fixture.tick();expect(fixture.bank.writes).toBe(0);
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_UNKNOWN');
  });
  test('timeout without visible history remains unknown, never guesses rejection',async()=>{
    fixture.bank.outcome='lost-before-write';const accepted=await create();await fixture.tick();
    for(let index=0;index<4;index++) await fixture.tick();
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_UNKNOWN');expect(fixture.bank.writes).toBe(1);
  });
  test('a lease lost across restart rejects stale writes and a new worker only reconciles',async()=>{
    await create();const old=(await fixture.fundingStore.claim('old'))!;await fixture.fundingStore.dispatch(old,'ef'.repeat(32));
    await fixture.database.exec("UPDATE funding_intents SET lease_expires_at=now()-interval '1 second'");const replacement=(await fixture.fundingStore.claim('new'))!;
    await expect(fixture.fundingStore.advance(old,'BANK_REJECTED','UNSAFE')).rejects.toBeInstanceOf(LeaseLost);
    await fixture.fundingStore.release(replacement);await fixture.tick();expect(fixture.bank.writes).toBe(0);
  });
  test.each(['duplicate','wrong-amount','wrong-payer','unknown-status'])('provider %s freezes source and pauses funding',async scenario=>{
    if(scenario==='duplicate') fixture.bank.outcome='lost-after-write';
    const accepted=await create();await fixture.tick();
    if(scenario==='duplicate') {
      fixture.bank.transferRows.push({...fixture.bank.transferRows[0]!,id:'duplicate-transfer'});
    } else if(scenario==='wrong-amount') fixture.bank.transferRows[0]!.dollars=99;
    else if(scenario==='wrong-payer') fixture.bank.transferRows[0]!.payerId='another-source';
    else {fixture.bank.transferRows[0]!.state='unknown';fixture.bank.transferRows[0]!.providerStatus='unexpected';}
    await fixture.tick();expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('NEEDS_REVIEW');
    expect(await fixture.fundingStore.paused('g1')).toBe(true);expect(fixture.chain.fundingPrepared).toBe(0);
    if(scenario!=='duplicate') expect((await fixture.database.query('SELECT count(*) AS n FROM banking_observations')).rows).toEqual([{n:1}]);
  });
  test('current reservation is not subtracted twice when balance exactly covers funding',async()=>{
    fixture.bank.dollars=100;await create();await fixture.tick();expect(fixture.bank.writes).toBe(1);
  });
  test('insufficient bank balance is a conclusive no-dispatch rejection',async()=>{
    fixture.bank.dollars=99;const accepted=await create();await fixture.tick();expect(fixture.bank.writes).toBe(0);
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('BANK_REJECTED');
  });
  test('new chain signatures reuse the funding intent and bank proof after proven expiry',async()=>{
    const accepted=await create();await fixture.tick();fixture.bank.succeed();await fixture.tick();await fixture.tick();await fixture.tick();
    const first=(await fixture.fundingStore.latestTx(accepted.fundingId))!;fixture.chain.fundingStatuses.set(first.signature,'Expired');await fixture.tick();
    const second=(await fixture.fundingStore.latestTx(accepted.fundingId))!;expect(second.signature).not.toBe(first.signature);expect(fixture.bank.writes).toBe(1);
    const plans=[...fixture.chain.plans.values()];expect(plans[0]?.id).toBe(plans[1]?.id);expect(plans[0]?.proofHash).toBe(plans[1]?.proofHash);
  });
  test('completed proof survives lost mint RPC response and contradictory proof is rejected',async()=>{
    const accepted=await create();await fixture.tick();fixture.bank.succeed();await fixture.tick();await fixture.tick();fixture.chain.mineFunding();
    fixture.chain.funded.get(accepted.fundingId)!.wallet=walletTwo.publicKey.toBase58();await fixture.tick();
    expect((await fixture.funding.owned(identityId,accepted.fundingId)).status).toBe('NEEDS_REVIEW');expect(fixture.bank.writes).toBe(1);
  });
  test('funding fields and account ownership mappings cannot be edited',async()=>{
    await create();await expect(fixture.database.exec("UPDATE funding_intents SET amount_micro_usd=99000000")).rejects.toThrow(/immutable/);
    await expect(fixture.database.exec("UPDATE banking_accounts SET provider_customer_id='other'")).rejects.toThrow(/immutable/);
  });
  test('disabled new funding does not hide accepted intents or their request-key recovery',async()=>{
    const accepted=await create();const disabled=new FundingService(fixture.fundingStore,fixture.identity,fixture.chain,
      {...fixture.funding.options,enabled:false,profile:null},()=>fixture.bank);
    expect((await disabled.create(identityId,founder.publicKey.toBase58(),'100000000','funding-key-one')).fundingId).toBe(accepted.fundingId);
    await expect(disabled.create(identityId,founder.publicKey.toBase58(),'100000000','new-key-1')).rejects.toMatchObject({code:'BANK_UNAVAILABLE'});
  });
  test('API owns accounts and intents, rejects bank IDs and keeps provider fields private',async()=>{
    const body={walletAddress:founder.publicKey.toBase58(),amountMicroUsd:'100000000'};
    const accepted=await fixture.app.request('/api/funding',{method:'POST',headers,body:JSON.stringify(body)});expect(accepted.status).toBe(202);
    const json=await accepted.json();expect(JSON.stringify(json)).not.toContain('source01');expect(JSON.stringify(json)).not.toContain('treasury01');
    expect((await fixture.app.request('/api/funding',{method:'POST',headers,body:JSON.stringify({...body,payerId:'attacker'})})).status).toBe(400);
    const other=await fixture.app.request('/api/funding/00000000-0000-4000-8000-000000000005',{headers});expect(other.status).toBe(404);
    const balance=await fixture.app.request('/api/banking/account',{headers});expect(await balance.json()).toMatchObject({balanceMicroUsd:'1000000000',simulation:true});
  });
});
test('canonical bank proof encoding is deterministic and excludes mutable status',()=>{
  expect(hash({version:1,mode:'NESSIE',intentId:'intent',providerTransferId:'tx',payerId:'payer',payeeId:'payee',amountMicroUsd:'100000000'}))
    .toBe(hash({amountMicroUsd:'100000000',payeeId:'payee',payerId:'payer',providerTransferId:'tx',intentId:'intent',mode:'NESSIE',version:1}));
  expect(fundingDollars('100000000')).toBe(100);expect(()=>fundingDollars('1000001')).toThrow();expect(()=>fundingDollars('0')).toThrow();
});
