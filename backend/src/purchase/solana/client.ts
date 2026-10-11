import { readFile } from 'node:fs/promises';
import { BN, BorshAccountsCoder, BorshEventCoder, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
  getExtensionTypes, getNonTransferable, unpackAccount, unpackMint,
} from '@solana/spl-token';
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { AppError } from '../http/errors.js';
import type { Chain, Intent, Prepared, Project, Receipt, Status } from '../tokenization/types.js';
import { projectAddresses } from './addresses.js';
import { validateSigned } from './signed-transaction.js';
import type { Funding, FundingProof, FundingTx, PurchaseChain, RoundInfo, SubscriptionState } from '../banking/types.js';
import { fundingDollars } from '../banking/canonical.js';
import { createHash } from 'node:crypto';
import { u64 } from '../rounds/allocation.js';
import type { ChainEvent } from '../indexing/indexer.js';
import type { RoundRow } from '../../rounds/service.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const normalize = (name: string) => name.replaceAll('_', '').toLowerCase();
function field(account: unknown, name: string): unknown {
  if (typeof account !== 'object' || account === null) return undefined;
  return Object.entries(account).find(([key]) => normalize(key) === normalize(name))?.[1];
}
function keyEquals(value: unknown, expected: PublicKey): boolean {
  return value instanceof PublicKey && value.equals(expected);
}
function invalidState(): never {
  throw new AppError('CHAIN_STATE_INVALID', 'The program or receipt does not match the tokenization contract.', 503);
}
function eventData(value:unknown):unknown {
  // Normalize before JSON serialization: BN.toJSON emits hexadecimal strings.
  if (value instanceof BN) return String(value);
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value==='bigint') return value.toString();
  if (Array.isArray(value)) return value.map(eventData);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,eventData(item)]));
  return value;
}

