import type { Bank } from './adapter.js';
import { z } from 'zod';
const snapshotSchema=z.object({payer:z.object({id:z.string(),dollars:z.number().int()}),payee:z.object({id:z.string(),dollars:z.number().int()}),sourceHistory:z.array(z.string()),treasuryHistory:z.array(z.string())});
export async function baseline(bank:Bank,payerId:string,payeeId:string) {
  const [payer,payee,source,treasury]=await Promise.all([bank.account(payerId),bank.account(payeeId),bank.history(payerId),bank.history(payeeId)]);
  if(payer.id===payee.id) throw new Error('Distinct isolated accounts are required.');
  return snapshotSchema.parse({payer:{id:payer.id,dollars:payer.dollars},payee:{id:payee.id,dollars:payee.dollars},sourceHistory:source.map(t=>t.id),treasuryHistory:treasury.map(t=>t.id)});
}
export async function verifyCapability(bank:Bank,prior:unknown,transferId:string,tag:string,dollars:number,creation:unknown,envelope:'direct'|'objectCreated') {
  const created=z.object({httpStatus:z.literal(201),body:z.unknown()}).parse(creation);
  const body=envelope==='objectCreated' ? z.object({objectCreated:z.unknown()}).parse(created.body).objectCreated : created.body;
  const record=z.object({_id:z.literal(transferId),status:z.string().min(1)}).parse(body);
  const before=snapshotSchema.parse(prior);
  const [after,transfer]=await Promise.all([baseline(bank,before.payer.id,before.payee.id),bank.transfer(transferId)]);
  if(!Number.isSafeInteger(dollars) || dollars<1 || dollars>1000 || transfer.state!=='success' || transfer.payerId!==before.payer.id || transfer.payeeId!==before.payee.id || transfer.tag!==tag || transfer.dollars!==dollars
    || after.payer.dollars!==before.payer.dollars-dollars || after.payee.dollars!==before.payee.dollars+dollars) throw new Error('Transfer or balance evidence does not match.');
  for(const [oldRows,newRows] of [[before.sourceHistory,after.sourceHistory],[before.treasuryHistory,after.treasuryHistory]]) {
    if(oldRows.includes(transferId) || newRows.length!==oldRows.length+1 || !newRows.includes(transferId) || oldRows.some(id=>!newRows.includes(id))) throw new Error('History is not isolated or complete.');
  }
  return {verifiedAt:new Date().toISOString(),capabilitiesVerified:true as const,terminalStatus:transfer.providerStatus,creationStatus:record.status};
}
