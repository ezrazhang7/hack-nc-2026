export type Status = 'Prepared' | 'Submitted' | 'Unknown' | 'Confirmed' | 'Finalized' | 'Failed' | 'Expired';
export interface Project {
  id: string;
  founderIdentityId: string;
  founderWallet: string;
}
export interface Receipt {
  projectPda: string;
  receiptMint: string;
  supply: string;
  decimals: 0;
  nonTransferable: true;
  simulation: true;
  confirmation: 'finalized';
}
export interface Prepared {
  transaction: string;
  message: string;
  signature: string;
  lastValidBlockHeight: number;
  projectPda: string;
  receiptMint: string;
}
export interface Intent extends Prepared {
  kind: 'Tokenize' | 'Settle' | 'Subscribe' | 'Open';
  grossAmountMicroUsd?: string;
  roundPda: string | null;
  buyerWallet: string | null;
  id: string;
  projectId: string;
  identityId: string;
  requestKey: string;
  requestHash: string;
  status: Status;
}
export interface Chain {
  simulate?(intent:Intent):Promise<{ok:boolean;unitsConsumed:number|null;feeLamports:string|null;feePayer:string;network:string;errorCode:string|null}>;
  prepareProject(project: Project): Promise<Prepared>;
  validateSigned(intent: Intent, signedTx: string): Uint8Array;
  submit(raw: Uint8Array): Promise<void>;
  status(intent: Intent): Promise<Status>;
  receipt(projectId: string): Promise<Receipt | null>;
  balance(projectId: string, wallet: string): Promise<string>;
  prepareSettlement(roundPda: string, buyerWallet: string): Promise<Prepared & { projectId: string }>;
  settled(roundPda: string, buyerWallet: string): Promise<boolean>;
}
export interface Store {
  session(token: string): Promise<string | null>;
  project(id: string): Promise<Project | null>;
  verifiedWallet(identityId: string, wallet: string): Promise<boolean>;
  findByKey(identityId: string, key: string): Promise<Intent | null>;
  reserve(intent: Intent): Promise<Intent>;
  findBySignature(identityId: string, signature: string): Promise<Intent | null>;
  markSubmitted(id: string, signedTx?: string): Promise<void>;
  signedTransaction?(id:string):Promise<string|null>;
  observe(intent: Intent, status: Status, receipt: Receipt | null): Promise<void>;
  pending(): Promise<Intent[]>;
  submissionKey(identityId: string, key: string, hash: string): Promise<void>;
  rateLimit(identityId: string, limit: number): Promise<boolean>;
}
