import { randomUUID } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { AppError } from '../http/errors.js';
import { hash } from '../banking/canonical.js';
import type { PurchaseChain } from '../banking/types.js';
import type { Store } from '../tokenization/types.js';
import { preparedResponse,TokenizationService } from '../tokenization/service.js';
import { allocation,u64 } from './allocation.js';
import { PurchaseStore, type SubscriptionIntent } from './purchase-store.js';

export class PurchaseService {
  readonly transactions:TokenizationService;
  constructor(readonly store:PurchaseStore,readonly identity:Store,readonly chain:PurchaseChain) {this.transactions=new TokenizationService(identity,chain);}
  async prepare(identityId:string,roundId:string,wallet:string,gross:string,key:string) {
    u64(gross);
    const fingerprint=hash({operation:'subscribe',roundId,walletAddress:wallet,grossAmountMicroUsd:gross});
    const cached=await this.store.byKey(identityId,key);
    if (cached) {
      if (cached.requestHash!==fingerprint) throw new AppError('IDEMPOTENCY_CONFLICT','Subscription key was used for different inputs.',409);
      if (cached.chainIntentId) {
        const tx=await this.identity.findByKey(identityId,hash({operation:'subscription-attempt',id:cached.id,ordinal:cached.ordinal}));
        if (tx && !['Expired','Failed'].includes(tx.status)) return this.prepared(cached,tx);
      }
    }
    const mapping=await this.store.round(roundId);if (!mapping) throw new AppError('NOT_FOUND','Round not found.',404);
    if(!mapping.address) throw new AppError('ROUND_NOT_DEPLOYED','Participation is not enabled for this round yet.',409);
    await this.store.eligibility(identityId,roundId,wallet);
    const round=await this.chain.roundInfo(mapping.address);
    if (round.projectId!==mapping.projectId) throw new AppError('CHAIN_STATE_INVALID','Round mapping mismatch.',503);
    if (round.paused || round.status!=='open') throw new AppError('ROUND_NOT_OPEN','Round is not open.',409);
    if (BigInt(gross)<BigInt(round.price) || BigInt(gross)>BigInt(round.maxSubscription)) throw new AppError('OVER_IDENTITY_CAP','Commitment is outside this round’s limits.',409);
    // Persist identity/round reservation before issuing any relayer signature.
    const logical=await this.store.reserve(identityId,roundId,wallet,gross,key,fingerprint);
    if (logical.chainIntentId) {
      const records=await this.identity.findByKey(identityId,hash({operation:'subscription-attempt',id:logical.id,ordinal:logical.ordinal}));
      if (!records || records.id!==logical.chainIntentId) throw new AppError('CHAIN_STATE_INVALID','Subscription preparation requires recovery.',503);
      await this.transactions.reconcile(records);
      const current=await this.identity.findBySignature(identityId,records.signature);
      if (!current) throw new AppError('CHAIN_STATE_INVALID','Subscription attempt not found.',503);
      if (!['Expired','Failed'].includes(current.status)) return this.prepared(logical,current);
      // Preserve the identity reservation; only the transaction attempt is refreshed.
      if (await this.chain.subscriptionState(mapping.address,wallet)) throw new AppError('ALREADY_SUBSCRIBED','Subscription exists on-chain; reconcile it before retrying.',409);
    }
    const existing=await this.chain.subscriptionState(mapping.address,wallet);
    if (existing) throw new AppError('ALREADY_SUBSCRIBED','This wallet already subscribed to the round.',409);
    const tx=await this.chain.prepareSubscription(round,wallet,gross);
    const preview=allocation({grossAmountMicroUsd:gross,totalCommittedMicroUsd:(BigInt(round.totalCommitted)+BigInt(gross)).toString(),unitPriceMicroUsd:round.price,maxUnits:round.maxUnits});
    const internalKey=hash({operation:'subscription-attempt',id:logical.id,ordinal:logical.ordinal+1});
    const chainIntent=await this.identity.reserve({...tx,id:randomUUID(),kind:'Subscribe',identityId,projectId:round.projectId,
      roundPda:round.address,buyerWallet:wallet,grossAmountMicroUsd:gross,requestKey:internalKey,requestHash:fingerprint,status:'Prepared'});
    const bound=await this.store.bind(logical,chainIntent.id,preview);
    return this.prepared(bound,chainIntent);
  }
  private prepared(logical:SubscriptionIntent,tx:Parameters<typeof preparedResponse>[0]) {
    return {...preparedResponse(tx),intentId:logical.id,attemptId:tx.id,roundId:logical.roundId,walletAddress:logical.wallet,
      grossAmountMicroUsd:logical.gross,blockhash:VersionedTransaction.deserialize(Buffer.from(tx.transaction,'base64')).message.recentBlockhash,
      preview:logical.preview,provisional:true,allocationTiming:'AFTER_ROUND_CLOSE'};
  }
  async submit(identityId:string,logicalId:string,signature:string,signedTx:string,key:string) {
    const logical=await this.store.owned(identityId,logicalId);
    if (!logical || !await this.store.chainSignatureOwned(identityId,logicalId,signature)) throw new AppError('NOT_FOUND','Subscription transaction not found.',404);
    if (!await this.identity.verifiedWallet(identityId,logical.wallet)) throw new AppError('WALLET_NOT_VERIFIED','Verify the subscribing wallet.',409);
    return {...await this.transactions.submit(identityId,signature,signedTx,key),pollUrl:`/api/transactions/${signature}`};
  }
  async refresh(logical:SubscriptionIntent) {
    if (!logical.chainIntentId) {await this.prepare(logical.identityId,logical.roundId,logical.wallet,logical.gross,logical.key);return;}
    const value=await this.identity.findByKey(logical.identityId,hash({operation:'subscription-attempt',id:logical.id,ordinal:logical.ordinal}));
    if (!value) return;
    await this.transactions.reconcile(value);
    const current=await this.identity.findBySignature(logical.identityId,value.signature);
    if (current?.status!=='Finalized') return;
    const mapping=await this.store.round(logical.roundId);if (!mapping) return;
    const [round,state]=await Promise.all([this.chain.roundInfo(mapping.address),this.chain.subscriptionState(mapping.address,logical.wallet)]);
    if (state) await this.store.mirror(logical,round,state,current.signature);
  }
  async crank(logical:SubscriptionIntent) {
    const committed=await this.identity.findByKey(logical.identityId,hash({operation:'subscription-attempt',id:logical.id,ordinal:logical.ordinal}));
    if (!committed || committed.status!=='Finalized') return;
    const mapping=await this.store.round(logical.roundId);if (!mapping) return;
    const state=await this.chain.subscriptionState(mapping.address,logical.wallet);if (!state || (state.minted && state.refunded)) return;
    const selection=await this.store.settlementAttempt(mapping.address,logical.wallet);
    let tx=selection.key ? await this.identity.findByKey(logical.identityId,selection.key) : null;
    if (!tx) {
      const prepared=await this.chain.prepareSettlement(mapping.address,logical.wallet);
      const key=hash({operation:'automatic-settlement',id:logical.id,ordinal:selection.ordinal});
      tx=await this.identity.reserve({...prepared,id:randomUUID(),identityId:logical.identityId,projectId:prepared.projectId,
        kind:'Settle',roundPda:mapping.address,buyerWallet:logical.wallet,requestKey:key,requestHash:hash({round:mapping.address,wallet:logical.wallet}),status:'Prepared'});
    }
    if (!['Finalized','Failed','Expired'].includes(tx.status)) await this.transactions.submit(logical.identityId,tx.signature,tx.transaction,hash({operation:'settlement-submit',signature:tx.signature}));
  }
  async portfolio(identityId:string,roundId?:string) {
    for (const logical of await this.store.list(identityId)) if (!roundId || logical.roundId===roundId) await this.refresh(logical);
    const rows=await this.store.rows(identityId,roundId);
    const holdings=new Map<string,{projectId:string;walletAddress:string;receiptBalanceUnits:string}>();
    for (const row of rows) {
      const key=`${row.project_id}:${row.wallet}`;
      if (!holdings.has(key)) holdings.set(key,{projectId:row.project_id,walletAddress:row.wallet,receiptBalanceUnits:await this.chain.balance(row.project_id,row.wallet)});
    }
    const pending=[];
    for (const logical of await this.store.list(identityId)) {
      if (rows.some(row=>row.id===logical.id) || (roundId && logical.roundId!==roundId)) continue;
      const tx=logical.chainIntentId ? await this.identity.findByKey(identityId,hash({operation:'subscription-attempt',id:logical.id,ordinal:logical.ordinal})) : null;
      pending.push({intentId:logical.id,roundId:logical.roundId,walletAddress:logical.wallet,grossAmountMicroUsd:logical.gross,status:tx?.status ?? 'Preparing'});
    }
    return {allocations:rows.map(row=>({intentId:row.id,projectId:row.project_id,roundId:row.round_id,walletAddress:row.wallet,
      grossAmountMicroUsd:row.gross_amount,acceptedAmountMicroUsd:row.accepted_amount,feeMicroUsd:row.fee_amount,
      founderRewardMicroUsd:row.founder_reward,issuedReceiptUnits:row.allocated_units,refundedAmountMicroUsd:row.refunded_amount,
      allocationFinalized:row.minted,refundFinalized:row.refunded,roundStatus:row.round_status,signature:row.signature,confirmation:'finalized'})),
      holdings:[...holdings.values()],pending,simulation:true};
  }
}
