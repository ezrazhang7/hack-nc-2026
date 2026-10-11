import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import type { Chain, Intent, Store } from './types.js';
import type { PurchaseChain } from '../banking/types.js';

export function preparedResponse(value: Intent) {
  return {
    intentId: value.id, projectId: value.projectId, signature: value.signature,
    kind: value.kind,
    status: value.status, transaction: value.transaction,
    lastValidBlockHeight: value.lastValidBlockHeight,
    projectPda: value.projectPda, receiptMint: value.receiptMint,
    simulation: true, cluster: 'devnet',
  };
}

export class TokenizationService {
  constructor(readonly store: Store, readonly chain: Chain) {}
  async prepare(identityId: string, projectId: string, key: string) {
    const project = await this.store.project(projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found.', 404);
    if (project.founderIdentityId !== identityId) throw new AppError('FORBIDDEN', 'Only the founder may tokenize this project.', 403);
    if (!await this.store.verifiedWallet(identityId, project.founderWallet)) {
      throw new AppError('WALLET_NOT_VERIFIED', 'Verify the founder wallet before tokenization.', 409);
    }
    const hash = createHash('sha256').update(JSON.stringify({ kind: 'Tokenize', projectId, founderWallet: project.founderWallet })).digest('hex');
    const previous = await this.store.findByKey(identityId, key);
    if (previous) {
      if (previous.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This request key was used for different inputs.', 409);
      return preparedResponse(previous);
    }
    if (await this.chain.receipt(projectId)) throw new AppError('ALREADY_TOKENIZED', 'Project tokenization is finalized.', 409);
    const prepared = await this.chain.prepareProject(project);
    const saved = await this.store.reserve({
      ...prepared, id: randomUUID(), projectId, identityId, requestKey: key, requestHash: hash, status: 'Prepared',
      kind: 'Tokenize', roundPda: null, buyerWallet: null,
    });
    return preparedResponse(saved);
  }

  async prepareSettlement(identityId: string, roundPda: string, buyerWallet: string, key: string) {
    if (!await this.store.verifiedWallet(identityId, buyerWallet)) throw new AppError('FORBIDDEN', 'Wallet does not belong to this identity.', 403);
    const hash = createHash('sha256').update(JSON.stringify({ kind: 'Settle', roundPda, buyerWallet })).digest('hex');
    const previous = await this.store.findByKey(identityId, key);
    if (previous) {
      if (previous.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This request key was used for different inputs.', 409);
      return preparedResponse(previous);
    }
    const prepared = await this.chain.prepareSettlement(roundPda, buyerWallet);
    if (!await this.store.project(prepared.projectId)) throw new AppError('NOT_FOUND', 'Project not found.', 404);
    const saved = await this.store.reserve({
      ...prepared, kind: 'Settle', roundPda, buyerWallet, id: randomUUID(), identityId,
      requestKey: key, requestHash: hash, status: 'Prepared',
    });
    return preparedResponse(saved);
  }

  async submit(identityId: string, signature: string, signedTx: string, key: string) {
    const value = await this.owned(identityId, signature);
    const raw = this.chain.validateSigned(value, signedTx);
    await this.store.submissionKey(identityId, key, createHash('sha256').update(raw).digest('hex'));
    if (value.status === 'Finalized') return { signature, status: 'Finalized' as const, simulation: true };
    if (value.status === 'Confirmed') return { signature, status: 'Confirmed' as const, simulation: true };
    if (['Failed', 'Expired'].includes(value.status)) throw new AppError('TRANSACTION_EXPIRED', 'Prepare a new transaction with a new request key.', 409);
    // Persist dispatch before touching RPC. A transport error is an uncertain result.
    await this.store.markSubmitted(value.id,signedTx);
    try { await this.chain.submit(raw); }
    catch {
      await this.store.observe({ ...value, status: 'Submitted' }, 'Unknown', null);
      return { signature, status: 'Unknown' as const, simulation: true };
    }
    return { signature, status: 'Submitted' as const, simulation: true };
  }

  private async owned(identityId: string, signature: string) {
    const value = await this.store.findBySignature(identityId, signature);
    if (!value) throw new AppError('NOT_FOUND', 'Transaction not found.', 404);
    return value;
  }
  async reconcile(value: Intent) {
    if (['Failed', 'Expired', 'Finalized'].includes(value.status)) return value.status;
    let status = await this.chain.status(value);
    if (status==='Expired' && value.kind==='Subscribe' && value.roundPda && value.buyerWallet) {
      const subscription=await (this.chain as PurchaseChain).subscriptionState(value.roundPda,value.buyerWallet);
      if (subscription) {
        if (subscription.gross!==value.grossAmountMicroUsd) throw new AppError('CHAIN_STATE_INVALID','Expired attempt has a mismatching subscription account.',503);
        status='Finalized';
      }
    }
    const receipt = status === 'Finalized' ? await this.chain.receipt(value.projectId) : null;
    if (status === 'Finalized' && !receipt) throw new AppError('CHAIN_STATE_INVALID', 'Finalized transaction has no valid project receipt.', 503);
    if (status === 'Finalized' && value.kind === 'Settle') {
      if (!value.roundPda || !value.buyerWallet || !await this.chain.settled(value.roundPda, value.buyerWallet)) {
        throw new AppError('CHAIN_STATE_INVALID', 'The allocation and refund are not finalized.', 503);
      }
    }
    if (status==='Finalized' && value.kind==='Subscribe') {
      const chain=this.chain as PurchaseChain;
      if (!value.roundPda || !value.buyerWallet || !value.grossAmountMicroUsd || typeof chain.subscriptionState!=='function') throw new AppError('CHAIN_STATE_INVALID','Invalid subscription intent.',503);
      const subscription=await chain.subscriptionState(value.roundPda,value.buyerWallet);
      if (!subscription || subscription.gross!==value.grossAmountMicroUsd) throw new AppError('CHAIN_STATE_INVALID','Finalized subscription does not match the prepared commitment.',503);
    }
    await this.store.observe(value, status, receipt);
    return status;
  }
  async transaction(identityId: string, signature: string) {
    const value = await this.owned(identityId, signature);
    await this.reconcile(value);
    const current = await this.owned(identityId, signature);
    return { signature, intentId: current.id, projectId: current.projectId, status: current.status, simulation: true };
  }
  async recover(value:Intent) {
    const status=await this.reconcile(value);
    if(!['Submitted','Unknown'].includes(status) || !this.store.signedTransaction) return status;
    const signed=await this.store.signedTransaction(value.id);
    if(!signed) return status;
    // Reuse the exact wallet-authorized bytes after a crash; do not prepare another commitment.
    const raw=this.chain.validateSigned(value,signed);
    try {await this.chain.submit(raw);} catch { /* Reconciliation remains authoritative. */ }
    return status;
  }
}
