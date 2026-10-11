import { describe,expect,test,vi } from 'vitest';
import { BUILT_IN_PROFILE_ID,NessieBank,builtInNessieProfile,profileSchema,resolveNessieProfile } from '../../src/purchase/banking/adapter.js';
import { profile } from './purchase-helpers.js';
// Observed 2026-10-11: a funding transfer is a Nessie withdrawal whose description is `<tag>><payee>`.
const tag='prospecto:funding:intent';
const raw={_id:'transfer01',type:'withdrawal',medium:'balance',payer_id:'source01',amount:100,description:`${tag}>treasury01`,status:'completed'};
const json=(value:unknown,headers?:HeadersInit)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json',...headers}});
describe('Nessie adapter capability contract',()=>{
  test('POST records a completed withdrawal with whole dollars, the tag and payee, and the server key',async()=>{
    const fetcher=vi.fn(async(_url:URL|RequestInfo,_options?:RequestInit)=>json({objectCreated:{_id:'transfer01',status:'pending'}}));
    const bank=new NessieBank(profile,'private-key',fetcher);
    expect(await bank.createTransfer('source01','treasury01',100,tag)).toBe('transfer01');
    const [url,options]=fetcher.mock.calls[0]!;expect(String(url)).toBe('https://bank.example/accounts/source01/withdrawals?key=private-key');
    expect(options).toMatchObject({method:'POST',redirect:'error'});
    expect(JSON.parse(String(options?.body))).toMatchObject({medium:'balance',amount:100,status:'completed',description:raw.description});
    await expect(bank.createTransfer('source01','treasury01',100,'bad>tag')).rejects.toMatchObject({code:'INVALID_INPUT'});
  });
  test('creation does not infer success; terminal states come from a matching read',async()=>{
    const bank=new NessieBank(profile,'key',async()=>json([raw]));
    expect(await bank.transfer('transfer01','source01')).toMatchObject({state:'success',dollars:100,payerId:'source01',payeeId:'treasury01',tag});
    const unknown=new NessieBank(profile,'key',async()=>json([{...raw,status:'processing-v2'}]));
    expect(await unknown.transfer('transfer01','source01')).toMatchObject({state:'unknown'});
    const noPayee=new NessieBank(profile,'key',async()=>json([{...raw,description:tag}]));
    expect(await noPayee.transfer('transfer01','source01')).toMatchObject({tag,payeeId:''});
  });
  test('transport timeout, malformed success and ambiguous HTTP errors never retry POST or leak key',async()=>{
    for(const outcome of ['timeout','malformed','http500']) {
      const fetcher=vi.fn(async()=>{
        if(outcome==='timeout') throw new Error('https://bank.example?key=private-key');
        return outcome==='malformed' ? json({notAnId:true}) : new Response('private-provider-body',{status:500});
      });
      const bank=new NessieBank(profile,'private-key',fetcher);
      const error=await bank.createTransfer('source01','treasury01',100,'tag').catch(error=>error);
      expect(error).toMatchObject({outcome:'uncertain'});expect(JSON.stringify(error)).not.toContain('private-key');expect(String(error)).not.toContain('private-key');expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  test('only tested no-effect HTTP semantics release a write reservation',async()=>{
    const bank=new NessieBank(profile,'key',async()=>new Response('',{status:422}));
    await expect(bank.createTransfer('source01','treasury01',100,'tag')).rejects.toMatchObject({outcome:'no-effect'});
    const unproven=new NessieBank(profile,'key',async()=>new Response('',{status:400}));
    await expect(unproven.createTransfer('source01','treasury01',100,'tag')).rejects.toMatchObject({outcome:'uncertain'});
  });
  test('history follows all tested pages and strips old keys before authenticating',async()=>{
    const fetcher=vi.fn(async(url:URL|RequestInfo)=>String(url).includes('page=2')
      ? json({data:[{...raw,_id:'transfer02'}],next:null})
      : json({data:[raw],next:'/accounts/source01/withdrawals?page=2&key=old-key'}));
    const bank=new NessieBank({...profile,historyEnvelope:'data',historyPagination:'next'},'key',fetcher);
    expect(await bank.history('source01')).toHaveLength(2);expect(String(fetcher.mock.calls[1]?.[0])).toContain('page=2&key=key');
  });
  test('malicious pagination origins, loops and conflicting duplicate IDs fail closed',async()=>{
    for(const next of ['https://evil.example/accounts/source01/withdrawals','/accounts/source01/withdrawals']) {
      const bank=new NessieBank({...profile,historyEnvelope:'data',historyPagination:'next'},'key',async()=>json({data:[raw],next}));
      await expect(bank.history('source01')).rejects.toMatchObject({outcome:'invalid'});
    }
    const duplicate=new NessieBank(profile,'key',async()=>json([raw,{...raw,amount:99}]));
    await expect(duplicate.history('source01')).rejects.toMatchObject({outcome:'invalid'});
  });
  test('unverified profiles, non-HTTPS origins and overlapping status classes are rejected',()=>{
    expect(()=>profileSchema.parse({...profile,capabilitiesVerified:false})).toThrow();
    expect(()=>profileSchema.parse({...profile,baseUrl:'http://bank.example'})).toThrow();
    expect(()=>profileSchema.parse({...profile,successStatuses:['pending']})).toThrow();
  });
});
describe('built-in Nessie profile (NESSIE_PROFILE deprecated)',()=>{
  test('is derived from NESSIE_BASE_URL and classifies only documented statuses',async()=>{
    const builtIn=resolveNessieProfile({NESSIE_BASE_URL:'https://bank.example'})!;
    expect(builtIn).toMatchObject({id:BUILT_IN_PROFILE_ID,baseUrl:'https://bank.example/',successStatuses:['completed'],pendingStatuses:['pending'],rejectedStatuses:[],definitiveNoEffectHttpStatuses:[]});
    const read=(status:string)=>new NessieBank(builtIn,'key',async()=>json([{...raw,status}])).transfer('transfer01','source01');
    expect(await read('completed')).toMatchObject({state:'success'});
    expect(await read('pending')).toMatchObject({state:'pending'});
    expect(await read('cancelled')).toMatchObject({state:'unknown'});
    expect(resolveNessieProfile({})).toBeNull();
  });
  test('a deprecated override must match NESSIE_BASE_URL',()=>{
    expect(resolveNessieProfile({NESSIE_BASE_URL:'https://bank.example',NESSIE_PROFILE:JSON.stringify(profile)})).toEqual(profile);
    expect(()=>resolveNessieProfile({NESSIE_BASE_URL:'https://other.example',NESSIE_PROFILE:JSON.stringify(profile)})).toThrow(/does not match/);
  });
  test('history treats the first page 404 ("No transfers found") as empty, but nothing else',async()=>{
    const builtIn=builtInNessieProfile('https://bank.example');
    const empty=new NessieBank(builtIn,'key',async()=>new Response('"No transfers found for this account"',{status:404}));
    expect(await empty.history('treasury01')).toEqual([]);
    const missingTransfer=new NessieBank(builtIn,'key',async()=>new Response('',{status:404}));
    await expect(missingTransfer.transfer('transfer01','source01')).rejects.toMatchObject({outcome:'uncertain'});
    await expect(new NessieBank(builtIn,'key',async()=>new Response('',{status:500})).history('treasury01')).rejects.toMatchObject({outcome:'uncertain'});
  });
});
