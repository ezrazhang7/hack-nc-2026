import { createHash } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Chain, Intent, Prepared, Project, Receipt, Status } from '../../src/purchase/tokenization/types.js';
import { validateSigned } from '../../src/purchase/solana/signed-transaction.js';

export const founder = Keypair.generate();
export const relayer = Keypair.generate();
export const projectId = '00000000-0000-4000-8000-000000000001';
export const identityId = '00000000-0000-4000-8000-000000000002';
export const sessionToken = 'ab'.repeat(32);
export const sessionHash = createHash('sha256').update(sessionToken).digest('hex');

export function preparedTransaction(): Prepared {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: relayer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: founder.publicKey, toPubkey: relayer.publicKey, lamports: 1 })],
  }).compileToV0Message());
  tx.sign([relayer]);
  return {
    transaction: Buffer.from(tx.serialize()).toString('base64'), message: Buffer.from(tx.message.serialize()).toString('base64'),
    signature: bs58.encode(tx.signatures[0]!), lastValidBlockHeight: 100,
    projectPda: Keypair.generate().publicKey.toBase58(), receiptMint: Keypair.generate().publicKey.toBase58(),
  };
}
export function sign(prepared: Pick<Prepared,'transaction'>): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
  tx.sign([founder]);
  return Buffer.from(tx.serialize()).toString('base64');
}
export function testIntent(): Intent {
  return {
    ...preparedTransaction(), id: '00000000-0000-4000-8000-000000000003', identityId, projectId,
    requestKey: 'test-key-0001', requestHash: 'test-hash', status: 'Prepared',
    kind: 'Tokenize', roundPda: null, buyerWallet: null,
  };
}
export class TestChain implements Chain {
  prepared = preparedTransaction();
  currentStatus: Status = 'Prepared';
  minted: Receipt | null = null;
  submitted = 0;
  failSubmit = false;
  async prepareProject(_project: Project) { return this.prepared; }
  validateSigned = validateSigned;
  async submit(_raw: Uint8Array) {
    this.submitted++;
    if (this.failSubmit) throw new Error('RPC URL?key=private-secret');
    this.currentStatus = 'Submitted';
  }
  async status(_intent: Intent) { return this.currentStatus; }
  async receipt(_projectId: string) { return this.minted; }
  async balance(_projectId: string, _wallet: string) { return '99'; }
  async prepareSettlement(_roundPda: string, _buyerWallet: string) { return { ...this.prepared, projectId }; }
  async settled(_roundPda: string, _buyerWallet: string) { return this.currentStatus === 'Finalized'; }
  finalize() {
    this.currentStatus = 'Finalized';
    this.minted = {
      projectPda: this.prepared.projectPda, receiptMint: this.prepared.receiptMint,
      supply: '0', decimals: 0, nonTransferable: true, simulation: true, confirmation: 'finalized',
    };
  }
}
