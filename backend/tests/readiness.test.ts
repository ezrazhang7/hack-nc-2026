import {execFileSync} from 'node:child_process';
import {expect,test} from 'vitest';
import {readiness,unconfiguredApi} from '../src/readiness.js';
test('missing credentials never become a ready purchase service',async()=>{
  expect(readiness({})).toMatchObject({backendConfigured:false,purchasesEnabled:false,nessieEnabled:false});
  const app=unconfiguredApi();
  expect((await app.request('/api/status')).status).toBe(200);
  const failure=await app.request('/api/funding',{method:'POST'});
  expect(failure.status).toBe(503);expect(await failure.json()).toMatchObject({error:{code:'SETUP_REQUIRED'}});
  expect(failure.headers.get('cache-control')).toBe('no-store');
});

test('Solana RPC dependencies load when require of ESM is disabled, as in the Vercel loader',()=>{
  expect(()=>execFileSync(process.execPath,['--no-experimental-require-module','-e','require("@solana/web3.js");require("@coral-xyz/anchor")'],{cwd:new URL('..',import.meta.url),stdio:'pipe'})).not.toThrow();
});

test('Nessie readiness no longer needs a profile file',()=>{
  const env={DATABASE_URL:'x',PUBLIC_ORIGIN:'x',BETTER_AUTH_SECRET:'x',EMAIL_HASH_PEPPER:'x',CAMPUS_EMAIL_DOMAINS:'edu',GEMINI_API_KEY:'x',GEMINI_MODEL:'x',DEMO_MODE:'true',
    PROGRAM_ID:'x',PAYMENT_MINT:'x',RELAYER_SECRET_KEY:'x',PURCHASES_ENABLED:'true',NESSIE_ENABLED:'true',NESSIE_API_KEY:'x',NESSIE_TREASURY_ACCOUNT_ID:'x'};
  expect(readiness(env).nessieEnabled).toBe(false);
  expect(readiness({...env,NESSIE_BASE_URL:'https://bank.example'}).nessieEnabled).toBe(true);
});
