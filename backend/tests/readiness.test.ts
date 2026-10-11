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
