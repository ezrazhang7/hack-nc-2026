import { afterEach,beforeEach,describe,expect,test,vi } from 'vitest';
import { databaseFixture,projectFounderId } from './purchase-helpers.js';
import { founder,identityId } from './helpers.js';
import { BankError,type BankAccount,type BankProvisioner } from '../../src/purchase/banking/adapter.js';
import { provisionBankAccount } from '../../src/purchase/banking/provision.js';

/** In-memory Nessie: customers and Checking accounts, with injectable lost responses. */
class ProvisionBank implements BankProvisioner {
  customers:{id:string;lastName:string}[]=[];accounts:BankAccount[]=[];writes=0;loseNext:'customer'|'account'|null=null;
  async customersByLastName(lastName:string) {return this.customers.filter(row=>row.lastName===lastName).map(row=>row.id);}
  async checkingAccounts(customerId:string) {return this.accounts.filter(row=>row.customerId===customerId);}
  async createCustomer(lastName:string) {
    this.writes++;const id=`cust${this.customers.length+1}`;this.customers.push({id,lastName});
    if (this.loseNext==='customer') {this.loseNext=null;throw new BankError('uncertain');}
    return id;
  }
  async createChecking(customerId:string,nickname:string,dollars:number) {
    this.writes++;const id=`acct${this.accounts.length+1}`;this.accounts.push({id,customerId,nickname,dollars});
    if (this.loseNext==='account') {this.loseNext=null;throw new BankError('uncertain');}
    return id;
  }
  async account(id:string) {
    if (id==='treasury01') return {id,customerId:'treasurycustomer',nickname:'Treasury',dollars:0};
    const row=this.accounts.find(item=>item.id===id);if (!row) throw new BankError('uncertain');return row;
  }
  async createTransfer():Promise<string> {throw new Error('not used');}
  async transfer():Promise<never> {throw new Error('not used');}
  async history() {return [];}
}

let fixture:Awaited<ReturnType<typeof databaseFixture>>;let bank:ProvisionBank;
const options={generation:'g1',treasuryProviderId:'treasury01'};
const provision=()=>provisionBankAccount(fixture.pool,bank,options,identityId);
const mappings=async()=>(await fixture.database.query<{role:string;provider_account_id:string;last_observed_balance_usd:number}>(
  'SELECT role,provider_account_id,last_observed_balance_usd FROM banking_accounts ORDER BY role')).rows;
beforeEach(async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  fixture=await databaseFixture();bank=new ProvisionBank();
  await fixture.database.exec('DELETE FROM banking_accounts');
},30_000);
afterEach(async()=>{await fixture.database.close();vi.restoreAllMocks();});

describe('self-service bank account provisioning',()=>{
  test('opens one $1,000 Checking account and registers the treasury, once',async()=>{
    await provision();await provision();
    expect(bank.writes).toBe(2);expect(bank.accounts).toEqual([{id:'acct1',customerId:'cust1',nickname:'Everyday Checking',dollars:1000}]);
    expect(await mappings()).toEqual([
      {role:'PARTICIPANT',provider_account_id:'acct1',last_observed_balance_usd:1000},
      {role:'TREASURY',provider_account_id:'treasury01',last_observed_balance_usd:0}]);
  });
  test('a lost customer response is recovered by lookup, never a second create',async()=>{
    bank.loseNext='customer';
    await expect(provision()).rejects.toBeInstanceOf(BankError);
    expect(await mappings()).toEqual([]);
    await provision();
    expect(bank.customers).toHaveLength(1);expect(bank.accounts).toHaveLength(1);expect(bank.writes).toBe(2);
  });
  test('a lost account response is recovered by lookup, never a second create',async()=>{
    bank.loseNext='account';
    await expect(provision()).rejects.toBeInstanceOf(BankError);
    await provision();
    expect(bank.accounts).toHaveLength(1);expect(bank.writes).toBe(2);
    expect((await mappings()).find(row=>row.role==='PARTICIPANT')?.provider_account_id).toBe('acct1');
  });
  test('duplicate tagged customers go to review instead of guessing',async()=>{
    await provision();await fixture.database.exec("DELETE FROM banking_accounts WHERE role='PARTICIPANT'");
    bank.customers.push({...bank.customers[0]!,id:'cust-dup'});
    await expect(provision()).rejects.toMatchObject({code:'BANK_ACCOUNT_NOT_READY'});
  });
  test('the tag does not reveal the identity',async()=>{
    await provision();
    expect(bank.customers[0]!.lastName).toMatch(/^px[0-9a-f]{24}$/);
    expect(bank.customers[0]!.lastName).not.toContain(identityId.replaceAll('-','').slice(0,8));
  });
  test('unverified identities cannot open an account',async()=>{
    await fixture.database.query(`UPDATE identities SET risk_flags='["review"]'::jsonb WHERE id=$1`,[identityId]);
    await expect(provision()).rejects.toMatchObject({code:'IDENTITY_NOT_VERIFIED'});expect(bank.writes).toBe(0);
  });
  test('a mismatched treasury mapping fails closed',async()=>{
    await provision();
    await expect(provisionBankAccount(fixture.pool,bank,{...options,treasuryProviderId:'other'},projectFounderId))
      .rejects.toMatchObject({code:'BANK_ACCOUNT_NOT_READY'});
  });
  test('a provisioned account is accepted by the funding flow',async()=>{
    await provision();
    const accepted=await fixture.funding.create(identityId,founder.publicKey.toBase58(),'100000000','funding-after-provision');
    expect(accepted.status).toBe('CREATED');
  });
});
