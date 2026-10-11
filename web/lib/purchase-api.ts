import {api as request} from '@/lib/api';
export async function api<T>(path:string,body?:unknown,key?:string):Promise<T> {
  return request<T>(path,{cache:'no-store',method:body===undefined?'GET':'POST',
    ...(body===undefined?{}:{headers:{'Content-Type':'application/json','Idempotency-Key':key??crypto.randomUUID()},body:JSON.stringify(body)})});
}
// Reuse the key after a lost response. A new action must explicitly clear the old key.
export function actionKey(scope:string) {
  const name=`prospecto:action:${scope}`;
  const prior=sessionStorage.getItem(name);if(prior)return prior;
  const key=crypto.randomUUID();sessionStorage.setItem(name,key);return key;
}
export function dollarsToMicro(value:string):string {
  if(!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/.test(value))throw new Error('Enter a positive amount with at most six decimal places.');
  const [whole,fraction='']=value.split('.');
  const amount=BigInt(whole)*BigInt(1000000)+BigInt(fraction.padEnd(6,'0'));
  if(amount<=BigInt(0))throw new Error('Enter a positive amount.');
  return amount.toString();
}
export function money(value:string) {
  const amount=BigInt(value);return `${amount/BigInt(1000000)}.${((amount%BigInt(1000000))/BigInt(10000)).toString().padStart(2,'0')}`;
}
