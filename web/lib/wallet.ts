import {VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
// Wallet Standard (github.com/wallet-standard/wallet-standard), spoken directly so any Solana wallet
// works without a dependency: Phantom, Solflare, Backpack all register through these window events.
const CHAIN='solana:devnet';
interface Account {address:string;publicKey:Uint8Array;chains:readonly string[]}
interface Wallet {
  name:string;chains:readonly string[];accounts:readonly Account[];
  features:Record<string,unknown>&{
    'standard:connect'?:{connect():Promise<{accounts:readonly Account[]}>};
    'solana:signMessage'?:{signMessage(...inputs:{account:Account;message:Uint8Array}[]):Promise<{signature:Uint8Array}[]>};
    'solana:signTransaction'?:{signTransaction(...inputs:{account:Account;transaction:Uint8Array;chain:string}[]):Promise<{signedTransaction:Uint8Array}[]>};
  };
}
const wallets:Wallet[]=[];let selected:{wallet:Wallet;account:Account}|null=null;
function register(...added:Wallet[]){for(const w of added)if(!wallets.includes(w))wallets.push(w);return()=>undefined;}
if(typeof window!=='undefined'){
  window.addEventListener('wallet-standard:register-wallet',e=>(e as CustomEvent<(api:{register:typeof register})=>void>).detail({register}));
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register}}));
}
function usable(w:Wallet){return w.chains.includes(CHAIN)&&Boolean(w.features['standard:connect']&&w.features['solana:signMessage']&&w.features['solana:signTransaction']);}
export async function connectWallet(){
  const wallet=wallets.find(usable);
  if(!wallet)throw new Error('No Solana wallet found. Install Solflare, Backpack or Phantom, switch it to Devnet, then reload.');
  const {accounts}=await wallet.features['standard:connect']!.connect();
  const account=accounts[0]??wallet.accounts[0];
  if(!account)throw new Error(`${wallet.name} did not share an account.`);
  selected={wallet,account};return account.address;
}
function current(address:string){if(selected?.account.address!==address)throw new Error('Wallet changed. Connect and verify it again.');return selected;}
export async function signProof(message:string,address:string) {
  const {wallet,account}=current(address);
  const [out]=await wallet.features['solana:signMessage']!.signMessage({account,message:new TextEncoder().encode(message)});
  return bs58.encode(out.signature);
}
export async function signPrepared(transaction:string,address:string) {
  const {wallet,account}=current(address);
  const tx=VersionedTransaction.deserialize(Buffer.from(transaction,'base64'));
  if(!tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).some(key=>key.toBase58()===address))throw new Error('Transaction does not require this wallet.');
  const [out]=await wallet.features['solana:signTransaction']!.signTransaction({account,transaction:tx.serialize(),chain:CHAIN});
  const signed=VersionedTransaction.deserialize(out.signedTransaction);
  if(!Buffer.from(signed.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw new Error('Wallet changed the prepared transaction.');
  return Buffer.from(signed.serialize()).toString('base64');
}