export class SolanaChain implements Chain, PurchaseChain {
  private readonly instructions: BorshInstructionCoder;
  private readonly accounts: BorshAccountsCoder;
  private readonly createInstruction: Idl['instructions'][number];
  private checkedAt = 0;
  private async rpc<T>(result: Promise<T>): Promise<T> {
    try { return await result; }
    catch { throw new AppError('CHAIN_UNAVAILABLE', 'The Solana RPC service is unavailable. Try again later.', 503); }
  }
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    private readonly paymentMint: PublicKey,
    private readonly relayer: Keypair,
    private readonly idl: Idl,
  ) {
    if (idl.address !== programId.toBase58()) throw new Error('IDL address must match PROGRAM_ID.');
    const instruction = idl.instructions.find(item => normalize(item.name) === 'createproject');
    const arg = instruction?.args[0];
    if (!instruction || instruction.args.length !== 1 || !arg || normalize(arg.name) !== 'projectid'
      || JSON.stringify(arg.type) !== JSON.stringify({ array: ['u8', 16] })) {
      throw new Error('IDL must define create_project(project_id: [u8; 16]).');
    }
    const expected = new Map([
      ['config', [false, false]], ['project', [true, false]], ['receiptmint', [true, false]],
      ['projectvault', [true, false]], ['founderrewardvault', [true, false]],
      ['founder', [false, true]], ['relayer', [true, true]], ['paymentmint', [false, false]],
      ['tokenprogram', [false, false]], ['associatedtokenprogram', [false, false]],
      ['systemprogram', [false, false]],
    ]);
    if (instruction.accounts.length !== expected.size) throw new Error('Unexpected create_project accounts.');
    const seen = new Set<string>();
    for (const account of instruction.accounts) {
      const name = normalize(account.name);
      const flags = expected.get(name);
      if ('accounts' in account || !flags || seen.has(name) || Boolean(account.writable) !== flags[0]
        || Boolean(account.signer) !== flags[1]) throw new Error('Invalid create_project account contract.');
      seen.add(name);
    }
    this.createInstruction = instruction;
    this.instructions = new BorshInstructionCoder(idl);
    this.accounts = new BorshAccountsCoder(idl);
    for (const name of ['config', 'project']) {
      if (!idl.accounts?.some(account => normalize(account.name) === name)) throw new Error(`IDL is missing ${name}.`);
    }
  }

  static async fromConfig(config: {
    rpcUrl: string; programId: string; paymentMint: string; relayerSecretKey: string; idlPath?: string; idl?: Idl;
  }) {
    const idl = config.idl ?? JSON.parse(await readFile(config.idlPath!, 'utf8')) as Idl;
    return new SolanaChain(new Connection(config.rpcUrl, 'finalized'), new PublicKey(config.programId),
      new PublicKey(config.paymentMint), Keypair.fromSecretKey(bs58.decode(config.relayerSecretKey)), idl);
  }

  private async devnet() {
    if (Date.now() - this.checkedAt < 60_000) return;
    if (await this.rpc(this.connection.getGenesisHash()) !== DEVNET_GENESIS) {
      throw new AppError('CHAIN_UNAVAILABLE', 'Tokenization requires Solana Devnet.', 503);
    }
    this.checkedAt = Date.now();
  }

  private decode(name: string, data: Buffer): unknown {
    const account = this.idl.accounts?.find(item => normalize(item.name) === name);
    if (!account) return invalidState();
    try { return this.accounts.decode(account.name, data) as unknown; }
    catch { return invalidState(); }
  }

  async prepareProject(project: Project): Promise<Prepared> {
    await this.devnet();
    const addresses = projectAddresses(this.programId, project.id);
    const founder = new PublicKey(project.founderWallet);
    if (founder.equals(this.relayer.publicKey)) throw new AppError('INVALID_INPUT', 'Founder must use a personal wallet.');
    const config = await this.rpc(this.connection.getAccountInfo(addresses.config, 'finalized'));
    if (!config?.owner.equals(this.programId)) return invalidState();
    const protocol = this.decode('config', config.data);
    if (!keyEquals(field(protocol, 'relayer'), this.relayer.publicKey)
      || !keyEquals(field(protocol, 'payment_mint'), this.paymentMint)) return invalidState();
    if (field(protocol, 'paused') !== false) throw new AppError('PROTOCOL_PAUSED', 'Tokenization is paused.', 409);
    const values: Record<string, PublicKey> = {
      config: addresses.config, project: addresses.project, receiptmint: addresses.receiptMint,
      projectvault: addresses.projectVault, founderrewardvault: addresses.founderRewardVault,
      founder, relayer: this.relayer.publicKey, paymentmint: this.paymentMint,
      tokenprogram: TOKEN_2022_PROGRAM_ID, associatedtokenprogram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemprogram: SystemProgram.programId,
    };
    const arg = this.createInstruction.args[0];
    if (!arg) return invalidState();
    const instruction = new TransactionInstruction({
      programId: this.programId,
      data: this.instructions.encode(this.createInstruction.name, { [arg.name]: [...addresses.bytes] }),
      keys: this.createInstruction.accounts.map(account => {
        if ('accounts' in account) return invalidState();
        const pubkey = values[normalize(account.name)];
        if (!pubkey) return invalidState();
        return { pubkey, isWritable: Boolean(account.writable), isSigner: Boolean(account.signer) };
      }),
    });
    const block = await this.rpc(this.connection.getLatestBlockhash('finalized'));
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: this.relayer.publicKey, recentBlockhash: block.blockhash, instructions: [instruction],
    }).compileToV0Message());
    tx.sign([this.relayer]);
    const signature = tx.signatures[0];
    if (!signature) return invalidState();
    return {
      transaction: Buffer.from(tx.serialize()).toString('base64'),
      message: Buffer.from(tx.message.serialize()).toString('base64'),
      signature: bs58.encode(signature), lastValidBlockHeight: block.lastValidBlockHeight,
      projectPda: addresses.project.toBase58(), receiptMint: addresses.receiptMint.toBase58(),
    };
  }

  validateSigned = validateSigned;

  async simulate(intent:Intent) {
    await this.devnet();
    const tx=VersionedTransaction.deserialize(Buffer.from(intent.transaction,'base64'));
    const result=await this.rpc(this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'}));
    const fee=await this.rpc(this.connection.getFeeForMessage(tx.message,'confirmed'));
    return {ok:result.value.err===null,unitsConsumed:result.value.unitsConsumed ?? null,feeLamports:fee.value===null ? null : String(fee.value),
      feePayer:this.relayer.publicKey.toBase58(),network:'devnet',errorCode:result.value.err===null ? null : 'SIMULATION_FAILED'};
  }

  async prepareRound(row:RoundRow,founderWallet:string):Promise<Prepared> {
    const {config,state}=await this.protocol();
    if(field(state,'paused')!==false) throw new AppError('PROTOCOL_PAUSED','Round opening is paused.',409);
    const addresses=projectAddresses(this.programId,row.project_id);
    if(!await this.receipt(row.project_id)) throw new AppError('NOT_TOKENIZED','Tokenize this startup before opening its round.',409);
    const number=Buffer.alloc(2);number.writeUInt16LE(row.round_number);
    const round=PublicKey.findProgramAddressSync([Buffer.from('round'),addresses.project.toBuffer(),number],this.programId)[0];
    const roundVault=PublicKey.findProgramAddressSync([Buffer.from('round_vault'),round.toBuffer()],this.programId)[0];
    const founder=new PublicKey(founderWallet);
    const ix=this.instruction('open_round',{config,project:addresses.project,round,roundvault:roundVault,founder,relayer:this.relayer.publicKey,
      paymentmint:this.paymentMint,tokenprogram:TOKEN_2022_PROGRAM_ID,systemprogram:SystemProgram.programId},
      {round_number:row.round_number,opens_at:new BN(Math.floor(row.opens_at.getTime()/1000)),closes_at:new BN(Math.floor(row.closes_at.getTime()/1000)),
       unit_price_micro_usd:new BN(row.unit_price_micro_usd),max_units:new BN(row.max_units),target_amount:new BN(row.target_amount_micro_usd),
       max_subscription_amount:new BN(row.max_subscription_micro_usd),model_hash:[...Buffer.from(row.model_hash,'hex')],evidence_root:[...Buffer.from(row.evidence_root,'hex')]},[founder,this.relayer.publicKey]);
    const block=await this.rpc(this.connection.getLatestBlockhash('finalized'));
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:this.relayer.publicKey,recentBlockhash:block.blockhash,instructions:[ix]}).compileToV0Message());
    tx.sign([this.relayer]);
    return {transaction:Buffer.from(tx.serialize()).toString('base64'),message:Buffer.from(tx.message.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]!),
      lastValidBlockHeight:block.lastValidBlockHeight,projectPda:addresses.project.toBase58(),receiptMint:addresses.receiptMint.toBase58()};
  }

  async submit(raw: Uint8Array): Promise<void> {
    await this.devnet();
    await this.rpc(this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'finalized' }));
  }

  async status(intent: Intent): Promise<Status> {
    await this.devnet();
    const response = await this.rpc(this.connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true }));
    const observed = response.value[0];
    if (observed?.err) return observed.confirmationStatus === 'finalized' ? 'Failed' : 'Unknown';
    if (observed?.confirmationStatus === 'finalized') return 'Finalized';
    if (observed?.confirmationStatus === 'confirmed') return 'Confirmed';
    if (observed) return 'Submitted';
    const expired = await this.rpc(this.connection.getBlockHeight('finalized')) > intent.lastValidBlockHeight;
    if(expired && intent.kind==='Subscribe') {
      if(!intent.roundPda || !intent.buyerWallet || !intent.grossAmountMicroUsd) return invalidState();
      const subscription=await this.subscriptionState(intent.roundPda,intent.buyerWallet);
      if(subscription && subscription.gross!==intent.grossAmountMicroUsd) return invalidState();
      return subscription ? 'Finalized' : 'Expired';
    }
    if(expired && intent.kind==='Settle') {
      if(!intent.roundPda || !intent.buyerWallet) return invalidState();
      return await this.settled(intent.roundPda,intent.buyerWallet) ? 'Finalized' : 'Expired';
    }
    // Uncertain dispatched writes stay unresolved even after blockhash expiry.
    if (expired && intent.status === 'Prepared') return 'Expired';
    return intent.status === 'Prepared' ? 'Prepared' : 'Unknown';
  }

  async receipt(projectId: string): Promise<Receipt | null> {
    await this.devnet();
    const addresses = projectAddresses(this.programId, projectId);
    const [project, mintInfo] = await this.rpc(this.connection.getMultipleAccountsInfo([addresses.project, addresses.receiptMint], 'finalized'));
    if (!project && !mintInfo) return null;
    if (!project?.owner.equals(this.programId) || !mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) return invalidState();
    const state = this.decode('project', project.data);
    if (!keyEquals(field(state, 'receipt_mint'), addresses.receiptMint)) return invalidState();
    const id = field(state, 'project_id');
    if (!Array.isArray(id) || !Buffer.from(id as number[]).equals(addresses.bytes)) return invalidState();
    const mint = unpackMint(addresses.receiptMint, mintInfo, TOKEN_2022_PROGRAM_ID);
    if (!mint.isInitialized || mint.decimals !== 0 || !getNonTransferable(mint)
      || !mint.mintAuthority?.equals(addresses.project) || mint.freezeAuthority !== null) return invalidState();
    return {
      projectPda: addresses.project.toBase58(), receiptMint: addresses.receiptMint.toBase58(),
      supply: mint.supply.toString(), decimals: 0, nonTransferable: true, simulation: true, confirmation: 'finalized',
    };
  }

  async balance(projectId: string, wallet: string): Promise<string> {
    const receipt = await this.receipt(projectId);
    if (!receipt) return '0';
    const owner = new PublicKey(wallet);
    const mint = new PublicKey(receipt.receiptMint);
    const response = await this.rpc(this.connection.getTokenAccountsByOwner(owner, { mint }, 'finalized'));
    let units = 0n;
    for (const entry of response.value) {
      const account = unpackAccount(entry.pubkey, entry.account, TOKEN_2022_PROGRAM_ID);
      if (!account.owner.equals(owner) || !account.mint.equals(mint)) return invalidState();
      units += account.amount;
    }
    return units.toString();
  }

  private async subscription(roundAddress: string, buyerAddress: string) {
    await this.devnet();
    const round = new PublicKey(roundAddress);
    const buyer = new PublicKey(buyerAddress);
    const subscription = PublicKey.findProgramAddressSync([Buffer.from('subscription'), round.toBuffer(), buyer.toBuffer()], this.programId)[0];
    const [roundInfo, subscriptionInfo] = await this.rpc(this.connection.getMultipleAccountsInfo([round, subscription], 'finalized'));
    if (!roundInfo || !subscriptionInfo) throw new AppError('NOT_FOUND', 'Round subscription not found.', 404);
    if (!roundInfo.owner.equals(this.programId) || !subscriptionInfo.owner.equals(this.programId)) return invalidState();
    const roundState = this.decode('round', roundInfo.data);
    const state = this.decode('subscription', subscriptionInfo.data);
    if (!keyEquals(field(state, 'round'), round) || !keyEquals(field(state, 'buyer_wallet') ?? field(state, 'buyer'), buyer)) return invalidState();
    const project = field(roundState, 'project');
    const number = field(roundState, 'round_number');
    if (!(project instanceof PublicKey) || typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 65535) return invalidState();
    const numberBytes = Buffer.alloc(2); numberBytes.writeUInt16LE(number);
    const expectedRound = PublicKey.findProgramAddressSync([Buffer.from('round'), project.toBuffer(), numberBytes], this.programId)[0];
    if (!expectedRound.equals(round)) return invalidState();
    const projectInfo = await this.rpc(this.connection.getAccountInfo(project, 'finalized'));
    if (!projectInfo?.owner.equals(this.programId)) return invalidState();
    const id = field(this.decode('project', projectInfo.data), 'project_id');
    if (!Array.isArray(id) || id.length !== 16) return invalidState();
    const hex = Buffer.from(id as number[]).toString('hex');
    const projectId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const addresses = projectAddresses(this.programId, projectId);
    if (!addresses.project.equals(project)) return invalidState();
    const rawStatus = field(roundState, 'status');
    if (!rawStatus || typeof rawStatus !== 'object') return invalidState();
    const status = normalize(Object.keys(rawStatus)[0] ?? '');
    return { round, buyer, subscription, state, roundState, projectId, addresses, status };
  }

  async settled(roundPda: string, buyerWallet: string): Promise<boolean> {
    const value = await this.subscription(roundPda, buyerWallet);
    return field(value.state, 'refunded') === true
      && ((['finalized', 'expired'].includes(value.status) && field(value.state, 'minted') === true) || value.status === 'refunding');
  }

  async prepareSettlement(roundPda: string, buyerWallet: string): Promise<Prepared & { projectId: string }> {
    const value = await this.subscription(roundPda, buyerWallet);
    if (!['open', 'finalized', 'expired', 'refunding'].includes(value.status)) {
      throw new AppError('ROUND_NOT_SETTLEABLE', 'Round is not ready for settlement.', 409);
    }
    if (value.status === 'open') {
      const slot = await this.rpc(this.connection.getSlot('finalized'));
      const now = await this.rpc(this.connection.getBlockTime(slot));
      const closesAt = String(field(value.roundState, 'closes_at'));
      if (now === null || !/^[0-9]+$/.test(closesAt)) return invalidState();
      if (BigInt(now) < BigInt(closesAt)) throw new AppError('ROUND_NOT_CLOSED', 'Wait until the round closes before settlement.', 409);
    }
    const minted = field(value.state, 'minted');
    const refunded = field(value.state, 'refunded');
    if (typeof minted !== 'boolean' || typeof refunded !== 'boolean') return invalidState();
    const needsMint = value.status !== 'refunding' && !minted;
    if (!needsMint && refunded) throw new AppError('ALREADY_SETTLED', 'This subscription is already settled.', 409);
    if (!await this.receipt(value.projectId)) return invalidState();
    const configInfo = await this.rpc(this.connection.getAccountInfo(value.addresses.config, 'finalized'));
    if (!configInfo?.owner.equals(this.programId)) return invalidState();
    const config = this.decode('config', configInfo.data);
    if (!keyEquals(field(config, 'relayer'), this.relayer.publicKey)
      || !keyEquals(field(config, 'payment_mint'), this.paymentMint)) return invalidState();
    if (needsMint && field(config, 'paused') !== false) throw new AppError('PROTOCOL_PAUSED', 'Allocation minting is paused.', 409);
    const protocolFeeVault = field(config, 'protocol_fee_vault');
    if (!(protocolFeeVault instanceof PublicKey)) return invalidState();
    const receiptAccount = getAssociatedTokenAddressSync(value.addresses.receiptMint, value.buyer, false, TOKEN_2022_PROGRAM_ID);
    const paymentAccount = getAssociatedTokenAddressSync(this.paymentMint, value.buyer, false, TOKEN_2022_PROGRAM_ID);
    const roundVault = PublicKey.findProgramAddressSync([Buffer.from('round_vault'), value.round.toBuffer()], this.programId)[0];
    const available: Record<string, PublicKey> = {
      config: value.addresses.config, project: value.addresses.project, round: value.round,
      subscription: value.subscription, buyer: value.buyer, relayer: this.relayer.publicKey, payer: this.relayer.publicKey,
      receiptmint: value.addresses.receiptMint, buyerreceiptaccount: receiptAccount,
      buyerpaymentaccount: paymentAccount, paymentmint: this.paymentMint, roundvault: roundVault,
      projectvault: value.addresses.projectVault, founderrewardvault: value.addresses.founderRewardVault,
      protocolfeevault: protocolFeeVault, tokenprogram: TOKEN_2022_PROGRAM_ID,
      associatedtokenprogram: ASSOCIATED_TOKEN_PROGRAM_ID, systemprogram: SystemProgram.programId,
    };
    const instructions: TransactionInstruction[] = [];
    const add = (name: string) => {
      const definition = this.idl.instructions.find(item => normalize(item.name) === normalize(name));
      if (!definition || definition.args.length !== 0) throw new AppError('CHAIN_UNAVAILABLE', `The deployed IDL must provide ${name} with no amount arguments.`, 503);
      instructions.push(new TransactionInstruction({
        programId: this.programId, data: this.instructions.encode(definition.name, {}),
        keys: definition.accounts.map(account => {
          if ('accounts' in account) return invalidState();
          const address = available[normalize(account.name)];
          if (!address || (account.signer && !address.equals(this.relayer.publicKey))) return invalidState();
          return { pubkey: address, isSigner: Boolean(account.signer), isWritable: Boolean(account.writable) };
        }),
      }));
    };
    if (value.status === 'open') add('finalize_round');
    if (needsMint) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(this.relayer.publicKey, receiptAccount, value.buyer, value.addresses.receiptMint, TOKEN_2022_PROGRAM_ID));
      add('mint_final_allocation');
    }
    if (!refunded) add('refund_excess');
    const block = await this.rpc(this.connection.getLatestBlockhash('finalized'));
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: this.relayer.publicKey, recentBlockhash: block.blockhash, instructions,
    }).compileToV0Message());
    tx.sign([this.relayer]);
    const signature = tx.signatures[0];
    if (!signature) return invalidState();
    const raw = tx.serialize();
    if (raw.length > 1232) throw new AppError('CHAIN_UNAVAILABLE', 'Settlement exceeds the transaction size limit.', 503);
    return {
      projectId: value.projectId, transaction: Buffer.from(raw).toString('base64'),
      message: Buffer.from(tx.message.serialize()).toString('base64'), signature: bs58.encode(signature),
      lastValidBlockHeight: block.lastValidBlockHeight,
      projectPda: value.addresses.project.toBase58(), receiptMint: value.addresses.receiptMint.toBase58(),
    };
  }

  private instruction(name: string, available: Record<string, PublicKey>, args: Record<string, unknown>, signers: PublicKey[]) {
    const definition = this.idl.instructions.find(item => normalize(item.name)===normalize(name));
    if (!definition) throw new AppError('CHAIN_UNAVAILABLE',`The deployed IDL is missing ${name}.`,503);
    return new TransactionInstruction({ programId:this.programId,data:this.instructions.encode(definition.name,args),
      keys:definition.accounts.map(account => {
        if ('accounts' in account) return invalidState();
        const pubkey=available[normalize(account.name)];
        if (!pubkey || (account.signer && !signers.some(signer => signer.equals(pubkey)))) return invalidState();
        return { pubkey,isSigner:Boolean(account.signer),isWritable:Boolean(account.writable) };
      }) });
  }
  private async protocol() {
    await this.devnet();
    const config=PublicKey.findProgramAddressSync([Buffer.from('config')],this.programId)[0];
    const [configInfo,mintInfo]=await this.rpc(this.connection.getMultipleAccountsInfo([config,this.paymentMint],'finalized'));
    if (!configInfo?.owner.equals(this.programId) || !mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) return invalidState();
    const state=this.decode('config',configInfo.data);
    if (!keyEquals(field(state,'relayer'),this.relayer.publicKey) || !keyEquals(field(state,'payment_mint'),this.paymentMint)) return invalidState();
    const mint=unpackMint(this.paymentMint,mintInfo,TOKEN_2022_PROGRAM_ID);
    if (!mint.isInitialized || mint.decimals!==6 || mint.freezeAuthority!==null || !mint.mintAuthority?.equals(this.relayer.publicKey)
      || getExtensionTypes(mint.tlvData).length!==0) return invalidState();
    return { config,state };
  }
  async prepareFunding(intent: Funding): Promise<FundingTx> {
    fundingDollars(intent.amount);
    if (!intent.proofHash || !/^[a-f0-9]{64}$/.test(intent.proofHash)) return invalidState();
    const { config,state }=await this.protocol();
    if (field(state,'paused')!==false) throw new AppError('PROTOCOL_PAUSED','Wallet funding is paused.',409);
    const bytes=projectAddresses(this.programId,intent.id).bytes;
    const receipt=PublicKey.findProgramAddressSync([Buffer.from('funding'),bytes],this.programId)[0];
    const wallet=new PublicKey(intent.wallet);
    const destination=getAssociatedTokenAddressSync(this.paymentMint,wallet,false,TOKEN_2022_PROGRAM_ID);
    const definition=this.idl.instructions.find(item => normalize(item.name)==='fundmockusdc');
    if (!definition || definition.args.length!==3) return invalidState();
    const args: Record<string,unknown>={};const semantics=new Set<string>();
    for (const arg of definition.args) {
      const name=normalize(arg.name);
      if (name==='intentid' && JSON.stringify(arg.type)===JSON.stringify({array:['u8',16]})) {args[arg.name]=[...bytes];semantics.add('intent');}
      else if (['amount','amountmicrousd'].includes(name) && arg.type==='u64') {args[arg.name]=new BN(intent.amount);semantics.add('amount');}
      else if (name==='bankproofhash' && JSON.stringify(arg.type)===JSON.stringify({array:['u8',32]})) {args[arg.name]=[...Buffer.from(intent.proofHash,'hex')];semantics.add('proof');}
      else return invalidState();
    }
    if (Object.keys(args).length!==3 || semantics.size!==3) return invalidState();
    const guarded=this.instruction('fund_mock_usdc',{
      config,fundingreceipt:receipt,wallet,destination,recipient:destination,paymentmint:this.paymentMint,
      relayer:this.relayer.publicKey,payer:this.relayer.publicKey,tokenprogram:TOKEN_2022_PROGRAM_ID,
      associatedtokenprogram:ASSOCIATED_TOKEN_PROGRAM_ID,systemprogram:SystemProgram.programId,
    },args,[this.relayer.publicKey]);
    const block=await this.rpc(this.connection.getLatestBlockhash('finalized'));
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:this.relayer.publicKey,recentBlockhash:block.blockhash,
      instructions:[createAssociatedTokenAccountIdempotentInstruction(this.relayer.publicKey,destination,wallet,this.paymentMint,TOKEN_2022_PROGRAM_ID),guarded],
    }).compileToV0Message()); tx.sign([this.relayer]);
    const raw=tx.serialize(); if (raw.length>1232 || tx.message.header.numRequiredSignatures!==1 || !tx.signatures[0]) return invalidState();
    return {transaction:Buffer.from(raw).toString('base64'),signature:bs58.encode(tx.signatures[0]),blockhash:block.blockhash,
      lastValidBlockHeight:block.lastValidBlockHeight,messageHash:createHash('sha256').update(tx.message.serialize()).digest('hex'),status:'Prepared'};
  }
  async fundingReceipt(intent: Funding): Promise<FundingProof | null> {
    await this.devnet();
    const bytes=projectAddresses(this.programId,intent.id).bytes;
    const address=PublicKey.findProgramAddressSync([Buffer.from('funding'),bytes],this.programId)[0];
    const info=await this.rpc(this.connection.getAccountInfo(address,'finalized')); if (!info) return null;
    if (!info.owner.equals(this.programId)) return invalidState();
    const state=this.decode('fundingreceipt',info.data);
    const id=field(state,'intent_id'); const proof=field(state,'bank_proof_hash');
    const amount=String(field(state,'amount_micro_usd') ?? field(state,'amount'));
    if (!Array.isArray(id) || !Buffer.from(id as number[]).equals(bytes) || !Array.isArray(proof)
      || Buffer.from(proof as number[]).toString('hex')!==intent.proofHash || amount!==intent.amount
      || !keyEquals(field(state,'wallet'),new PublicKey(intent.wallet))
      || !keyEquals(field(state,'payment_mint') ?? field(state,'mint'),this.paymentMint) || field(state,'funded')!==true) return invalidState();
    return {intentId:intent.id,wallet:intent.wallet,amount:amount,mint:this.paymentMint.toBase58(),proofHash:intent.proofHash,funded:true};
  }
  async fundingTxStatus(tx: FundingTx): Promise<Status> {
    await this.devnet();
    const response=await this.rpc(this.connection.getSignatureStatuses([tx.signature],{searchTransactionHistory:true}));
    const status=response.value[0];
    if (status?.err) return status.confirmationStatus==='finalized' ? 'Failed' : 'Unknown';
    if (status?.confirmationStatus==='finalized') return 'Finalized';
    if (status?.confirmationStatus==='confirmed') return 'Confirmed';
    if (status) return 'Submitted';
    return await this.rpc(this.connection.getBlockHeight('finalized'))>tx.lastValidBlockHeight ? 'Expired' : 'Unknown';
  }
  async paymentBalance(walletAddress: string): Promise<string> {
    await this.protocol();
    const wallet=new PublicKey(walletAddress);
    const address=getAssociatedTokenAddressSync(this.paymentMint,wallet,false,TOKEN_2022_PROGRAM_ID);
    const info=await this.rpc(this.connection.getAccountInfo(address,'finalized')); if (!info) return '0';
    const account=unpackAccount(address,info,TOKEN_2022_PROGRAM_ID);
    if (!account.owner.equals(wallet) || !account.mint.equals(this.paymentMint) || account.isFrozen) return invalidState();
    return account.amount.toString();
  }
  async roundInfo(address: string): Promise<RoundInfo> {
    const { state:config }=await this.protocol();
    const round=new PublicKey(address);
    const info=await this.rpc(this.connection.getAccountInfo(round,'finalized'));
    if (!info) throw new AppError('NOT_FOUND','Round not found.',404);
    if (!info.owner.equals(this.programId)) return invalidState();
    const state=this.decode('round',info.data); const project=field(state,'project');
    const number=field(state,'round_number');
    if (!(project instanceof PublicKey) || typeof number!=='number' || !Number.isInteger(number) || number<1 || number>65535) return invalidState();
    const roundBytes=Buffer.alloc(2); roundBytes.writeUInt16LE(number);
    if (!PublicKey.findProgramAddressSync([Buffer.from('round'),project.toBuffer(),roundBytes],this.programId)[0].equals(round)) return invalidState();
    const projectInfo=await this.rpc(this.connection.getAccountInfo(project,'finalized'));
    if (!projectInfo?.owner.equals(this.programId)) return invalidState();
    const projectState=this.decode('project',projectInfo.data); const id=field(projectState,'project_id');
    const founder=field(projectState,'founder_wallet');
    if (!Array.isArray(id) || id.length!==16 || !(founder instanceof PublicKey)) return invalidState();
    const hex=Buffer.from(id as number[]).toString('hex');
    const projectId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    if (!projectAddresses(this.programId,projectId).project.equals(project)) return invalidState();
    const integer=(name:string) => { const value=String(field(state,name)); try { u64(value); } catch { return invalidState(); } return value; };
    const rawStatus=field(state,'status'); if (!rawStatus || typeof rawStatus!=='object') return invalidState();
    const price=integer('unit_price_micro_usd'),maxUnits=integer('max_units'),target=integer('target_amount');
    if (BigInt(price)<1n || BigInt(maxUnits)<1n || BigInt(price)*BigInt(maxUnits)!==BigInt(target)) return invalidState();
    if (Number(String(field(config,'protocol_fee_bps')))!==100 || Number(String(field(config,'founder_share_bps')))!==4000) return invalidState();
    return {address,projectId,projectPda:project.toBase58(),founderWallet:founder.toBase58(),
      opensAt:integer('opens_at'),closesAt:integer('closes_at'),price,maxUnits,target,totalCommitted:integer('total_committed'),
      maxSubscription:integer('max_subscription_amount'),status:normalize(Object.keys(rawStatus)[0] ?? ''),paused:field(config,'paused')!==false};
  }
  async subscriptionState(roundAddress: string, walletAddress: string): Promise<SubscriptionState | null> {
    await this.devnet();
    const round=new PublicKey(roundAddress),wallet=new PublicKey(walletAddress);
    const address=PublicKey.findProgramAddressSync([Buffer.from('subscription'),round.toBuffer(),wallet.toBuffer()],this.programId)[0];
    const info=await this.rpc(this.connection.getAccountInfo(address,'finalized')); if (!info) return null;
    if (!info.owner.equals(this.programId)) return invalidState();
    const state=this.decode('subscription',info.data);
    if (!keyEquals(field(state,'round'),round) || !keyEquals(field(state,'buyer_wallet') ?? field(state,'buyer'),wallet)) return invalidState();
    const amount=(name:string) => { const value=String(field(state,name)); try { u64(value); } catch { return invalidState(); } return value; };
    const minted=field(state,'minted'),refunded=field(state,'refunded');
    if (typeof minted!=='boolean' || typeof refunded!=='boolean') return invalidState();
    return {gross:amount('gross_amount'),accepted:amount('accepted_amount'),units:amount('units'),refundedAmount:amount('refunded_amount'),minted,refunded};
  }
  async prepareSubscription(snapshot: RoundInfo, walletAddress: string, amount: string): Promise<Prepared> {
    const round=await this.roundInfo(snapshot.address);
    const slot=await this.rpc(this.connection.getSlot('finalized')); const now=await this.rpc(this.connection.getBlockTime(slot));
    if (now===null) return invalidState();
    if (round.paused || round.status!=='open' || BigInt(now)<BigInt(round.opensAt) || BigInt(now)>=BigInt(round.closesAt)) throw new AppError('ROUND_NOT_OPEN','Round is not open.',409);
    if (round.price!==snapshot.price || round.projectId!==snapshot.projectId) return invalidState();
    const gross=u64(amount);
    if (gross<BigInt(round.price) || gross>BigInt(round.maxSubscription)) throw new AppError('OVER_IDENTITY_CAP','Commitment is outside this round’s limits.',409);
    if (walletAddress===round.founderWallet) throw new AppError('SELF_SUBSCRIPTION_FORBIDDEN','Founder cannot participate in this project.',409);
    if (BigInt(await this.paymentBalance(walletAddress))<gross) throw new AppError('INSUFFICIENT_MOCK_TOKEN_BALANCE','Fund the wallet before participating.',409);
    const addresses=projectAddresses(this.programId,round.projectId); const roundKey=new PublicKey(round.address),buyer=new PublicKey(walletAddress);
    const subscription=PublicKey.findProgramAddressSync([Buffer.from('subscription'),roundKey.toBuffer(),buyer.toBuffer()],this.programId)[0];
    const roundVault=PublicKey.findProgramAddressSync([Buffer.from('round_vault'),roundKey.toBuffer()],this.programId)[0];
    const definition=this.idl.instructions.find(item => normalize(item.name)==='subscribe'); const arg=definition?.args[0];
    if (!definition || definition.args.length!==1 || !arg || !['grossamount','grossamountmicrousd'].includes(normalize(arg.name)) || arg.type!=='u64') return invalidState();
    const ix=this.instruction('subscribe',{
      config:addresses.config,project:addresses.project,round:roundKey,subscription,buyer,relayer:this.relayer.publicKey,
      payer:this.relayer.publicKey,paymentmint:this.paymentMint,
      buyerpaymentaccount:getAssociatedTokenAddressSync(this.paymentMint,buyer,false,TOKEN_2022_PROGRAM_ID),roundvault:roundVault,
      tokenprogram:TOKEN_2022_PROGRAM_ID,associatedtokenprogram:ASSOCIATED_TOKEN_PROGRAM_ID,systemprogram:SystemProgram.programId,
    },{[arg.name]:new BN(amount)},[buyer,this.relayer.publicKey]);
    const block=await this.rpc(this.connection.getLatestBlockhash('finalized'));
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:this.relayer.publicKey,recentBlockhash:block.blockhash,instructions:[ix]}).compileToV0Message());
    if (tx.message.header.numRequiredSignatures!==2 || !tx.message.staticAccountKeys.slice(0,2).some(key=>key.equals(buyer))) return invalidState();
    tx.sign([this.relayer]); if (!tx.signatures[0]) return invalidState();
    return {transaction:Buffer.from(tx.serialize()).toString('base64'),message:Buffer.from(tx.message.serialize()).toString('base64'),
      signature:bs58.encode(tx.signatures[0]),lastValidBlockHeight:block.lastValidBlockHeight,projectPda:addresses.project.toBase58(),receiptMint:addresses.receiptMint.toBase58()};
  }
  programAddress() {return this.programId.toBase58();}
  async signatures(before?:string,until?:string):Promise<Array<{signature:string}>> {
    await this.devnet();
    return this.rpc(this.connection.getSignaturesForAddress(this.programId,{limit:1000,...(before ? {before} : {}),...(until ? {until} : {})},'finalized'));
  }
  async finalizedEvents(signature:string):Promise<ChainEvent[]> {
    await this.devnet();
    const tx=await this.rpc(this.connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}));
    if (!tx) throw new AppError('CHAIN_UNAVAILABLE','Finalized transaction history is unavailable.',503);
    if (!tx.meta || tx.meta.err) return [];
    const logs=tx.meta.logMessages;
    if (!logs || logs.some(line=>line==='Log truncated')) throw new AppError('CHAIN_UNAVAILABLE','Complete event logs are unavailable.',503);
    const keys=tx.transaction.message.getAccountKeys(tx.meta.loadedAddresses ? {accountKeysFromLookups:tx.meta.loadedAddresses} : undefined);
    const instructions=tx.transaction.message.compiledInstructions;
    const coder=new BorshEventCoder(this.idl);const stack:string[]=[];const events:ChainEvent[]=[];
    let instructionIndex=-1,eventIndex=0;
    for (const line of logs) {
      const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
      if (invoke?.[1] && invoke[2]) {
        const depth=Number(invoke[2]);stack.length=depth-1;stack.push(invoke[1]);
        if (depth===1) {
          let next=instructionIndex+1;
          while (next<instructions.length && keys.get(instructions[next]!.programIdIndex)?.toBase58()!==invoke[1]) next++;
          if (next>=instructions.length) return invalidState();instructionIndex=next;eventIndex=0;
        }
        continue;
      }
      if (/^Program [1-9A-HJ-NP-Za-km-z]+ (success|failed:)/.test(line)) {stack.pop();continue;}
      if (!line.startsWith('Program data: ') || stack.at(-1)!==this.programId.toBase58()) continue;
      const ordinal=eventIndex++;const decoded=coder.decode(line.slice('Program data: '.length));
      if (decoded && instructionIndex>=0) events.push({programId:this.programId.toBase58(),signature,instructionIndex,eventIndex:ordinal,
        slot:tx.slot.toString(),eventType:decoded.name,payload:eventData(decoded.data)});
    }
    return events;
  }
}
