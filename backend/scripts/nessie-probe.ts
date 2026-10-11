import {readFile} from 'node:fs/promises';
import {NessieBank,resolveNessieProfile} from '../src/purchase/banking/adapter.js';
// Read-only check of the Nessie profile in use (built-in unless the deprecated NESSIE_PROFILE override is set):
// reads the treasury and any given accounts plus their transfer history, and reports transfer statuses
// the profile does not classify (those fail closed to review). Never creates a transfer.
//   npm run nessie:probe -- [accountId ...]
const env=process.env;
if(!env.NESSIE_API_KEY || !env.NESSIE_BASE_URL || !env.NESSIE_TREASURY_ACCOUNT_ID) throw new Error('Set NESSIE_API_KEY, NESSIE_BASE_URL and NESSIE_TREASURY_ACCOUNT_ID.');
const profile=resolveNessieProfile(env,env.NESSIE_PROFILE_PATH ? await readFile(env.NESSIE_PROFILE_PATH,'utf8') : undefined)!;
const bank=new NessieBank(profile,env.NESSIE_API_KEY);
console.log(`profile ${profile.id}`);
let failed=false;
for (const [label,id] of [['treasury',env.NESSIE_TREASURY_ACCOUNT_ID],...process.argv.slice(2).map((a,i)=>[`account ${i+1}`,a])]) {
  try {
    const account=await bank.account(id!);
    const history=await bank.history(id!);
    const unknown=[...new Set(history.filter(t=>t.state==='unknown').map(t=>t.providerStatus))];
    console.log(`${label}: balance $${account.dollars}, ${history.length} transfers${unknown.length ? `, UNCLASSIFIED statuses: ${unknown.join(', ')}` : ''}`);
    if(unknown.length) failed=true;
  } catch {console.error(`${label}: read failed (check the account ID, key and base URL).`);failed=true;}
}
if(failed) process.exitCode=1;
