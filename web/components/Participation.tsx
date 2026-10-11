'use client';
import {useCallback,useEffect,useState} from 'react';
import {api,actionKey,dollarsToMicro,money} from '@/lib/purchase-api';
import {connectWallet,signProof,signPrepared} from '@/lib/wallet';
import {investSlugHref,routes} from '@/lib/routes';
type Status={backendConfigured:boolean;purchasesEnabled:boolean;nessieEnabled:boolean;demoMode:boolean};
type Me={identityId:string};
type Prepared={intentId:string;signature:string;transaction:string;kind:string;status:string;projectPda:string;receiptMint:string;grossAmountMicroUsd?:string;preview?:unknown};
type Simulation={ok:boolean;feeLamports:string|null;feePayer:string};
type Funding={fundingId:string;status:string;amountMicroUsd:string;errorCode:string|null};
type Round={id:string;phase:string;unitPriceMicroUsd:string;targetMicroUsd:string;closesAt:string;solanaRoundPda:string|null};
type MyProject={id:string;slug:string;ticker:string|null;name:string;status:string;receipt_mint:string|null;round:{id:string;status:string}|null};
type OpenRound={id:string;ticker:string;name:string;slug:string};
type Quote={acceptedMicroUsd:string;feeMicroUsd:string;units:string;refundMicroUsd:string;proRataReduced:boolean};
type Bank={nickname:string;balanceMicroUsd:string|null};
type Portfolio={allocations:{intentId:string;roundId:string;grossAmountMicroUsd:string;acceptedAmountMicroUsd:string;issuedReceiptUnits:string;refundedAmountMicroUsd:string;allocationFinalized:boolean}[];holdings:{projectId:string;receiptBalanceUnits:string}[];pending:{intentId:string;grossAmountMicroUsd:string;status:string}[]};
const terminalFunding=['COMPLETED','BANK_REJECTED','COMPENSATED','NEEDS_REVIEW'];
export default function Participation({mode='wallet'}:{mode?:'wallet'|'manage'}){
  const [status,setStatus]=useState<Status|null>(null),[me,setMe]=useState<Me|null>(null),[wallet,setWallet]=useState('');
  const [email,setEmail]=useState(''),[otp,setOtp]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [amount,setAmount]=useState('10'),[balance,setBalance]=useState<string|null>(null),[funding,setFunding]=useState<Funding|null>(null);
  const [prepared,setPrepared]=useState<Prepared|null>(null),[simulation,setSimulation]=useState<Simulation|null>(null),[tx,setTx]=useState<{signature:string;status:string}|null>(null),[retry,setRetry]=useState<{signedTx:string;intentId:string;signature:string}|null>(null);
  const [roundId,setRoundId]=useState(''),[round,setRound]=useState<Round|null>(null),[valuation,setValuation]=useState<unknown>(null),[quote,setQuote]=useState<Quote|null>(null),[portfolio,setPortfolio]=useState<Portfolio|null>(null),[bank,setBank]=useState<Bank|null>(null);
  const [projectId,setProjectId]=useState('');
  const [mine,setMine]=useState<MyProject[]>([]),[mineLoaded,setMineLoaded]=useState(false),[open,setOpen]=useState<OpenRound[]>([]);
  const run=useCallback(async(action:()=>Promise<void>)=>{setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'The request could not be completed.');}finally{setBusy(false);}},[]);
  const refresh=useCallback(async(address:string)=>{const [b,p]=await Promise.all([api<{amountMicroUsd:string}>(`/wallet/balance?address=${encodeURIComponent(address)}`),api<Portfolio>('/portfolio')]);setBalance(b.amountMicroUsd);setPortfolio(p);},[]);
  useEffect(()=>{const query=new URLSearchParams(window.location.search);setRoundId(query.get('round')??'');setProjectId(query.get('project')??'');let active=true;api<Status>('/status').then(async s=>{if(!active)return;setStatus(s);if(s.backendConfigured){const identity=await api<Me>('/me').catch(()=>null);if(active)setMe(identity);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  useEffect(()=>{if(!me)return;const prefix=`prospecto:${me.identityId}:`;const query=new URLSearchParams(window.location.search);setProjectId(query.get('project')??sessionStorage.getItem(prefix+'project')??'');setRoundId(query.get('round')??sessionStorage.getItem(prefix+'round')??'');const signature=sessionStorage.getItem(prefix+'tx');if(signature)setTx({signature,status:'Unknown'});const saved=sessionStorage.getItem(prefix+'signed');if(saved){try{setRetry(JSON.parse(saved));}catch{sessionStorage.removeItem(prefix+'signed');}}const id=sessionStorage.getItem(prefix+'funding');if(id)api<Funding>(`/funding/${id}`).then(setFunding).catch(()=>undefined);},[me]);
  useEffect(()=>{if(!funding||terminalFunding.includes(funding.status))return;let active=true;const timer=setTimeout(()=>{api<Funding>(`/funding/${funding.fundingId}`).then(f=>{if(active)setFunding(f);}).catch(e=>{if(active)setError(e.message);});},3000);return()=>{active=false;clearTimeout(timer);};},[funding]);
  useEffect(()=>{if(!tx||['Finalized','Failed','Expired'].includes(tx.status))return;let active=true;const timer=setTimeout(()=>{api<{status:string}>(`/transactions/${tx.signature}`).then(v=>{if(active)setTx({signature:tx.signature,status:v.status});}).catch(e=>{if(active)setError(e.message);});},3000);return()=>{active=false;clearTimeout(timer);};},[tx]);
  useEffect(()=>{if(mode!=='wallet')return;api<{projects:{slug:string;name:string;ticker:string|null;round:{id:string;status:string}|null}[]}>('/projects').then(r=>setOpen(r.projects.filter(p=>p.round?.status==='OPEN').map(p=>({id:p.round!.id,ticker:p.ticker??p.name.slice(0,4).toUpperCase(),name:p.name,slug:p.slug})))).catch(()=>undefined);},[mode]);
  const loadMine=useCallback(async()=>{const r=await api<{projects:MyProject[]}>('/me/projects');setMine(r.projects);setMineLoaded(true);setProjectId(id=>id&&r.projects.some(p=>p.id===id)?id:r.projects[0]?.id??'');},[]);
  useEffect(()=>{if(me&&mode==='manage')loadMine().catch(e=>setError(e instanceof Error?e.message:'Your listings could not be loaded.'));},[me,loadMine,mode]);
  async function prepare(path:string,body:unknown){if(!wallet)throw new Error('Connect and verify your wallet first.');const scope=`${me?.identityId}:${wallet}:${path}:${JSON.stringify(body)}`;let p=await api<Prepared>(path,body,actionKey(scope));if(['Expired','Failed'].includes(p.status)){sessionStorage.removeItem(`prospecto:action:${scope}`);p=await api<Prepared>(path,body,actionKey(scope));}setPrepared(p);setSimulation(null);const s=await api<Simulation>(`/transactions/${p.signature}/simulate`,{});setSimulation(s);if(!s.ok)throw new Error('Transaction simulation failed. Refresh your balance and issuance before retrying.');}
  async function bind(){const address=await connectWallet();setWallet('');const challenge=await api<{message:string}>('/wallets/challenge',{address});await api('/wallets/verify',{address,signature:await signProof(challenge.message,address)});setWallet(address);setNotice('Wallet ownership proof accepted.');if(mode==='wallet'&&status?.purchasesEnabled)await refresh(address);if(mode==='wallet'&&status?.nessieEnabled)setBank(await api('/banking/account'));}
  async function loadRound(id=roundId){const result=await api<{round:Round;valuation:unknown}>(`/rounds/${encodeURIComponent(id)}`);setRound(result.round);setValuation(result.valuation);setQuote(null);}
  async function fund(){const gross=dollarsToMicro(amount),key=actionKey(`${me?.identityId}:${wallet}:fund:${gross}`);let f:Funding;try{f=await api('/funding',{walletAddress:wallet,amountMicroUsd:gross},key);}catch(e){const recovered=await api<Funding>('/funding/by-key?key='+encodeURIComponent(key)).catch(()=>null);if(!recovered)throw e;f=recovered;}setFunding(f);sessionStorage.setItem(`prospecto:${me!.identityId}:funding`,f.fundingId);}
  async function resubmit(value:{signedTx:string;intentId:string;signature:string}) {
    const result=await api<{status:string}>('/transactions',{signedTx:value.signedTx,intentId:value.intentId},actionKey(`submit:${me!.identityId}:${value.signature}`));setTx({signature:value.signature,status:result.status});
  }
  async function submit(){if(!prepared||!simulation?.ok)return;const value={signedTx:await signPrepared(prepared.transaction,wallet),intentId:prepared.intentId,signature:prepared.signature};sessionStorage.setItem(`prospecto:${me!.identityId}:tx`,value.signature);sessionStorage.setItem(`prospecto:${me!.identityId}:signed`,JSON.stringify(value));setRetry(value);setTx({signature:value.signature,status:'Unknown'});setPrepared(null);setSimulation(null);await resubmit(value);}

  const sel=mine.find(p=>p.id===projectId);
  const signOut=()=>run(async()=>{await api('/auth/sign-out',{});setMe(null);setWallet('');setBalance(null);setBank(null);setPortfolio(null);setFunding(null);setTx(null);setRetry(null);setPrepared(null);setMine([]);setMineLoaded(false);});
  const short=(a:string)=>`${a.slice(0,4)}…${a.slice(-4)}`;
  return <div className="wallet">
    {error&&<p className="w-msg err" role="alert">{error}</p>}{notice&&<p className="w-msg" role="status">{notice}</p>}
    {!status?error?<button className="w-btn" disabled={busy} onClick={()=>run(async()=>setStatus(await api('/status')))}>Reconnect</button>:<p className="w-dim">Connecting…</p>:!status.backendConfigured?<p className="w-dim">Accounts are temporarily unavailable.</p>:<>
    <section className="w-card"><header><h3>Account</h3>{me&&<button className="w-link" disabled={busy} onClick={signOut}>Sign out</button>}</header>
      {me?<div className="w-grid">
        <div><span className="w-k">Wallet</span><b className="mono">{wallet?short(wallet):'Not connected'}</b></div>
        {mode==='wallet'&&<div><span className="w-k">Cash</span><b className="mono">{balance===null?'—':money(balance)}</b></div>}
        <div className="w-act"><button className="w-btn" disabled={busy} onClick={()=>run(bind)}>{wallet?'Reconnect wallet':'Connect wallet'}</button>{mode==='wallet'&&wallet&&status.purchasesEnabled&&<button className="w-btn ghost" disabled={busy} onClick={()=>run(()=>refresh(wallet))}>Refresh</button>}</div>
      </div>:<div className="w-form">
        <label><span className="w-k">{status.demoMode?'Email or name':'Email'}</span><input type={status.demoMode?'text':'email'} autoComplete="email" placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/></label>
        {status.demoMode?<button className="w-btn" disabled={busy} onClick={()=>run(async()=>{await api('/demo/sign-in',{email});setMe(await api('/me'));})}>Sign in</button>:<><button className="w-btn" disabled={busy} onClick={()=>run(async()=>{await api('/auth/email-otp/send-verification-otp',{email,type:'sign-in'});setNotice('Check your email for the sign-in code.');})}>Email me a code</button><label><span className="w-k">Code</span><input value={otp} autoComplete="one-time-code" onChange={e=>setOtp(e.target.value)}/></label><button className="w-btn" disabled={busy} onClick={()=>run(async()=>{await api('/auth/sign-in/email-otp',{email,otp});setMe(await api('/me'));})}>Sign in</button></>}
      </div>}
    </section>
    {me&&<>
    {mode==='wallet'&&<><section className="w-card"><header><h3>Add cash</h3>{bank&&<span className="w-dim mono">{bank.nickname} · {bank.balanceMicroUsd===null?'—':money(bank.balanceMicroUsd)} in bank</span>}</header>
      <div className="w-form row"><label><span className="w-k">Amount</span><input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setQuote(null);}}/></label>
        <button className="w-btn" disabled={busy||!wallet||!status.nessieEnabled||Boolean(funding&&!terminalFunding.includes(funding.status))} onClick={()=>run(fund)}>Transfer from bank</button></div>
      {!wallet&&<p className="w-dim">Connect a Devnet wallet to add cash.</p>}
      {funding&&<div className="w-status"><span className="mono">{money(funding.amountMicroUsd)}</span><b>{funding.status.replaceAll('_',' ').toLowerCase()}</b>{funding.errorCode&&<span className="err">{funding.errorCode}</span>}
        {!terminalFunding.includes(funding.status)&&<button className="w-link" disabled={busy} onClick={()=>run(async()=>setFunding(await api(`/funding/${funding.fundingId}/resume`,{})))}>Resume</button>}
        {terminalFunding.includes(funding.status)&&<button className="w-link" disabled={busy||funding.status==='NEEDS_REVIEW'} onClick={()=>{sessionStorage.removeItem(`prospecto:action:${me.identityId}:${wallet}:fund:${funding.amountMicroUsd}`);sessionStorage.removeItem(`prospecto:${me.identityId}:funding`);setFunding(null);}}>New transfer</button>}</div>}
    </section>
    <section className="w-card"><header><h3>Primary issuance</h3><span className="w-dim">Commit directly to a company at its fixed model price</span></header>
      <div className="w-pills">{open.map(o=><button key={o.id} className={roundId===o.id?'on':''} onClick={()=>{setRoundId(o.id);setQuote(null);run(()=>loadRound(o.id));}}><b>{o.ticker}</b>{o.name}</button>)}{!open.length&&<span className="w-dim">No primary issuances are open right now.</span>}</div>
      {round&&<>
        <div className="w-grid"><div><span className="w-k">Fixed price</span><b className="mono">{money(round.unitPriceMicroUsd)}</b></div><div><span className="w-k">Target</span><b className="mono">{money(round.targetMicroUsd)}</b></div><div><span className="w-k">Closes</span><b>{new Date(round.closesAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</b></div></div>
        <div className="w-form row"><label><span className="w-k">Amount</span><input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setQuote(null);}}/></label>
          <button className="w-btn ghost" disabled={busy} onClick={()=>run(async()=>setQuote((await api<{quote:Quote}>(`/rounds/${round.id}/quote?gross_micro_usd=${dollarsToMicro(amount)}`)).quote))}>Preview</button>
          <button className="w-btn" disabled={busy||!wallet||!status.purchasesEnabled||round.phase!=='OPEN'||!round.solanaRoundPda} onClick={()=>run(()=>prepare(`/rounds/${round.id}/subscribe/prepare`,{walletAddress:wallet,grossAmountMicroUsd:dollarsToMicro(amount)}))}>Commit</button></div>
        {quote&&<div className="w-grid"><div><span className="w-k">Est. units</span><b className="mono">{Number(quote.units).toLocaleString()}</b></div><div><span className="w-k">Fee</span><b className="mono">{money(quote.feeMicroUsd)}</b></div>{quote.proRataReduced&&<div><span className="w-k">If oversubscribed, refunded</span><b className="mono">{money(quote.refundMicroUsd)}</b></div>}</div>}
        {!round.solanaRoundPda&&<p className="w-dim">This issuance opens for commitments shortly.</p>}
        {valuation!==null&&<p className="w-dim"><a href={investSlugHref(open.find(o=>o.id===round.id)?.slug)}>Why this price →</a></p>}
      </>}
    </section></>}
    {mode==='manage'&&mineLoaded&&mine.length===0&&<section className="w-card"><header><h3>No listings yet</h3></header><p className="w-dim">Create a company listing before setting up its receipt token and primary issuance.</p><a className="w-btn" href={routes.list}>List your company</a></section>}
    {mode==='manage'&&mine.length>0&&<section className="w-card"><header><h3>Your companies</h3>
      <select value={projectId} onChange={e=>{setProjectId(e.target.value);const p=mine.find(m=>m.id===e.target.value);setRoundId(p?.round?.id??'');}}>{mine.map(p=><option key={p.id} value={p.id}>{p.ticker?`${p.ticker} · `:''}{p.name}</option>)}</select></header>
      {sel&&<><div className="w-grid"><div><span className="w-k">Status</span><b>{sel.status.toLowerCase()}</b></div><div><span className="w-k">Receipt token</span><b className="mono">{sel.receipt_mint?short(sel.receipt_mint):'Not created'}</b></div><div><span className="w-k">Issuance</span><b>{sel.round?sel.round.status.toLowerCase():'None'}</b></div></div>
      <ol className="w-steps">
        <li className={sel.status==='PUBLISHED'?'done':''}><span>List publicly</span><button className="w-btn ghost" disabled={busy||sel.status==='PUBLISHED'} onClick={()=>run(async()=>{await api(`/projects/${sel.id}/publish`,{});setNotice(`${sel.name} is listed.`);await loadMine();})}>Publish</button></li>
        <li className={sel.receipt_mint?'done':''}><span>Create receipt token</span><button className="w-btn ghost" disabled={busy||!wallet||!status.purchasesEnabled||Boolean(sel.receipt_mint)} onClick={()=>run(()=>prepare(`/projects/${sel.id}/tokenization/prepare`,{}))}>Create</button></li>
        <li><span>Set issuance terms</span><button className="w-btn ghost" disabled={busy} onClick={()=>run(async()=>{const result=await api<{round:Round}>(`/projects/${sel.id}/rounds`,{},actionKey(`draft:${me.identityId}:${sel.id}`));setRoundId(result.round.id);setRound(result.round);sessionStorage.setItem(`prospecto:${me.identityId}:round`,result.round.id);setNotice('Issuance terms set. Open the issuance once the receipt token is live.');await loadMine();})}>Set terms</button></li>
        <li className={sel.round?.status==='OPEN'?'done':''}><span>Open issuance</span><button className="w-btn" disabled={busy||!roundId||!wallet||!status.purchasesEnabled} onClick={()=>run(()=>prepare(`/rounds/${roundId}/open/prepare`,{}))}>Open</button></li>
      </ol></>}
    </section>}
    {prepared&&<section className="w-card focus"><header><h3>Confirm in your wallet</h3></header>
      <div className="w-grid"><div><span className="w-k">Action</span><b>{prepared.kind}</b></div><div><span className="w-k">Amount</span><b className="mono">{prepared.grossAmountMicroUsd?money(prepared.grossAmountMicroUsd):'—'}</b></div><div><span className="w-k">Network fee</span><b className="mono">{simulation?.feeLamports?`${(Number(simulation.feeLamports)/1e9).toFixed(6)} SOL`:'—'}</b></div><div><span className="w-k">Check</span><b className={simulation?.ok?'up':''}>{simulation?simulation.ok?'Ready':'Failed':'Checking…'}</b></div></div>
      <div className="w-act"><button className="w-btn" disabled={busy||!simulation?.ok} onClick={()=>run(submit)}>Approve in wallet</button><button className="w-btn ghost" disabled={busy} onClick={()=>{setPrepared(null);setSimulation(null);}}>Cancel</button></div>
    </section>}
    {tx&&<section className="w-card"><header><h3>Transaction status</h3><a className="w-link" href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View on Solana ↗</a></header>
      <div className="w-status"><b role="status" className={tx.status==='Finalized'?'up':''}>{tx.status}</b><span className="mono">{short(tx.signature)}</span>
        <button className="w-link" disabled={busy} onClick={()=>run(async()=>{const result=await api<{status:string}>(`/transactions/${tx.signature}`);setTx({signature:tx.signature,status:result.status});if(wallet&&status.purchasesEnabled)await refresh(wallet);})}>Check</button>
        {retry&&retry.signature===tx.signature&&!['Finalized','Failed','Expired'].includes(tx.status)&&<button className="w-link" disabled={busy} onClick={()=>run(()=>resubmit(retry))}>Resend</button>}</div>
    </section>}
    {mode==='wallet'&&portfolio!==null&&(portfolio.allocations.length>0||portfolio.pending.length>0)&&<section className="w-card"><header><h3>Primary commitments</h3></header>
      <div className="rows">{portfolio.pending.map(p=><div key={p.intentId} className="w-row"><span>Pending</span><span className="mono">{money(p.grossAmountMicroUsd)}</span><span>{p.status}</span></div>)}
        {portfolio.allocations.map(a=><div key={a.intentId} className="w-row"><span>{a.allocationFinalized?'Filled':'Committed'}</span><span className="mono">{money(a.acceptedAmountMicroUsd==='0'?a.grossAmountMicroUsd:a.acceptedAmountMicroUsd)}</span><span className="mono">{Number(a.issuedReceiptUnits).toLocaleString()} units</span>{a.refundedAmountMicroUsd!=='0'&&<span className="mono">{money(a.refundedAmountMicroUsd)} refunded</span>}</div>)}</div>
    </section>}
    </>}
    </>}
  </div>;
}
