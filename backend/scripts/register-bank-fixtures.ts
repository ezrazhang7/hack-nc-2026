import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { NessieBank,profileSchema } from '../src/purchase/banking/adapter.js';
import { registerBankFixtures } from '../src/purchase/banking/fixtures.js';
const env=process.env;
const file=process.argv[2];
if(!file || !env.DATABASE_URL || !env.NESSIE_API_KEY || !env.NESSIE_TREASURY_ACCOUNT_ID || !env.DEMO_GENERATION_ID) throw new Error('Provide the private manifest path and database/Nessie/generation configuration.');
const profile=profileSchema.parse(JSON.parse(env.NESSIE_PROFILE ?? await readFile(env.NESSIE_PROFILE_PATH!,'utf8')));
if(profile.baseUrl!==env.NESSIE_BASE_URL) throw new Error('Profile host does not match NESSIE_BASE_URL.');
const pool=new Pool({connectionString:env.DATABASE_URL});
try {
  console.log(JSON.stringify(await registerBankFixtures(pool,new NessieBank(profile,env.NESSIE_API_KEY),JSON.parse(await readFile(file,'utf8')),env.DEMO_GENERATION_ID,env.NESSIE_TREASURY_ACCOUNT_ID)));
} catch {console.error('Fixture registration failed; no provider write was made. Check the private manifest, ownership and starting balances.');process.exitCode=1;}
finally {await pool.end();}
