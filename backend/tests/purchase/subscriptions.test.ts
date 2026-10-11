import { beforeEach,afterEach,describe,expect,test,vi } from 'vitest';
import { databaseFixture,headers,projectFounderId,roundId,walletTwo } from './purchase-helpers.js';
import { founder,identityId,projectId,sign } from './helpers.js';
import { VersionedTransaction } from '@solana/web3.js';
import { hash } from '../../src/purchase/banking/canonical.js';
let fixture:Awaited<ReturnType<typeof databaseFixture>>;
beforeEach(async()=>{vi.spyOn(console,'error').mockImplementation(()=>undefined);fixture=await databaseFixture();},30_000);
afterEach(async()=>{await fixture.database.close();vi.restoreAllMocks();});
const prepare=()=>fixture.subscriptions.prepare(identityId,roundId,founder.publicKey.toBase58(),'100000000','subscription-key');
describe('wallet-funded startup participation',()=>{
  test('worker resumes a signed subscription persisted before a crashed RPC dispatch',async()=>{
    const prepared=await prepare();const signed=sign(prepared);
    await fixture.identity.markSubmitted(prepared.attemptId,signed);
    const attempt=(await fixture.identity.findBySignature(identityId,prepared.signature))!;
    vi.spyOn(fixture.chain,'status').mockResolvedValue('Unknown');
    await fixture.subscriptions.transactions.recover(attempt);
    expect(fixture.chain.submitted).toBe(1);expect(fixture.bank.writes).toBe(0);
    expect((await fixture.database.query('SELECT count(*) AS n FROM subscription_intents')).rows).toEqual([{n:1}]);
    await expect(fixture.database.exec('UPDATE subscription_intents SET gross_amount_micro_usd=99000000')).rejects.toThrow(/immutable/);
    expect(await fixture.identity.signedTransaction(prepared.attemptId)).toBe(signed);
  });
  test('preparation reserves identity before signing and a replay returns the same attempt',async()=>{
    const build=vi.spyOn(fixture.chain,'prepareSubscription');
    const first=await prepare();const second=await prepare();expect(first).toEqual(second);expect(build).toHaveBeenCalledTimes(1);
    expect(first.preview).toMatchObject({units:'99',feeMicroUsd:'1000000'});expect(first.provisional).toBe(true);expect(fixture.bank.writes).toBe(0);
    expect((await fixture.database.query('SELECT count(*) AS n FROM subscription_intents')).rows).toEqual([{n:1}]);
  });
  test('two verified wallets and simultaneous requests cannot create two identity allocations',async()=>{
    const results=await Promise.allSettled([prepare(),fixture.subscriptions.prepare(identityId,roundId,walletTwo.publicKey.toBase58(),'100000000','another-key')]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(result=>result.status==='rejected')[0]).toMatchObject({reason:{code:'ALREADY_SUBSCRIBED'}});
  });
  test('founder/team identities and flagged identities are rejected',async()=>{
    await fixture.database.query('INSERT INTO project_members(project_id,identity_id,role) VALUES($1,$2,$3)',[projectId,identityId,'TEAM']);
    await expect(prepare()).rejects.toMatchObject({code:'SELF_SUBSCRIPTION_FORBIDDEN'});
    await fixture.database.exec('DELETE FROM project_members');await fixture.database.query('UPDATE projects SET founder_identity_id=$1',[identityId]);
    await expect(prepare()).rejects.toMatchObject({code:'SELF_SUBSCRIPTION_FORBIDDEN'});
    await fixture.database.query('UPDATE projects SET founder_identity_id=$1',[projectFounderId]);await fixture.database.query(`UPDATE identities SET status='SUSPENDED' WHERE id=$1`,[identityId]);
    await expect(prepare()).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  test('changed gross or wallet with the same key conflicts; paused rounds reject new participation',async()=>{
    await prepare();await expect(fixture.subscriptions.prepare(identityId,roundId,founder.publicKey.toBase58(),'99000000','subscription-key')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    fixture.chain.round.paused=true;await expect(fixture.subscriptions.prepare(identityId,roundId,walletTwo.publicKey.toBase58(),'100000000','different-key')).rejects.toMatchObject({code:'ROUND_NOT_OPEN'});
  });
  test('a rejected wallet signature or changed message moves no tokens or banking money',async()=>{
    const prepared=await prepare();
    await expect(fixture.subscriptions.submit(identityId,prepared.intentId,prepared.signature,prepared.transaction,'submit-key')).rejects.toMatchObject({code:'INVALID_TRANSACTION'});
    const tx=VersionedTransaction.deserialize(Buffer.from(sign(prepared),'base64'));tx.message.compiledInstructions[0]!.data[4]=42;
    await expect(fixture.subscriptions.submit(identityId,prepared.intentId,prepared.signature,Buffer.from(tx.serialize()).toString('base64'),'submit-key')).rejects.toMatchObject({code:'INVALID_TRANSACTION'});
    expect(fixture.chain.submitted).toBe(0);expect(fixture.bank.writes).toBe(0);
  });
  test('subscription finality records a commitment; units stay zero until allocation, holdings reflect burns',async()=>{
    const prepared=await prepare();await fixture.subscriptions.submit(identityId,prepared.intentId,prepared.signature,sign(prepared),'submit-key');
    fixture.chain.finalize();fixture.chain.round.totalCommitted='100000000';
    fixture.chain.subscription={gross:'100000000',accepted:'0',units:'0',refundedAmount:'0',minted:false,refunded:false};
    let portfolio=await fixture.subscriptions.portfolio(identityId);expect(portfolio.allocations[0]).toMatchObject({issuedReceiptUnits:'0',allocationFinalized:false});
    fixture.chain.round.status='finalized';fixture.chain.subscription={gross:'100000000',accepted:'100000000',units:'99',refundedAmount:'0',minted:true,refunded:true};fixture.chain.holdings='38';
    portfolio=await fixture.subscriptions.portfolio(identityId);expect(portfolio.allocations[0]).toMatchObject({issuedReceiptUnits:'99',feeMicroUsd:'1000000',founderRewardMicroUsd:'400000',refundFinalized:true});
    expect(portfolio.holdings[0]?.receiptBalanceUnits).toBe('38');expect(fixture.bank.writes).toBe(0);
  });
  test('cancelled round mirrors full refund and no receipts/fees',async()=>{
    const prepared=await prepare();await fixture.subscriptions.submit(identityId,prepared.intentId,prepared.signature,sign(prepared),'submit-key');fixture.chain.finalize();
    fixture.chain.round.totalCommitted='100000000';fixture.chain.round.status='refunding';
    fixture.chain.subscription={gross:'100000000',accepted:'0',units:'0',refundedAmount:'100000000',minted:false,refunded:true};
    const portfolio=await fixture.subscriptions.portfolio(identityId);expect(portfolio.allocations[0]).toMatchObject({issuedReceiptUnits:'0',feeMicroUsd:'0',refundedAmountMicroUsd:'100000000'});
  });
  test('expired attempts refresh under the same logical reservation and key after account absence',async()=>{
    const first=await prepare();const attempt=(await fixture.identity.findBySignature(identityId,first.signature))!;
    await fixture.identity.observe(attempt,'Expired',null);
    const refreshed=await prepare();expect(refreshed.intentId).toBe(first.intentId);expect(refreshed.signature).not.toBe(first.signature);
    expect((await fixture.database.query('SELECT count(*) AS n FROM subscription_chain_attempts')).rows).toEqual([{n:2}]);
    await expect(fixture.subscriptions.prepare(identityId,roundId,walletTwo.publicKey.toBase58(),'100000000','second-key')).rejects.toMatchObject({code:'ALREADY_SUBSCRIBED'});
  });
  test('transaction API requires matching logical intent and persists signed bytes before dispatch',async()=>{
    const prepared=await prepare();const body={intentId:prepared.intentId,signedTx:sign(prepared)};
    const response=await fixture.app.request('/api/transactions',{method:'POST',headers:{...headers,'Idempotency-Key':'submission-key'},body:JSON.stringify(body)});
    expect(response.status).toBe(202);expect(await response.json()).toMatchObject({status:'Submitted'});
    const persisted=await fixture.database.query<{signed_transaction_base64:string}>('SELECT signed_transaction_base64 FROM tokenization_intents WHERE signature=$1',[prepared.signature]);
    expect(persisted.rows[0]?.signed_transaction_base64).toBe(body.signedTx);
    expect((await fixture.app.request('/api/transactions',{method:'POST',headers,body:JSON.stringify({...body,intentId:roundId})})).status).toBe(404);
  });
  test('cached preparation is recoverable while the chain is unavailable or the round has closed',async()=>{
    const first=await prepare();fixture.chain.round.status='finalized';vi.spyOn(fixture.chain,'roundInfo').mockRejectedValue(new Error('RPC offline'));
    expect(await prepare()).toEqual(first);
  });
  test('automatic crank submits a guarded settlement only after close, without Nessie debit',async()=>{
    const prepared=await prepare();await fixture.subscriptions.submit(identityId,prepared.intentId,prepared.signature,sign(prepared),'submit-key');fixture.chain.finalize();
    fixture.chain.round.totalCommitted='100000000';fixture.chain.subscription={gross:'100000000',accepted:'0',units:'0',refundedAmount:'0',minted:false,refunded:false};
    const logical=(await fixture.purchaseStore.list(identityId))[0]!;await fixture.subscriptions.refresh(logical);
    await expect(fixture.subscriptions.crank(logical)).rejects.toMatchObject({code:'ROUND_NOT_CLOSED'});
    fixture.chain.round.closesAt='0';await fixture.subscriptions.crank(logical);
    expect((await fixture.database.query("SELECT count(*) AS n FROM tokenization_intents WHERE kind='Settle'")).rows).toEqual([{n:1}]);expect(fixture.bank.writes).toBe(0);
  });
});
