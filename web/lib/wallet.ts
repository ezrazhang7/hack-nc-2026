import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
interface Provider {
  publicKey:{toBase58():string}|null;
  connect():Promise<{publicKey:{toBase58():string}}>;
  signMessage(message:Uint8Array,encoding?:string):Promise<{signature:Uint8Array}>;
  signTransaction(transaction:VersionedTransaction):Promise<VersionedTransaction>;
}
function provider():Provider {
  const browser=window as unknown as {phantom?:{solana?:Provider};solana?:Provider};
  const wallet=browser.phantom?.solana??browser.solana;
  if(!wallet)throw new Error('Install or open Phantom to connect your Devnet wallet.');
  return wallet;
}
export async function connectWallet(){return (await provider().connect()).publicKey.toBase58();}
export async function signProof(message:string,address:string) {
  const wallet=provider();if(wallet.publicKey?.toBase58()!==address)throw new Error('Wallet changed. Connect and verify it again.');
  return bs58.encode((await wallet.signMessage(new TextEncoder().encode(message),'utf8')).signature);
}
export async function signPrepared(transaction:string,address:string) {
  const wallet=provider();if(wallet.publicKey?.toBase58()!==address)throw new Error('Wallet changed. Connect and verify it again.');
  const tx=VersionedTransaction.deserialize(Buffer.from(transaction,'base64'));
  if(!tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).some(key=>key.toBase58()===address))throw new Error('Transaction does not require this wallet.');
  const signed=await wallet.signTransaction(tx);
  if(!Buffer.from(signed.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw new Error('Wallet changed the prepared transaction.');
  return Buffer.from(signed.serialize()).toString('base64');
}
