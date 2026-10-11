import type { NessieProfile } from './adapter.js';
import type { Prepared, Status, Chain } from '../tokenization/types.js';

export type FundingStatus = 'CREATED' | 'BANK_DISPATCHED' | 'BANK_PENDING' | 'BANK_UNKNOWN' | 'BANK_CONFIRMED'
  | 'BANK_REJECTED' | 'MINT_PREPARED' | 'MINT_SUBMITTED' | 'MINT_CONFIRMED' | 'COMPLETED' | 'NEEDS_REVIEW'
  | 'COMPENSATION_PREPARED' | 'COMPENSATION_PENDING' | 'COMPENSATION_UNKNOWN' | 'COMPENSATED';
export interface AccountMapping {
  id: string; generation: string; identityId: string | null; role: 'PARTICIPANT' | 'TREASURY';
  providerAccountId: string; providerCustomerId: string; nickname: string; active: boolean;
  balanceDollars: string | null; observedAt: Date | null;
}
export interface Funding {
  id: string; generation: string; identityId: string; wallet: string; amount: string;
  sourceId: string; treasuryId: string; key: string; requestHash: string;
  status: FundingStatus; tag: string; profile: NessieProfile; proofHash: string | null;
  providerTransferId: string | null; lastError: string | null;
  leaseOwner: string | null; fence: number; pollCount: number;
}
export interface FundingTx {
  transaction: string; messageHash: string; signature: string; blockhash: string; lastValidBlockHeight: number; status: Status;
}
export interface FundingProof { intentId: string; wallet: string; amount: string; mint: string; proofHash: string; funded: true }
export interface RoundInfo {
  address: string; projectId: string; projectPda: string; founderWallet: string;
  opensAt: string; closesAt: string; price: string; maxUnits: string; target: string; totalCommitted: string;
  maxSubscription: string; status: string; paused: boolean;
}
export interface SubscriptionState {
  gross: string; accepted: string; units: string; refundedAmount: string; minted: boolean; refunded: boolean;
}
export interface PurchaseChain extends Chain {
  prepareFunding(intent: Funding): Promise<FundingTx>;
  fundingReceipt(intent: Funding): Promise<FundingProof | null>;
  fundingTxStatus(tx: FundingTx): Promise<Status>;
  paymentBalance(wallet: string): Promise<string>;
  roundInfo(address: string): Promise<RoundInfo>;
  prepareSubscription(round: RoundInfo, wallet: string, amount: string): Promise<Prepared>;
  subscriptionState(roundAddress: string, wallet: string): Promise<SubscriptionState | null>;
}
