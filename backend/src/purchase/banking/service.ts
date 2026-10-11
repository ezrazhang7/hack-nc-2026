import type { Store } from '../tokenization/types.js';
import { AppError } from '../http/errors.js';
import { BankError, type Bank, type BankTransfer, type NessieProfile } from './adapter.js';
import { fundingDollars, hash } from './canonical.js';
import { FundingStore, LeaseLost } from './store.js';
import type { Funding, PurchaseChain } from './types.js';

export interface BankingOptions {
  generation: string; enabled: boolean; paused: boolean; treasuryProviderId: string; profile: NessieProfile | null;
}
export class FundingService {
  constructor(readonly store: FundingStore, readonly identity: Store, readonly chain: PurchaseChain,
    readonly options: BankingOptions, readonly bankFor: (profile: NessieProfile) => Bank) {}

  async create(identityId: string, wallet: string, amount: string, key: string) {
    fundingDollars(amount);
    const value = await this.store.create(identityId,wallet,amount,key,this.options);
    return this.response(value);
  }
  async response(value: Funding) {
    const tx = await this.store.latestTx(value.id);
    return {
      fundingId:value.id,status:value.status,mode:'NESSIE',amountMicroUsd:value.amount,walletAddress:value.wallet,
      pollUrl:`/api/funding/${value.id}`,bankReference:value.providerTransferId ? `••••${value.providerTransferId.slice(-4)}` : null,
      mintSignature:value.status==='COMPLETED' && tx?.status!=='Finalized' ? null : tx?.signature ?? null,
      mintAttemptSignature:tx?.signature ?? null,
      completionProof:value.status==='COMPLETED' ? 'FINALIZED_FUNDING_RECEIPT' : null,
      confirmation:value.status==='COMPLETED' ? 'finalized' : value.status==='MINT_CONFIRMED' ? 'confirmed' : null,
      nextAction:value.status==='NEEDS_REVIEW' || (value.status==='COMPLETED' && value.lastError) ? 'CONTACT_OPERATOR' : ['COMPLETED','BANK_REJECTED','COMPENSATED'].includes(value.status) ? 'DONE' : 'POLL',
      errorCode:value.lastError,simulation:true,
    };
  }
  async owned(identityId: string, id: string) {
    const value = await this.store.owned(identityId,id);
    if (!value) throw new AppError('NOT_FOUND','Funding intent not found.',404);
    return this.response(value);
  }
  async byKey(identityId: string, key: string) {
    const value = await this.store.byKey(identityId,key);
    if (!value) throw new AppError('NOT_FOUND','Funding intent not found.',404);
    return this.response(value);
  }
  async account(identityId: string) {
    const mapping = await this.store.mapping(identityId,this.options.generation);
    if (!mapping) throw new AppError('BANK_ACCOUNT_NOT_READY','No demo bank account is mapped to this identity.',409);
    let stale = true;
    if (this.options.profile) {
      try {
        const observation = await this.bankFor(this.options.profile).account(mapping.providerAccountId);
        await this.store.observedAccount(mapping,observation);
        mapping.balanceDollars=observation.dollars.toString(); mapping.observedAt=new Date(); stale=false;
      } catch (error) {
        if (error instanceof AppError && error.code==='BANK_PROOF_MISMATCH') throw error;
      }
    }
    const active = await this.store.active(identityId,this.options.generation);
    return { nickname:mapping.nickname,balanceMicroUsd:mapping.balanceDollars===null ? null : (BigInt(mapping.balanceDollars)*1_000_000n).toString(),
      observedAt:mapping.observedAt?.toISOString() ?? null,activeFunding:active ? await this.response(active) : null,
      mode:'NESSIE',stale,ready:mapping.active && this.options.enabled && !this.options.paused && !await this.store.paused(this.options.generation),simulation:true };
  }
  async activity(identityId: string) {
    const local = await this.store.activity(identityId);
    const mapping = await this.store.mapping(identityId,this.options.generation);
    if (!mapping || !this.options.profile) return { activity:local,bankActivity:[],stale:true,simulation:true };
    const history = await this.bankFor(this.options.profile).history(mapping.providerAccountId);
    const known = new Set(local.map(item => item.id));
    return { activity:local,bankActivity:history.filter(item => item.payerId===mapping.providerAccountId || item.payeeId===mapping.providerAccountId).map(item => {
      const linked = item.tag.startsWith('prospecto:funding:') ? item.tag.slice('prospecto:funding:'.length) : null;
      return { bankReference:`••••${item.id.slice(-4)}`,direction:item.payerId===mapping.providerAccountId ? 'outgoing' : 'incoming',
        amountMicroUsd:(BigInt(item.dollars)*1_000_000n).toString(),state:item.state,fundingId:linked && known.has(linked) ? linked : null };
    }),stale:false,simulation:true };
  }
  private async verified(value: Funding, transfer: BankTransfer) {
    const { source,treasury } = await this.store.accounts(value);
    if (transfer.payerId!==source.providerAccountId || transfer.payeeId!==treasury.providerAccountId
      || transfer.dollars!==fundingDollars(value.amount) || transfer.tag!==value.tag
      || (value.providerTransferId && transfer.id!==value.providerTransferId)) {
      throw new BankError('invalid','BANK_PROOF_MISMATCH');
    }
    if (transfer.state==='unknown') throw new BankError('invalid','BANK_STATUS_UNKNOWN');
    return hash({ version:1,mode:'NESSIE',intentId:value.id,providerTransferId:transfer.id,
      payerId:transfer.payerId,payeeId:transfer.payeeId,amountMicroUsd:value.amount });
  }
  private async complete(value: Funding): Promise<boolean> {
    const receipt = await this.chain.fundingReceipt(value);
    if (!receipt) return false;
    if (receipt.intentId!==value.id || receipt.wallet!==value.wallet || receipt.amount!==value.amount
      || receipt.proofHash!==value.proofHash || receipt.funded!==true) throw new BankError('invalid','FUNDING_RECEIPT_MISMATCH');
    if (!value.proofHash || !value.providerTransferId) throw new BankError('invalid','FUNDING_RECEIPT_MISMATCH');
    const transfer = await this.bankFor(value.profile).transfer(value.providerTransferId);
    await this.store.recordObservation(value,transfer);
    const proof = await this.verified(value,transfer);
    if (transfer.state!=='success' || proof!==value.proofHash) throw new BankError('invalid','BANK_PROOF_MISMATCH');
    const tx=await this.store.latestTx(value.id);
    if (tx) await this.store.txStatus(value,tx,await this.chain.fundingTxStatus(tx));
    await this.store.advance(value,'COMPLETED','RECEIPT_FINALIZED');
    return true;
  }
  async auditCompleted(owner:string):Promise<boolean> {
    const value=await this.store.claimCompleted(owner);if(!value) return false;
    try {
      if(!await this.complete(value)) throw new BankError('invalid','FUNDING_RECEIPT_MISSING');
    } catch(error) {
      if(error instanceof LeaseLost) return true;
      if((error instanceof BankError && error.outcome==='invalid') || (error instanceof AppError && error.code==='CHAIN_STATE_INVALID')) {
        await this.store.review(value,error instanceof AppError ? error.code : 'PROOF_REVIEW');
      }
      console.error(JSON.stringify({operation:'completed_funding_audit',fundingId:value.id,errorCode:error instanceof AppError ? error.code : 'AUDIT_UNAVAILABLE'}));
    } finally {await this.store.release(value);}
    return true;
  }
  async tick(owner: string, identityId?:string, allowDispatch=true): Promise<boolean> {
    const value = await this.store.claim(owner,identityId,allowDispatch); if (!value) return false;
    try { await this.process(value); }
    catch (error) {
      if (error instanceof LeaseLost) return true;
      if ((error instanceof BankError && error.outcome==='invalid') || (error instanceof AppError && ['CHAIN_STATE_INVALID','BANK_PROOF_MISMATCH'].includes(error.code))) {
        try { await this.store.review(value,error instanceof AppError ? error.code : 'PROOF_REVIEW'); } catch (reviewError) { if (!(reviewError instanceof LeaseLost)) throw reviewError; }
      }
      // Transport outages retain the durable phase for a later read/recovery.
      console.error(JSON.stringify({ operation:'funding_recovery',fundingId:value.id,errorCode:error instanceof AppError ? error.code : 'FUNDING_RECOVERY_UNAVAILABLE' }));
    } finally { await this.store.release(value); }
    return true;
  }
  private async process(value: Funding): Promise<void> {
    const bank = this.bankFor(value.profile);
    if (value.status==='CREATED') {
      if (this.options.paused || await this.store.paused(value.generation)) return;
      if (!await this.identity.verifiedWallet(value.identityId,value.wallet)) { await this.store.advance(value,'BANK_REJECTED','WALLET_NOT_VERIFIED'); return; }
      const { source,treasury } = await this.store.accounts(value);
      if (!source.active || !treasury.active) { await this.store.review(value,'BANK_ACCOUNT_FROZEN'); return; }
      const observation = await bank.account(source.providerAccountId);
      await this.store.observedAccount(source,observation);
      const spendable = BigInt(observation.dollars)*1_000_000n - await this.store.otherReservations(value);
      if (spendable<BigInt(value.amount)) { await this.store.advance(value,'BANK_REJECTED','INSUFFICIENT_MOCK_BANK_BALANCE'); return; }
      await this.store.dispatch(value,hash({ payerId:source.providerAccountId,payeeId:treasury.providerAccountId,amount:value.amount,tag:value.tag }));
      try {
        const id = await bank.createTransfer(source.providerAccountId,treasury.providerAccountId,fundingDollars(value.amount),value.tag);
        await this.store.bindTransferId(value,id);
        await this.store.advance(value,'BANK_PENDING','BANK_READ_BACK_REQUIRED');
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        if (error instanceof AppError && error.code==='BANK_PROOF_MISMATCH') {await this.store.review(value,error.code);return;}
        await this.store.advance(value,error instanceof BankError && error.outcome==='no-effect' ? 'BANK_REJECTED' : 'BANK_UNKNOWN',
          error instanceof BankError && error.outcome==='no-effect' ? 'BANK_REJECTED' : 'BANK_WRITE_UNKNOWN');
      }
      return;
    }
    if (['BANK_DISPATCHED','BANK_PENDING','BANK_UNKNOWN'].includes(value.status)) {
      let transfer: BankTransfer | null = null;
      if (value.providerTransferId) transfer=await bank.transfer(value.providerTransferId);
      else {
        const { source } = await this.store.accounts(value);
        const matches = (await bank.history(source.providerAccountId)).filter(item => item.tag===value.tag);
        if (matches.length>1) { await this.store.review(value,'DUPLICATE_BANK_TRANSFERS'); return; }
        transfer=matches[0] ?? null;
      }
      if (!transfer) {
        if (value.status==='BANK_DISPATCHED') await this.store.advance(value,'BANK_UNKNOWN','BANK_WRITE_UNKNOWN');
        return;
      }
      await this.store.recordObservation(value,transfer);
      const proof = await this.verified(value,transfer);
      await this.store.bindTransferId(value,transfer.id);
      await this.store.observeTransfer(value,transfer,transfer.state==='success' ? proof : null);
      return;
    }
    if (value.status==='BANK_CONFIRMED') {
      if (await this.complete(value)) return;
      if (!value.providerTransferId || !value.proofHash) throw new BankError('invalid','BANK_PROOF_MISMATCH');
      const transfer = await bank.transfer(value.providerTransferId);
      await this.store.recordObservation(value,transfer);
      if (transfer.state!=='success' || await this.verified(value,transfer)!==value.proofHash) throw new BankError('invalid','BANK_PROOF_MISMATCH');
      await this.store.saveTx(value,await this.chain.prepareFunding(value));
      return;
    }
    if (['MINT_PREPARED','MINT_SUBMITTED','MINT_CONFIRMED'].includes(value.status)) {
      if (await this.complete(value)) return;
      const tx = await this.store.latestTx(value.id);
      if (!tx) throw new AppError('CHAIN_STATE_INVALID','Missing guarded mint attempt.',503);
      const status = await this.chain.fundingTxStatus(tx);
      await this.store.txStatus(value,tx,status);
      if (status==='Finalized') throw new AppError('CHAIN_STATE_INVALID','Finalized funding has no matching receipt.',503);
      if (status==='Expired' || status==='Failed') {
        // Expiry/history and finalized receipt absence were checked; same intent PDA guards any new signature.
        await this.store.saveTx(value,await this.chain.prepareFunding(value)); return;
      }
      if (status==='Confirmed') {
        if (value.status!=='MINT_CONFIRMED') await this.store.advance(value,'MINT_CONFIRMED','MINT_CONFIRMED');
        return;
      }
      if (value.status==='MINT_PREPARED') await this.store.advance(value,'MINT_SUBMITTED','MINT_DISPATCH_RESERVED');
      // Identical signed bytes are safe to resubmit; bank POSTs are never repeated.
      try { await this.chain.submit(Buffer.from(tx.transaction,'base64')); }
      catch { /* Receipt/signature reconciliation owns the outcome. */ }
    }
  }
}
