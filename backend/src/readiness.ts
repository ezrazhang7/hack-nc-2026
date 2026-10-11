import { Hono } from 'hono';

export function readiness(env:NodeJS.ProcessEnv=process.env) {
  const required=['DATABASE_URL','PUBLIC_ORIGIN','BETTER_AUTH_SECRET','EMAIL_HASH_PEPPER','CAMPUS_EMAIL_DOMAINS','GEMINI_API_KEY','GEMINI_MODEL'];
  if(env.DEMO_MODE!=='true') required.push('RESEND_API_KEY','OTP_EMAIL_FROM');
  const backendConfigured=required.every(name=>Boolean(env[name]?.trim()));
  const chainConfigured=['PROGRAM_ID','PAYMENT_MINT','RELAYER_SECRET_KEY'].every(name=>Boolean(env[name]?.trim()));
  return {backendConfigured,purchasesEnabled:backendConfigured && chainConfigured && env.PURCHASES_ENABLED==='true',
    nessieEnabled:backendConfigured && chainConfigured && env.PURCHASES_ENABLED==='true' && env.NESSIE_ENABLED==='true' && Boolean(env.NESSIE_API_KEY) && Boolean(env.NESSIE_BASE_URL) && Boolean(env.NESSIE_TREASURY_ACCOUNT_ID),
    demoMode:env.DEMO_MODE==='true',network:'devnet',simulation:true};
}

/** Keep setup failures observable without exposing secrets or creating a fictional success path. */
export function unconfiguredApi() {
  const app=new Hono();
  app.use('*',async(c,next)=>{await next();c.header('Cache-Control','no-store');});
  app.get('/api/status',c=>c.json(readiness()));
  app.all('*',c=>c.json({error:{code:'SETUP_REQUIRED',message:'The demo backend needs its server configuration before sign-in and purchases are available.'}},503));
  return app;
}
