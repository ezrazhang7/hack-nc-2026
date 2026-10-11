import {expect,test,vi} from 'vitest';
import type {Bank,BankTransfer} from '../../src/purchase/banking/adapter.js';
import {baseline,verifyCapability} from '../../src/purchase/banking/probe.js';
function fixture(){
  const transfer:BankTransfer={id:'t1',payerId:'payer',payeeId:'treasury',dollars:10,tag:'isolated-probe',providerStatus:'completed',state:'success'};
  const bank:Bank={account:vi.fn(async id=>({id,customerId:'mock-customer',nickname:'Mock',dollars:id==='payer'?990:10})),createTransfer:vi.fn(),history:vi.fn(async()=>[transfer]),transfer:vi.fn(async()=>transfer)};
  const prior={payer:{id:'payer',dollars:1000},payee:{id:'treasury',dollars:0},sourceHistory:[],treasuryHistory:[]};
  const creation={httpStatus:201,body:{objectCreated:{_id:'t1',status:'pending'}}};
  return {bank,prior,creation,transfer};
}
test('capability evidence requires a matching terminal transfer, histories and both balance movements without a write',async()=>{
  const f=fixture();expect(await verifyCapability(f.bank,f.prior,'t1','isolated-probe',10,f.creation,'objectCreated')).toMatchObject({capabilitiesVerified:true,terminalStatus:'completed',creationStatus:'pending'});expect(f.bank.createTransfer).not.toHaveBeenCalled();
});
test('wrong creation id, unchanged balance, duplicate history and unknown status cannot enable funding',async()=>{
  const f=fixture();await expect(verifyCapability(f.bank,f.prior,'wrong','isolated-probe',10,f.creation,'objectCreated')).rejects.toThrow();
  f.prior.payer.dollars=990;await expect(verifyCapability(f.bank,f.prior,'t1','isolated-probe',10,f.creation,'objectCreated')).rejects.toThrow();f.prior.payer.dollars=1000;
  vi.mocked(f.bank.history).mockResolvedValue([f.transfer,f.transfer]);await expect(verifyCapability(f.bank,f.prior,'t1','isolated-probe',10,f.creation,'objectCreated')).rejects.toThrow();vi.mocked(f.bank.history).mockResolvedValue([f.transfer]);
  f.transfer.state='unknown';await expect(verifyCapability(f.bank,f.prior,'t1','isolated-probe',10,f.creation,'objectCreated')).rejects.toThrow();expect(f.bank.createTransfer).not.toHaveBeenCalled();
});
test('baseline rejects reuse of the same isolated mock account',async()=>{const f=fixture();await expect(baseline(f.bank,'payer','payer')).rejects.toThrow();});
