import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync} from 'node:fs';
import {describe,expect,test} from 'vitest';
import {BN,BorshAccountsCoder,BorshInstructionCoder,type Idl} from '@coral-xyz/anchor';
import {LiteSVM,FailedTransactionMetadata} from 'litesvm';
import {Keypair,PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,MintLayout,AccountLayout,ACCOUNT_SIZE,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,unpackMint,getNonTransferable} from '@solana/spl-token';
const artifact=fileURLToPath(new URL('../../../chain/target/deploy/prospecto.so',import.meta.url));
const idl=JSON.parse(readFileSync(new URL('../../idl/prospecto.json',import.meta.url),'utf8')) as Idl;
const coder=new BorshAccountsCoder(idl),instructions=new BorshInstructionCoder(idl);
const program=new PublicKey(idl.address);
const pda=(...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,program)[0];
const ix=(name:string,values:Record<string,PublicKey>,args:Record<string,unknown>={})=>{
  const def=idl.instructions.find(i=>i.name===name)!;
  return new TransactionInstruction({programId:program,data:instructions.encode(name,args),keys:def.accounts.map(a=>{
    if('accounts' in a || !values[a.name]) throw new Error(`Missing account ${a.name}`);
    return {pubkey:values[a.name]!,isWritable:Boolean(a.writable),isSigner:Boolean(a.signer)};
  })});
};
async function fixture() {
  const svm=new LiteSVM();svm.addProgramFromFile(program,artifact);
  const relayer=Keypair.generate(),founder=Keypair.generate(),buyer=Keypair.generate(),mint=Keypair.generate().publicKey;
  svm.airdrop(relayer.publicKey,10_000_000_000n);svm.airdrop(founder.publicKey,10_000_000n);svm.airdrop(buyer.publicKey,10_000_000n);
  const set=(key:PublicKey,owner:PublicKey,data:Buffer)=>svm.setAccount(key,{owner,data,lamports:10000000,executable:false,rentEpoch:0});
  const mintData=Buffer.alloc(82);MintLayout.encode({mintAuthorityOption:1,mintAuthority:relayer.publicKey,supply:0n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);set(mint,TOKEN_2022_PROGRAM_ID,mintData);
  const config=pda(Buffer.from('config')),feeVault=pda(Buffer.from('protocol_fee_vault'));
  set(config,program,await coder.encode('Config',{admin:founder.publicKey,relayer:relayer.publicKey,payment_mint:mint,protocol_fee_vault:feeVault,protocol_fee_bps:100,founder_share_bps:4000,paused:false,bump:PublicKey.findProgramAddressSync([Buffer.from('config')],program)[1]}));
  const tokenData=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint,owner:config,amount:0n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},tokenData);set(feeVault,TOKEN_2022_PROGRAM_ID,tokenData);
  const id=Buffer.from('123456781234423482341234567890ab','hex');const project=pda(Buffer.from('project'),id),receipt=pda(Buffer.from('receipt_mint'),project.toBuffer());
  const n=Buffer.from([1,0]),round=pda(Buffer.from('round'),project.toBuffer(),n);
  const values={config,project,receipt_mint:receipt,project_vault:pda(Buffer.from('project_vault'),project.toBuffer()),founder_reward_vault:pda(Buffer.from('founder_reward_vault'),project.toBuffer()),
    founder:founder.publicKey,relayer:relayer.publicKey,payment_mint:mint,token_program:TOKEN_2022_PROGRAM_ID,associated_token_program:ASSOCIATED_TOKEN_PROGRAM_ID,system_program:SystemProgram.programId,
    round,round_vault:pda(Buffer.from('round_vault'),round.toBuffer()),subscription:pda(Buffer.from('subscription'),round.toBuffer(),buyer.publicKey.toBuffer()),buyer:buyer.publicKey,
    buyer_payment_account:getAssociatedTokenAddressSync(mint,buyer.publicKey,false,TOKEN_2022_PROGRAM_ID),buyer_receipt_account:getAssociatedTokenAddressSync(receipt,buyer.publicKey,false,TOKEN_2022_PROGRAM_ID),protocol_fee_vault:feeVault,
    wallet:buyer.publicKey,destination:getAssociatedTokenAddressSync(mint,buyer.publicKey,false,TOKEN_2022_PROGRAM_ID),funding_receipt:pda(Buffer.from('funding'),id)};
  const send=(list:TransactionInstruction[],signers:Keypair[]=[relayer])=>{
    svm.expireBlockhash();const tx=new Transaction({feePayer:relayer.publicKey,recentBlockhash:svm.latestBlockhash()}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),...list);tx.sign(...signers);return svm.sendTransaction(tx);
  };
  const succeed=(list:TransactionInstruction[],signers:Keypair[]=[relayer])=>{const result=send(list,signers);if(result instanceof FailedTransactionMetadata) throw new Error(JSON.stringify({error:String(result.err()),logs:result.meta().logs()}));return result;};
  const fund=(amount=100000000,overrides:Partial<typeof values>={})=>ix('fund_mock_usdc',{...values,...overrides},{intent_id:[...id],amount:new BN(amount),bank_proof_hash:Array(32).fill(18)});
  const balance=(account:PublicKey)=>AccountLayout.decode(Buffer.from(svm.getAccount(account)!.data)).amount;
  const clock=svm.getClock();clock.unixTimestamp=1000n;svm.setClock(clock);
  const create=()=>succeed([ix('create_project',values,{project_id:[...id]})],[relayer,founder]);
  const open=()=>succeed([ix('open_round',values,{round_number:1,opens_at:new BN(1000),closes_at:new BN(87400),unit_price_micro_usd:new BN(1000000),max_units:new BN(100),target_amount:new BN(100000000),max_subscription_amount:new BN(100000000),model_hash:Array(32).fill(1),evidence_root:Array(32).fill(2)})],[relayer,founder]);
  const subscribe=(amount=100000000)=>succeed([ix('subscribe',values,{gross_amount:new BN(amount)})],[relayer,buyer]);
  const close=()=>{const clock=svm.getClock();clock.unixTimestamp=87400n;svm.setClock(clock);succeed([ix('finalize_round',values)]);};
  return {svm,values,send,succeed,fund,balance,create,open,subscribe,close,relayer,founder,buyer,id,mint};
}
// CI builds SBF first and requires this suite. Ordinary backend tests don't silently emulate a program.
if(process.env.RUN_CHAIN_TESTS==='true' && !existsSync(artifact)) throw new Error('Build chain/programs/prospecto first.');
describe.runIf(existsSync(artifact))('compiled Solana program',()=>{
  test('receipt mint is non-transferable; guarded funding cannot mint twice or change proof',async()=>{
    const f=await fixture();f.create();
    const mintInfo=f.svm.getAccount(f.values.receipt_mint)!;const mint=unpackMint(f.values.receipt_mint,{...mintInfo,data:Buffer.from(mintInfo.data)},TOKEN_2022_PROGRAM_ID);
    expect(getNonTransferable(mint)).not.toBeNull();expect(mint.decimals).toBe(0);
    f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,f.values.destination,f.buyer.publicKey,f.mint,TOKEN_2022_PROGRAM_ID),f.fund()]);
    f.succeed([f.fund()]);expect(f.balance(f.values.destination)).toBe(100000000n);
    expect(f.send([f.fund(99000000)])).toBeInstanceOf(FailedTransactionMetadata);expect(f.balance(f.values.destination)).toBe(100000000n);
  });
  test('subscription, fee split, allocation and refund conserve tokens and replay safely',async()=>{
    const f=await fixture();f.create();f.open();f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,f.values.destination,f.buyer.publicKey,f.mint,TOKEN_2022_PROGRAM_ID),f.fund()]);f.subscribe();
    expect(f.balance(f.values.round_vault)).toBe(100000000n);expect(f.send([ix('subscribe',f.values,{gross_amount:new BN(1)})],[f.relayer,f.buyer])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.send([ix('finalize_round',f.values)])).toBeInstanceOf(FailedTransactionMetadata);
    f.close();f.succeed([ix('mint_final_allocation',f.values),ix('refund_excess',f.values)]);f.succeed([ix('mint_final_allocation',f.values),ix('refund_excess',f.values)]);
    expect(f.balance(f.values.buyer_receipt_account)).toBe(99n);expect(f.balance(f.values.project_vault)).toBe(99000000n);expect(f.balance(f.values.founder_reward_vault)).toBe(400000n);expect(f.balance(f.values.protocol_fee_vault)).toBe(600000n);expect(f.balance(f.values.round_vault)).toBe(0n);
    const other=Keypair.generate().publicKey,target=getAssociatedTokenAddressSync(f.values.receipt_mint,other,false,TOKEN_2022_PROGRAM_ID);
    f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,target,other,f.values.receipt_mint,TOKEN_2022_PROGRAM_ID)]);
    expect(f.send([createTransferCheckedInstruction(f.values.buyer_receipt_account,f.values.receipt_mint,target,f.buyer.publicKey,1n,0,[],TOKEN_2022_PROGRAM_ID)],[f.relayer,f.buyer])).toBeInstanceOf(FailedTransactionMetadata);
  });
  test('cancellation returns all tokens once and charges no fees',async()=>{
    const f=await fixture();f.create();f.open();f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,f.values.destination,f.buyer.publicKey,f.mint,TOKEN_2022_PROGRAM_ID),f.fund()]);f.subscribe();
    f.succeed([ix('cancel_and_refund',{...f.values,authority:f.founder.publicKey})],[f.relayer,f.founder]);f.succeed([ix('mint_final_allocation',f.values),ix('refund_excess',f.values)]);f.succeed([ix('refund_excess',f.values)]);
    expect(f.balance(f.values.destination)).toBe(100000000n);expect(f.balance(f.values.project_vault)).toBe(0n);expect(f.balance(f.values.buyer_receipt_account)).toBe(0n);
  });
  test('wrong relayer, proof, amount and buyer fail without creating tokens or a subscription',async()=>{
    const f=await fixture();f.create();f.open();
    f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,f.values.destination,f.buyer.publicKey,f.mint,TOKEN_2022_PROGRAM_ID)]);
    const wrong=Keypair.generate();f.svm.airdrop(wrong.publicKey,10000000n);
    expect(f.send([f.fund(100000000,{relayer:wrong.publicKey})],[f.relayer,wrong])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.send([f.fund(1)])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.send([ix('fund_mock_usdc',f.values,{intent_id:[...f.id],amount:new BN(100000000),bank_proof_hash:Array(32).fill(0)})])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.balance(f.values.destination)).toBe(0n);
    expect(f.send([ix('subscribe',f.values,{gross_amount:new BN(100000000)})],[f.relayer,f.buyer])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.svm.getAccount(f.values.subscription)).toBeNull();expect(f.balance(f.values.round_vault)).toBe(0n);
    f.succeed([f.fund()]);
    const other=getAssociatedTokenAddressSync(f.mint,wrong.publicKey,false,TOKEN_2022_PROGRAM_ID);
    f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,other,wrong.publicKey,f.mint,TOKEN_2022_PROGRAM_ID)]);
    expect(f.send([ix('subscribe',{...f.values,buyer_payment_account:other},{gross_amount:new BN(100000000)})],[f.relayer,f.buyer])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.balance(f.values.destination)).toBe(100000000n);expect(f.svm.getAccount(f.values.subscription)).toBeNull();
  });
  test('failure in the refund leg rolls back allocation transfers and receipt minting atomically',async()=>{
    const f=await fixture();f.create();f.open();f.succeed([createAssociatedTokenAccountIdempotentInstruction(f.relayer.publicKey,f.values.destination,f.buyer.publicKey,f.mint,TOKEN_2022_PROGRAM_ID),f.fund()]);f.subscribe();f.close();
    expect(f.send([ix('mint_final_allocation',f.values),ix('refund_excess',{...f.values,buyer_payment_account:f.values.project_vault})])).toBeInstanceOf(FailedTransactionMetadata);
    expect(f.balance(f.values.round_vault)).toBe(100000000n);expect(f.balance(f.values.project_vault)).toBe(0n);expect(f.balance(f.values.protocol_fee_vault)).toBe(0n);expect(f.svm.getAccount(f.values.buyer_receipt_account)).toBeNull();
    f.succeed([ix('mint_final_allocation',f.values),ix('refund_excess',f.values)]);expect(f.balance(f.values.buyer_receipt_account)).toBe(99n);
  });

});
