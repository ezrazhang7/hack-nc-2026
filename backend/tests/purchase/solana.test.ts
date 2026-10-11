import { createHash } from 'node:crypto';
import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import {
  ACCOUNT_SIZE, AccountLayout, AccountType, ExtensionType, MintLayout, TOKEN_2022_PROGRAM_ID, getMintLen, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, test, vi } from 'vitest';
import { SolanaChain } from '../../src/purchase/solana/client.js';
import { projectAddresses } from '../../src/purchase/solana/addresses.js';
import { founder, identityId, projectId, relayer, testIntent } from './helpers.js';
import type { Funding } from '../../src/purchase/banking/types.js';
import { profile } from './purchase-helpers.js';

const programId = Keypair.generate().publicKey;
const paymentMint = Keypair.generate().publicKey;
const accounts = [
  ['config', false, false], ['project', true, false], ['receipt_mint', true, false],
  ['project_vault', true, false], ['founder_reward_vault', true, false],
  ['founder', false, true], ['relayer', true, true], ['payment_mint', false, false],
  ['token_program', false, false], ['associated_token_program', false, false], ['system_program', false, false],
] as const;
const discriminator = (name: string) => [...createHash('sha256').update(name).digest().subarray(0, 8)];
const idl: Idl = {
  address: programId.toBase58(), metadata: { name: 'prospecto', version: '0.1.0', spec: '0.1.0' },
  instructions: [{
    name: 'create_project', discriminator: discriminator('global:create_project'),
    args: [{ name: 'project_id', type: { array: ['u8', 16] } }],
    accounts: accounts.map(([name, writable, signer]) => ({ name, writable, signer })),
  }, ...['finalize_round', 'mint_final_allocation', 'refund_excess'].map(name => ({
    name, discriminator: discriminator(`global:${name}`), args: [],
    accounts: [
      { name: 'round', writable: true }, { name: 'subscription', writable: true },
      { name: 'project', writable: true }, { name: 'receipt_mint', writable: true },
      { name: 'buyer_receipt_account', writable: true }, { name: 'buyer_payment_account', writable: true },
      { name: 'round_vault', writable: true }, { name: 'project_vault', writable: true },
      { name: 'founder_reward_vault', writable: true }, { name: 'protocol_fee_vault', writable: true },
      { name: 'token_program' }, { name: 'relayer', writable: true, signer: true },
    ],
  })), {
    name:'fund_mock_usdc',discriminator:discriminator('global:fund_mock_usdc'),
    args:[{name:'intent_id',type:{array:['u8',16]}},{name:'amount',type:'u64'},{name:'bank_proof_hash',type:{array:['u8',32]}}],
    accounts:[{name:'config'},{name:'funding_receipt',writable:true},{name:'wallet'},{name:'destination',writable:true},
      {name:'payment_mint',writable:true},{name:'relayer',writable:true,signer:true},{name:'token_program'},{name:'system_program'}],
  }, {
    name:'subscribe',discriminator:discriminator('global:subscribe'),args:[{name:'gross_amount',type:'u64'}],
    accounts:[{name:'config'},{name:'project'},{name:'round',writable:true},{name:'subscription',writable:true},
      {name:'buyer',signer:true},{name:'relayer',writable:true,signer:true},{name:'payment_mint'},
      {name:'buyer_payment_account',writable:true},{name:'round_vault',writable:true},{name:'token_program'},{name:'system_program'}],
  }],
  events:[{name:'MockWalletFunded',discriminator:discriminator('event:MockWalletFunded')}],
  accounts: [
    { name: 'Config', discriminator: discriminator('account:Config') },
    { name: 'Project', discriminator: discriminator('account:Project') },
    { name: 'Round', discriminator: discriminator('account:Round') },
    { name: 'Subscription', discriminator: discriminator('account:Subscription') },
    { name: 'FundingReceipt', discriminator: discriminator('account:FundingReceipt') },
  ],
  types: [
    { name: 'Config', type: { kind: 'struct', fields: [
      { name: 'relayer', type: 'pubkey' }, { name: 'payment_mint', type: 'pubkey' }, { name: 'paused', type: 'bool' },
      { name: 'protocol_fee_vault', type: 'pubkey' },
      { name:'protocol_fee_bps',type:'u16' }, { name:'founder_share_bps',type:'u16' },
    ] } },
    { name: 'Round', type: { kind: 'struct', fields: [
      { name: 'project', type: 'pubkey' }, { name: 'round_number', type: 'u16' },
      { name: 'closes_at', type: 'i64' }, { name: 'status', type: { defined: { name: 'RoundStatus' } } },
      {name:'opens_at',type:'i64'},{name:'unit_price_micro_usd',type:'u64'},{name:'max_units',type:'u64'},
      {name:'target_amount',type:'u64'},{name:'total_committed',type:'u64'},{name:'max_subscription_amount',type:'u64'},
    ] } },
    { name: 'Subscription', type: { kind: 'struct', fields: [
      { name: 'round', type: 'pubkey' }, { name: 'buyer_wallet', type: 'pubkey' },
      { name: 'minted', type: 'bool' }, { name: 'refunded', type: 'bool' },
      {name:'gross_amount',type:'u64'},{name:'accepted_amount',type:'u64'},{name:'units',type:'u64'},{name:'refunded_amount',type:'u64'},
    ] } },
    { name: 'RoundStatus', type: { kind: 'enum', variants: ['Open', 'Finalized', 'Expired', 'Refunding'].map(name => ({ name })) } },
    { name: 'Project', type: { kind: 'struct', fields: [
      { name: 'project_id', type: { array: ['u8', 16] } }, { name: 'founder_wallet', type: 'pubkey' }, { name: 'receipt_mint', type: 'pubkey' },
    ] } },
    {name:'FundingReceipt',type:{kind:'struct',fields:[{name:'intent_id',type:{array:['u8',16]}},
      {name:'wallet',type:'pubkey'},{name:'amount',type:'u64'},{name:'payment_mint',type:'pubkey'},
      {name:'bank_proof_hash',type:{array:['u8',32]}},{name:'funded',type:'bool'}]}},
    {name:'MockWalletFunded',type:{kind:'struct',fields:[{name:'amount',type:'u64'}]}},
  ],
};
const coder = new BorshAccountsCoder(idl);
const addresses = projectAddresses(programId, projectId);
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const info = (owner: PublicKey, data: Buffer) => ({ owner, data, executable: false, lamports: 1, rentEpoch: 0 });

