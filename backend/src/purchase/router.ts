import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { z, ZodError } from 'zod';
import { isAllowedOrigin, type AllowedOrigins } from '../routes/guards.js';
import { AppError } from './http/errors.js';
import { allocation } from './rounds/allocation.js';
import { publicKey } from './solana/addresses.js';
import { TokenizationService } from './tokenization/service.js';
import type { Chain, Store } from './tokenization/types.js';
import type { PurchaseServices } from './runtime.js';
import { loadRound } from '../rounds/service.js';
import { hash } from './banking/canonical.js';
import { SolanaChain } from './solana/client.js';
import { preparedResponse } from './tokenization/service.js';

type Variables = { requestId: string; identityId: string; requestKey: string };
const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const allocationSchema = z.object({
  grossAmountMicroUsd: amount, totalCommittedMicroUsd: amount,
  unitPriceMicroUsd: amount, maxUnits: amount, cancelled: z.boolean().optional(),
}).strict();
function signature(value: string) {
  try { if (value.length < 64 || value.length > 88 || bs58.decode(value).length !== 64) throw new Error(); }
  catch { throw new AppError('INVALID_INPUT', 'Invalid transaction signature.'); }
  return value;
}
export function createPurchaseRouter(store: Store, chain: Chain, publicOrigin: AllowedOrigins, purchases:PurchaseServices | undefined,
  requireIdentity:(context:Context)=>Promise<{identityId:string}>, schedule:(task:()=>Promise<void>)=>void = task => { void task().catch(()=>undefined); }) {
  const app = new Hono<{ Variables: Variables }>();
  const isPurchase=(path:string)=>/^\/(?:banking\/(?:account|activity)|funding(?:\/.*)?|wallet\/balance|portfolio|transactions(?:\/.*)?|rounds\/[^/]+\/(?:open\/prepare|subscribe\/prepare|subscriptions\/me|settlement\/prepare)|projects\/[^/]+\/tokenization(?:\/.*)?|tokenization\/allocation\/preview)$/.test(path.replace(/^\/api/,''));
  const service = new TokenizationService(store, chain);
  const purchase=() => {if (!purchases) throw new AppError('BANK_UNAVAILABLE','Purchase flow is not configured.',503);return purchases;};
  app.use('*', async (context, next) => {
    context.set('requestId', randomUUID());
    context.header('X-Request-ID', context.get('requestId'));
    context.header('Cache-Control', 'no-store');
    await next();
  });
  const limit=bodyLimit({maxSize:8*1024,onError:()=>{throw new AppError('INVALID_INPUT','Request body is too large.');}});
  app.use('*',async (context,next)=>isPurchase(context.req.path) ? limit(context,next) : next());
  app.use('*', async (context, next) => {
    if(!isPurchase(context.req.path)) {await next();return;}
    if (!['GET', 'HEAD'].includes(context.req.method)) {
      if (!isAllowedOrigin(context.req.header('Origin'), publicOrigin)) throw new AppError('FORBIDDEN', 'Request origin is not allowed.', 403);
      if (!context.req.header('Content-Type')?.startsWith('application/json')) throw new AppError('INVALID_INPUT', 'Use application/json.');
      const key = context.req.header('Idempotency-Key');
      if (!key || !/^[\x21-\x7e]{8,128}$/.test(key)) throw new AppError('MISSING_IDEMPOTENCY_KEY', 'Provide an 8–128 character request key.');
      context.set('requestKey', key);
    }
    const { identityId } = await requireIdentity(context);
    context.set('identityId', identityId);
    if (!await store.rateLimit(identityId, 120)) throw new AppError('RATE_LIMITED', 'Too many requests. Try again next minute.', 429);
    await next();
  });

  app.get('/banking/account',context => purchase().funding.account(context.get('identityId')).then(result=>context.json(result)));
  app.get('/banking/activity',context => purchase().funding.activity(context.get('identityId')).then(result=>context.json(result)));
  app.post('/funding',async context => {
    const body=z.object({walletAddress:z.string(),amountMicroUsd:amount}).strict().parse(await context.req.json());
    const accepted=await purchase().funding.create(context.get('identityId'),publicKey(body.walletAddress).toBase58(),body.amountMicroUsd,context.get('requestKey'));
    schedule(()=>purchase().reconcile(context.get('identityId'),true));
    return context.json(accepted,202);
  });
  app.get('/funding/by-key',async context => {
    const key=z.string().min(8).max(128).parse(context.req.query('key'));
    return context.json(await purchase().funding.byKey(context.get('identityId'),key));
  });
  app.get('/funding/:id',async context => {
    const result=await purchase().funding.owned(context.get('identityId'),z.uuid().parse(context.req.param('id')));
    schedule(()=>purchase().reconcile(context.get('identityId'),false));
    return context.json(result);
  });
  app.post('/funding/:id/resume',async context => {
    z.object({}).strict().parse(await context.req.json());
    const result=await purchase().funding.owned(context.get('identityId'),z.uuid().parse(context.req.param('id')));
    schedule(()=>purchase().reconcile(context.get('identityId'),true));
    return context.json(result,202);
  });
  app.get('/wallet/balance',async context => {
    const address=publicKey(z.string().parse(context.req.query('address'))).toBase58();
    if (!await store.verifiedWallet(context.get('identityId'),address)) throw new AppError('FORBIDDEN','Wallet does not belong to this identity.',403);
    return context.json({address,amountMicroUsd:await purchase().subscriptions.chain.paymentBalance(address),asset:'Mock USDC',network:'devnet',confirmation:'finalized',simulation:true});
  });
  app.post('/rounds/:id/subscribe/prepare',async context => {
    const id=z.uuid().parse(context.req.param('id')).toLowerCase();
    const body=z.object({walletAddress:z.string(),grossAmountMicroUsd:amount}).strict().parse(await context.req.json());
    return context.json(await purchase().subscriptions.prepare(context.get('identityId'),id,publicKey(body.walletAddress).toBase58(),body.grossAmountMicroUsd,context.get('requestKey')));
  });
  app.get('/rounds/:id/subscriptions/me',async context => {
    const id=z.uuid().parse(context.req.param('id')).toLowerCase();
    const result=await purchase().subscriptions.portfolio(context.get('identityId'),id);
    schedule(()=>purchase().reconcile(context.get('identityId')));
    return context.json({subscription:result.allocations[0] ?? null,pending:result.pending,holdings:result.holdings,simulation:true});
  });
  app.get('/portfolio',async context => {
    const result=await purchase().subscriptions.portfolio(context.get('identityId'));
    schedule(()=>purchase().reconcile(context.get('identityId')));
    return context.json(result);
  });
  app.post('/rounds/:id/open/prepare',async context=>{
    const id=z.uuid().parse(context.req.param('id'));
    z.object({}).strict().parse(await context.req.json());
    const p=purchase();const row=await loadRound(p.store.pool,id);
    const project=row ? await store.project(row.project_id) : null;
    if(!row || !project || project.founderIdentityId!==context.get('identityId')) throw new AppError('NOT_FOUND','Founder round not found.',404);
    if(!await store.verifiedWallet(context.get('identityId'),project.founderWallet)) throw new AppError('WALLET_NOT_VERIFIED','Verify the founder wallet.',409);
    const requestHash=hash({operation:'open-round',roundId:id,wallet:project.founderWallet});
    const cached=await store.findByKey(context.get('identityId'),context.get('requestKey'));
    if(cached) {
      if(cached.requestHash!==requestHash) throw new AppError('IDEMPOTENCY_CONFLICT','Key was used for a different round.',409);
      return context.json(preparedResponse(cached));
    }
    if(row.status!=='DRAFT') throw new AppError('ROUND_NOT_DRAFT','Round has already opened.',409);
    if(!(p.chain instanceof SolanaChain)) throw new AppError('CHAIN_UNAVAILABLE','Round opening is unavailable.',503);
    const prepared=await p.chain.prepareRound(row,project.founderWallet);
    const number=Buffer.alloc(2);number.writeUInt16LE(row.round_number);
    const roundPda=PublicKey.findProgramAddressSync([Buffer.from('round'),new PublicKey(prepared.projectPda).toBuffer(),number],new PublicKey(p.chain.programAddress()))[0].toBase58();
    const reserved=await store.reserve({...prepared,id:randomUUID(),identityId:context.get('identityId'),projectId:project.id,
      requestKey:context.get('requestKey'),requestHash,status:'Prepared',kind:'Open',roundPda,buyerWallet:project.founderWallet});
    return context.json(preparedResponse(reserved));
  });
  app.post('/transactions/:signature/simulate',async context=>{
    z.object({}).strict().parse(await context.req.json());
    const intent=await store.findBySignature(context.get('identityId'),signature(context.req.param('signature')));
    if(!intent) throw new AppError('NOT_FOUND','Transaction not found.',404);
    if(!chain.simulate) throw new AppError('CHAIN_UNAVAILABLE','Simulation is unavailable.',503);
    return context.json(await chain.simulate(intent));
  });
  app.post('/projects/:id/tokenization/prepare', async context => {
    const id = z.uuid().parse(context.req.param('id')).toLowerCase();
    z.object({}).strict().parse(await context.req.json());
    return context.json(await service.prepare(context.get('identityId'), id, context.get('requestKey')));
  });
  app.get('/projects/:id/tokenization', async context => {
    const id = z.uuid().parse(context.req.param('id')).toLowerCase();
    if (!await store.project(id)) throw new AppError('NOT_FOUND', 'Project not found.', 404);
    const receipt = await chain.receipt(id);
    return context.json({ projectId: id, status: receipt ? 'Finalized' : 'NotTokenized', receipt, simulation: true });
  });
  app.get('/projects/:id/tokenization/balance', async context => {
    const id = z.uuid().parse(context.req.param('id')).toLowerCase();
    if (!await store.project(id)) throw new AppError('NOT_FOUND', 'Project not found.', 404);
    const wallet = publicKey(z.string().parse(context.req.query('wallet'))).toBase58();
    if (!await store.verifiedWallet(context.get('identityId'), wallet)) throw new AppError('FORBIDDEN', 'Wallet does not belong to this identity.', 403);
    return context.json({ projectId: id, wallet, units: await chain.balance(id, wallet), confirmation: 'finalized', simulation: true });
  });
  app.post('/tokenization/allocation/preview', async context => {
    const parsed = allocationSchema.parse(await context.req.json());
    const input = {
      grossAmountMicroUsd: parsed.grossAmountMicroUsd, totalCommittedMicroUsd: parsed.totalCommittedMicroUsd,
      unitPriceMicroUsd: parsed.unitPriceMicroUsd, maxUnits: parsed.maxUnits,
      ...(parsed.cancelled === undefined ? {} : { cancelled: parsed.cancelled }),
    };
    return context.json({ ...allocation(input), provisional: true, simulation: true, feeBps: 100, founderFeeShareBps: 4000 });
  });
  app.post('/rounds/:roundPda/settlement/prepare', async context => {
    const roundPda = publicKey(context.req.param('roundPda')).toBase58();
    const body = z.object({ wallet: z.string() }).strict().parse(await context.req.json());
    const wallet = publicKey(body.wallet).toBase58();
    return context.json(await service.prepareSettlement(context.get('identityId'), roundPda, wallet, context.get('requestKey')));
  });
  app.post('/transactions', async context => {
    const body = z.object({ signedTx: z.string().max(2000),intentId:z.uuid().optional() }).strict().parse(await context.req.json());
    let txSignature: string;
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTx, 'base64'));
      const first = tx.signatures[0];
      if (!first) throw new Error();
      txSignature = bs58.encode(first);
    } catch { throw new AppError('INVALID_TRANSACTION', 'Invalid signed transaction.'); }
    const intent=await store.findBySignature(context.get('identityId'),txSignature);
    if (intent?.kind==='Subscribe') {
      if (!body.intentId) throw new AppError('INVALID_INPUT','Subscription submission requires its intentId.');
      return context.json(await purchase().subscriptions.submit(context.get('identityId'),body.intentId,txSignature,body.signedTx,context.get('requestKey')),202);
    }
    if (body.intentId && intent?.id!==body.intentId) throw new AppError('NOT_FOUND','Transaction intent not found.',404);
    return context.json(await service.submit(context.get('identityId'), txSignature, body.signedTx, context.get('requestKey')), 202);
  });
  app.get('/transactions/:signature', async context => {
    const value=signature(context.req.param('signature'));
    const result=await service.transaction(context.get('identityId'),value);
    if(purchases?.indexer && result.status==='Finalized') await purchases.indexer.ingest(value);
    return context.json({...result,pollUrl:`/api/transactions/${value}`,explorerUrl:`https://explorer.solana.com/tx/${value}?cluster=devnet`});
  });
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    const known = error instanceof AppError;
    const invalid = error instanceof ZodError || error instanceof SyntaxError;
    const code = known ? error.code : invalid ? 'INVALID_INPUT' : 'INTERNAL';
    const status = known ? error.status : invalid ? 400 : 500;
    // Log only operational identifiers; provider errors can contain secrets.
    console.error(JSON.stringify({ requestId: context.get('requestId'), route: context.req.routePath, errorCode: code }));
    return context.json({ error: { code, message: known ? error.message : invalid ? 'Invalid request input.' : 'The request could not be completed.', requestId: context.get('requestId') } }, status);
  });
  app.notFound(context => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: context.get('requestId') } }, 404));
  return app;
}