function mintData(options: { decimals?: number; nonTransferable?: boolean; authority?: PublicKey; freezeAuthority?: PublicKey } = {}) {
  const extension = options.nonTransferable !== false;
  const bytes = Buffer.alloc(extension ? getMintLen([ExtensionType.NonTransferable]) : 82);
  MintLayout.encode({
    mintAuthorityOption: 1, mintAuthority: options.authority ?? addresses.project,
    supply: 99n, decimals: options.decimals ?? 0, isInitialized: true,
    freezeAuthorityOption: options.freezeAuthority ? 1 : 0, freezeAuthority: options.freezeAuthority ?? PublicKey.default,
  }, bytes);
  if (extension) {
    bytes[ACCOUNT_SIZE] = AccountType.Mint;
    bytes.writeUInt16LE(ExtensionType.NonTransferable, ACCOUNT_SIZE + 1);
    bytes.writeUInt16LE(0, ACCOUNT_SIZE + 3);
  }
  return bytes;
}
async function harness(options: { paused?: boolean; protocolRelayer?: PublicKey; mint?: Buffer; mintOwner?: PublicKey; projectOwner?: PublicKey } = {}) {
  const config = await coder.encode('Config', { relayer: options.protocolRelayer ?? relayer.publicKey, payment_mint: paymentMint, paused: options.paused ?? false, protocol_fee_vault: Keypair.generate().publicKey, protocol_fee_bps:100, founder_share_bps:4000 });
  const project = await coder.encode('Project', { project_id: [...addresses.bytes], founder_wallet: founder.publicKey, receipt_mint: addresses.receiptMint });
  const rpc = {
    getGenesisHash: vi.fn(async () => genesis),
    getAccountInfo: vi.fn(async () => info(programId, config)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 150 })),
    getMultipleAccountsInfo: vi.fn(async () => [info(options.projectOwner ?? programId, project), info(options.mintOwner ?? TOKEN_2022_PROGRAM_ID, options.mint ?? mintData())]),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    getBlockHeight: vi.fn(async () => 151),
    sendRawTransaction: vi.fn(async () => 'signature'),
    getSlot: vi.fn(async () => 100), getBlockTime: vi.fn(async () => 200),
  };
  const chain = new SolanaChain(rpc as unknown as Connection, programId, paymentMint, relayer, idl);
  return { rpc, chain };
}
async function settlementHarness(status = 'Open', minted = false, refunded = false, closesAt = 150) {
  const { rpc, chain } = await harness();
  const round = PublicKey.findProgramAddressSync([Buffer.from('round'), addresses.project.toBuffer(), Buffer.from([1, 0])], programId)[0];
  const roundData = await coder.encode('Round', { project: addresses.project, round_number: 1, closes_at: new BN(closesAt), status: { [status]: {} }, opens_at:new BN(1),unit_price_micro_usd:new BN(1000000),max_units:new BN(100),target_amount:new BN(100000000),total_committed:new BN(100000000),max_subscription_amount:new BN(100000000) });
  const subscriptionData = await coder.encode('Subscription', { round, buyer_wallet: founder.publicKey, minted, refunded,gross_amount:new BN(100000000),accepted_amount:new BN(minted ? 100000000 : 0),units:new BN(minted ? 99 : 0),refunded_amount:new BN(0) });
  const projectData = await coder.encode('Project', { project_id: [...addresses.bytes], founder_wallet: founder.publicKey, receipt_mint: addresses.receiptMint });
  const configData = (await rpc.getAccountInfo()).data;
  rpc.getAccountInfo.mockImplementation(async (address?: PublicKey) => info(programId, address?.equals(addresses.project) ? projectData : configData));
  rpc.getMultipleAccountsInfo.mockImplementation(async (keys?: PublicKey[]) => keys?.[0]?.equals(round)
    ? [info(programId, roundData), info(programId, subscriptionData)]
    : [info(programId, projectData), info(TOKEN_2022_PROGRAM_ID, mintData())]);
  return { chain, rpc, round };
}
async function purchaseHarness() {
  const {chain,rpc,round}=await settlementHarness('Open',false,false,300);
  const buyer=Keypair.generate();
  const paymentAta=getAssociatedTokenAddressSync(paymentMint,buyer.publicKey,false,TOKEN_2022_PROGRAM_ID);
  const original=rpc.getAccountInfo.getMockImplementation()! as (address?:PublicKey)=>Promise<ReturnType<typeof info>>;
  const roundData=await coder.encode('Round',{project:addresses.project,round_number:1,opens_at:new BN(1),closes_at:new BN(300),status:{Open:{}},
    unit_price_micro_usd:new BN(1000000),max_units:new BN(100),target_amount:new BN(100000000),
    total_committed:new BN(100000000),max_subscription_amount:new BN(100000000)});
  const config=(await original()).data;
  const tokenData=Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({mint:paymentMint,owner:buyer.publicKey,amount:100000000n,delegateOption:0,delegate:PublicKey.default,
    state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},tokenData);
  rpc.getAccountInfo.mockImplementation(async(address?:PublicKey)=>address?.equals(round) ? info(programId,roundData)
    : address?.equals(paymentAta) ? info(TOKEN_2022_PROGRAM_ID,tokenData) : original(address));
  rpc.getMultipleAccountsInfo.mockImplementation(async()=>[info(programId,config),info(TOKEN_2022_PROGRAM_ID,mintData({decimals:6,nonTransferable:false,authority:relayer.publicKey}))]);
  const funding:Funding={id:projectId,generation:'g1',identityId,wallet:buyer.publicKey.toBase58(),amount:'100000000',
    sourceId:projectId,treasuryId:projectId,key:'test-key',requestHash:'hash',status:'BANK_CONFIRMED',tag:'test',profile,
    proofHash:'12'.repeat(32),providerTransferId:'test-transfer',lastError:null,leaseOwner:null,fence:0,pollCount:0};
  return {chain,rpc,round,buyer,funding,paymentAta};
}
describe('Solana purchase boundary',()=>{
  test('expired dispatched subscriptions require finalized PDA absence before refreshing',async()=>{
    const {chain,round,buyer}=await purchaseHarness();
    const intent={...testIntent(),kind:'Subscribe' as const,status:'Unknown' as const,roundPda:round.toBase58(),buyerWallet:buyer.publicKey.toBase58(),grossAmountMicroUsd:'100000000'};
    const read=vi.spyOn(chain,'subscriptionState').mockResolvedValue(null);
    expect(await chain.status(intent)).toBe('Expired');
    read.mockResolvedValue({gross:'100000000',accepted:'0',units:'0',refundedAmount:'0',minted:false,refunded:false});
    expect(await chain.status(intent)).toBe('Finalized');
    read.mockResolvedValue({gross:'99000000',accepted:'0',units:'0',refundedAmount:'0',minted:false,refunded:false});
    await expect(chain.status(intent)).rejects.toMatchObject({code:'CHAIN_STATE_INVALID'});
  });
  test('funding uses guarded program instruction and never direct token MintTo',async()=>{
    const {chain,funding}=await purchaseHarness();
    const prepared=await chain.prepareFunding(funding);
    const tx=VersionedTransaction.deserialize(Buffer.from(prepared.transaction,'base64'));
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]?.equals(relayer.publicKey)).toBe(true);
    expect(tx.message.compiledInstructions).toHaveLength(2);
    const guarded=tx.message.compiledInstructions[1]!;
    expect(tx.message.staticAccountKeys[guarded.programIdIndex]?.equals(programId)).toBe(true);
    const decoded=new BorshInstructionCoder(idl).decode(Buffer.from(guarded.data))!;
    expect(decoded.name).toBe('fund_mock_usdc');
    expect(String((decoded.data as {amount:BN}).amount)).toBe('100000000');
    expect((decoded.data as {bank_proof_hash:number[]}).bank_proof_hash).toEqual([...Buffer.from(funding.proofHash!,'hex')]);
    expect(tx.message.compiledInstructions.every(ix=>!tx.message.staticAccountKeys[ix.programIdIndex]?.equals(TOKEN_2022_PROGRAM_ID))).toBe(true);
  });
  test('funding receipt checks canonical finalized PDA and immutable bank proof',async()=>{
    const {chain,rpc,funding,buyer}=await purchaseHarness();
    const bytes=projectAddresses(programId,funding.id).bytes;
    const address=PublicKey.findProgramAddressSync([Buffer.from('funding'),bytes],programId)[0];
    const state={intent_id:[...bytes],wallet:buyer.publicKey,amount:new BN(funding.amount),payment_mint:paymentMint,
      bank_proof_hash:[...Buffer.from(funding.proofHash!,'hex')],funded:true};
    rpc.getAccountInfo.mockResolvedValue(info(programId,await coder.encode('FundingReceipt',state)));
    expect(await chain.fundingReceipt(funding)).toMatchObject({intentId:funding.id,proofHash:funding.proofHash,funded:true});
    expect(rpc.getAccountInfo).toHaveBeenLastCalledWith(address,'finalized');
    for(const invalid of [{wallet:founder.publicKey},{amount:new BN(1)},{bank_proof_hash:Array(32).fill(0)},{funded:false}]) {
      rpc.getAccountInfo.mockResolvedValue(info(programId,await coder.encode('FundingReceipt',{...state,...invalid})));
      await expect(chain.fundingReceipt(funding)).rejects.toMatchObject({code:'CHAIN_STATE_INVALID'});
    }
  });
  test('subscription builder binds buyer, amount, canonical accounts and both signatures',async()=>{
    const {chain,round,buyer}=await purchaseHarness();
    const snapshot=await chain.roundInfo(round.toBase58());
    const prepared=await chain.prepareSubscription(snapshot,buyer.publicKey.toBase58(),'100000000');
    const tx=VersionedTransaction.deserialize(Buffer.from(prepared.transaction,'base64'));
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(tx.message.staticAccountKeys.slice(0,2).map(key=>key.toBase58())).toContain(buyer.publicKey.toBase58());
    expect(tx.signatures[0]?.some(byte=>byte!==0)).toBe(true);
    expect(tx.signatures[1]?.every(byte=>byte===0)).toBe(true);
    const decoded=new BorshInstructionCoder(idl).decode(Buffer.from(tx.message.compiledInstructions[0]!.data))!;
    expect(decoded.name).toBe('subscribe');
    expect(String((decoded.data as {gross_amount:BN}).gross_amount)).toBe('100000000');
  });
  test('subscription builder rejects insufficient balance, cap and closed on-chain time',async()=>{
    const {chain,rpc,round,buyer}=await purchaseHarness();
    const snapshot=await chain.roundInfo(round.toBase58());
    await expect(chain.prepareSubscription(snapshot,buyer.publicKey.toBase58(),'101000000')).rejects.toMatchObject({code:'OVER_IDENTITY_CAP'});
    rpc.getBlockTime.mockResolvedValue(300);
    await expect(chain.prepareSubscription(snapshot,buyer.publicKey.toBase58(),'100000000')).rejects.toMatchObject({code:'ROUND_NOT_OPEN'});
    rpc.getBlockTime.mockResolvedValue(200);
    vi.spyOn(chain,'paymentBalance').mockResolvedValue('0');
    await expect(chain.prepareSubscription(snapshot,buyer.publicKey.toBase58(),'100000000')).rejects.toMatchObject({code:'INSUFFICIENT_MOCK_TOKEN_BALANCE'});
  });
  test('finalized event logs preserve multiple events, instruction indexes and decimal amounts',async()=>{
    const {chain,rpc}=await purchaseHarness();
    const message=new TransactionMessage({payerKey:relayer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[
      ComputeBudgetProgram.setComputeUnitLimit({units:100000}),new TransactionInstruction({programId,keys:[],data:Buffer.alloc(0)}),
    ]}).compileToV0Message();
    const amountBytes=Buffer.alloc(8);amountBytes.writeBigUInt64LE(100000000n);
    const event=Buffer.concat([Buffer.from(discriminator('event:MockWalletFunded')),amountBytes]).toString('base64');
    const getTransaction=vi.fn(async()=>({slot:123,transaction:{message},meta:{err:null,logMessages:[
      `Program ${programId.toBase58()} invoke [1]`,`Program data: ${event}`,`Program data: ${event}`,`Program ${programId.toBase58()} success`,
    ]}}));
    Object.assign(rpc,{getTransaction});
    expect(await chain.finalizedEvents('test-signature')).toEqual([0,1].map(eventIndex=>({
      programId:programId.toBase58(),signature:'test-signature',slot:'123',instructionIndex:1,eventIndex,
      eventType:'MockWalletFunded',payload:{amount:'100000000'},
    })));
    expect(getTransaction).toHaveBeenCalledWith('test-signature',{commitment:'finalized',maxSupportedTransactionVersion:0});
  });
});
describe('Solana tokenization boundary', () => {
  test('derives stable project and receipt PDAs from UUID bytes', () => {
    expect(addresses.bytes.length).toBe(16);
    expect(projectAddresses(programId, projectId.toUpperCase()).receiptMint).toEqual(addresses.receiptMint);
    expect(PublicKey.isOnCurve(addresses.project.toBytes())).toBe(false);
    expect(PublicKey.isOnCurve(addresses.receiptMint.toBytes())).toBe(false);
    expect(() => projectAddresses(programId, 'bad-id')).toThrow();
  });
  test('builds the deployed-IDL instruction with the required founder signature', async () => {
    const { chain } = await harness();
    const prepared = await chain.prepareProject({ id: projectId, founderIdentityId: identityId, founderWallet: founder.publicKey.toBase58() });
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    const ix = tx.message.compiledInstructions[0]!;
    expect(tx.message.staticAccountKeys[ix.programIdIndex]?.equals(programId)).toBe(true);
    expect(new BorshInstructionCoder(idl).decode(Buffer.from(ix.data))).toMatchObject({ name: 'create_project', data: { project_id: [...addresses.bytes] } });
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(prepared.receiptMint).toBe(addresses.receiptMint.toBase58());
  });
  test('rejects mainnet before preparing, reading or sending', async () => {
    for (const operation of ['prepare', 'read', 'send']) {
      const { chain, rpc } = await harness();
      rpc.getGenesisHash.mockResolvedValue('mainnet');
      const result = operation === 'prepare'
        ? chain.prepareProject({ id: projectId, founderIdentityId: identityId, founderWallet: founder.publicKey.toBase58() })
        : operation === 'read' ? chain.receipt(projectId) : chain.submit(new Uint8Array());
      await expect(result).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE' });
      expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
      expect(rpc.getAccountInfo).not.toHaveBeenCalled();
    }
  });
  test('checks protocol pause and configured relayer', async () => {
    const project = { id: projectId, founderIdentityId: identityId, founderWallet: founder.publicKey.toBase58() };
    await expect((await harness({ paused: true })).chain.prepareProject(project)).rejects.toMatchObject({ code: 'PROTOCOL_PAUSED' });
    await expect((await harness({ protocolRelayer: founder.publicKey })).chain.prepareProject(project)).rejects.toMatchObject({ code: 'CHAIN_STATE_INVALID' });
  });
  test('verifies raw Token-2022 extension, authority, decimals and supply at finalized commitment', async () => {
    const { chain, rpc } = await harness();
    expect(await chain.receipt(projectId)).toMatchObject({ supply: '99', decimals: 0, nonTransferable: true, confirmation: 'finalized' });
    expect(rpc.getMultipleAccountsInfo).toHaveBeenCalledWith([addresses.project, addresses.receiptMint], 'finalized');
  });
  test.each([
    { decimals: 6 }, { nonTransferable: false }, { authority: founder.publicKey }, { freezeAuthority: founder.publicKey },
  ])('rejects an unsafe receipt mint %j', async options => {
    await expect((await harness({ mint: mintData(options) })).chain.receipt(projectId)).rejects.toMatchObject({ code: 'CHAIN_STATE_INVALID' });
  });
  test('rejects mint or project accounts owned by another program', async () => {
    await expect((await harness({ mintOwner: programId })).chain.receipt(projectId)).rejects.toMatchObject({ code: 'CHAIN_STATE_INVALID' });
    await expect((await harness({ projectOwner: TOKEN_2022_PROGRAM_ID })).chain.receipt(projectId)).rejects.toMatchObject({ code: 'CHAIN_STATE_INVALID' });
  });
  test('expires only unsubmitted transactions and retains uncertainty after dispatch', async () => {
    const { chain } = await harness();
    const intent = testIntent();
    expect(await chain.status(intent)).toBe('Expired');
    expect(await chain.status({ ...intent, status: 'Submitted' })).toBe('Unknown');
    expect(await chain.status({ ...intent, status: 'Unknown' })).toBe('Unknown');
  });
  test('requires the configured program address and exact deployed instruction contract', () => {
    expect(() => new SolanaChain({} as Connection, programId, paymentMint, relayer, { ...idl, address: founder.publicKey.toBase58() })).toThrow(/address/);
    const wrong = structuredClone(idl);
    wrong.instructions[0]!.args = [];
    expect(() => new SolanaChain({} as Connection, programId, paymentMint, relayer, wrong)).toThrow(/create_project/);
    const signer = structuredClone(idl);
    const founderAccount = signer.instructions[0]!.accounts.find(account => account.name === 'founder');
    if (founderAccount && !('accounts' in founderAccount)) founderAccount.signer = false;
    expect(() => new SolanaChain({} as Connection, programId, paymentMint, relayer, signer)).toThrow(/account contract/);
  });
  test('settles a closed round with finalize, receipt ATA creation, mint and refund', async () => {
    const { chain, round } = await settlementHarness();
    const prepared = await chain.prepareSettlement(round.toBase58(), founder.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    const programInstructions = tx.message.compiledInstructions.filter(ix => tx.message.staticAccountKeys[ix.programIdIndex]?.equals(programId));
    const names = programInstructions.map(ix => new BorshInstructionCoder(idl).decode(Buffer.from(ix.data))?.name);
    expect(names).toEqual(['finalize_round', 'mint_final_allocation', 'refund_excess']);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(prepared.projectId).toBe(projectId);
  });
  test('rejects settlement before the on-chain close time', async () => {
    const { chain, round } = await settlementHarness('Open', false, false, 300);
    await expect(chain.prepareSettlement(round.toBase58(), founder.publicKey.toBase58())).rejects.toMatchObject({ code: 'ROUND_NOT_CLOSED' });
  });
  test('cancelled rounds only refund, without issuing receipts', async () => {
    const { chain, round } = await settlementHarness('Refunding');
    const prepared = await chain.prepareSettlement(round.toBase58(), founder.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    expect(tx.message.compiledInstructions).toHaveLength(1);
    expect(new BorshInstructionCoder(idl).decode(Buffer.from(tx.message.compiledInstructions[0]!.data))?.name).toBe('refund_excess');
  });
  test('finalized subscription flags prove both receipt issuance and refund completion', async () => {
    const { chain, round } = await settlementHarness('Finalized', true, true);
    expect(await chain.settled(round.toBase58(), founder.publicKey.toBase58())).toBe(true);
    await expect(chain.prepareSettlement(round.toBase58(), founder.publicKey.toBase58())).rejects.toMatchObject({ code: 'ALREADY_SETTLED' });
    const unfinished = await settlementHarness('Finalized', true, false);
    expect(await unfinished.chain.settled(unfinished.round.toBase58(), founder.publicKey.toBase58())).toBe(false);
  });
});
