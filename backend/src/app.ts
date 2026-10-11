import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Pool } from "pg";
import { GoogleGenAI } from "@google/genai";

import type { ProspectoAuth } from "./auth/better-auth.js";
import { requireIdentity, requireProjectEditor } from "./auth/identity.js";
import { createGeminiResearchModel, type ResearchModel } from "./evidence/research/gemini.js";
import type { ProfileSnapshotLookup } from "./evidence/research/profile-snapshots.js";
import { collectGithub } from "./evidence/research/github.js";
import { safeFetch } from "./evidence/research/safe-fetch.js";
import { createAuthRouter } from "./routes/auth.js";
import { createEvidenceIntakeRouter } from "./routes/evidence-intake.js";
import { createProfilesRouter } from "./routes/profiles.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createGeminiTickerNamer, type TickerNamer } from "./projects/ticker-ai.js";
import { createRoundsRouter } from "./routes/rounds.js";
import { createWalletsRouter } from "./routes/wallets.js";
import { createResearchRouter } from "./routes/research.js";

import { PgStore } from './purchase/db/store.js';
import type { Chain } from './purchase/tokenization/types.js';
import { AppError } from './purchase/http/errors.js';
const unavailableChain = new Proxy({} as Chain, {get:()=>async()=>{throw new AppError('CHAIN_UNAVAILABLE','Devnet purchases are not configured.',503);}});

import { createPurchaseRouter } from './purchase/router.js';
import type { PurchaseServices } from './purchase/runtime.js';
import { readiness } from './readiness.js';

export interface ApiDependencies {
  purchases?: PurchaseServices;
  pool: Pool;
  /** PUBLIC_ORIGIN: non-GET requests must carry this Origin (BACKEND_STACK §7). */
  publicOrigin: string;
  /** PROGRAM_ID of the deployed program; null until it exists. */
  programId?: string | null;
  /** DEMO_MODE only: rounds may cite the DRAFT model (its hash still pins the parameters). */
  allowDraftModel?: boolean;
  ai: GoogleGenAI;
  model: string;
  /** Overrides the Gemini ticker namer (tests). */
  nameTicker?: TickerNamer;
  /** Optional; raises GitHub's unauthenticated limit of 60 requests/hour. */
  githubToken?: string;
  auth: ProspectoAuth;
  /** EMAIL_HASH_PEPPER: HMAC key for identities.campus_email_hash. */
  emailHashPepper: string;
  campusDomains: readonly string[];
  /** Evidence-research model; defaults to direct Gemini (ai + model). */
  researchModel?: ResearchModel;
  /** Founder-provided LinkedIn snapshots (M§6.5); optional. */
  lookupProfileSnapshot?: ProfileSnapshotLookup;
  /** Keeps background research alive after the response (Vercel's waitUntil); defaults to next tick. */
  runInBackground?: (task: () => Promise<void>) => void;
  /** DEMO_MODE only: POST /api/demo/sign-in signs in any campus email without a code. */
  demoSignIn?: boolean;
}

export function createApi(dependencies: ApiDependencies): Hono {
  const app = new Hono();
  // Responses carry per-user data; Vercel's CDN honors upstream cache headers on rewrites.
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });
  const identityDependencies = {
    pool: dependencies.pool,
    auth: dependencies.auth,
    emailHashPepper: dependencies.emailHashPepper,
    campusDomains: dependencies.campusDomains,
  };
  const requireEditor = (context: Context, projectId: string) =>
    requireProjectEditor(context, projectId, identityDependencies);

  app.get("/api/health", (context) => context.json({ status: "ok" }));
  app.get('/api/status',context=>context.json({...readiness(),backendConfigured:true,
    purchasesEnabled:Boolean(dependencies.purchases),nessieEnabled:dependencies.purchases?.funding.options.enabled ?? false,demoMode:dependencies.demoSignIn ?? false}));
  app.route("/api", createAuthRouter({ ...identityDependencies, demoSignIn: dependencies.demoSignIn }));
  const routeGuards = {
    pool: dependencies.pool,
    publicOrigin: dependencies.publicOrigin,
    requireIdentity: (context: Context) => requireIdentity(context, identityDependencies),
  };
  app.route('/api',createPurchaseRouter(dependencies.purchases?.store ?? new PgStore(dependencies.pool),
    dependencies.purchases?.chain ?? unavailableChain, dependencies.publicOrigin,dependencies.purchases,
    routeGuards.requireIdentity,dependencies.runInBackground));
  app.route(
    "/api",
    createProjectsRouter({
      ...routeGuards,
      requireProjectEditor: requireEditor,
      nameTicker: dependencies.nameTicker ?? createGeminiTickerNamer(dependencies.ai, dependencies.model),
    }),
  );
  app.route("/api", createProfilesRouter(routeGuards));
  app.route("/api", createWalletsRouter(routeGuards));
  app.route(
    "/api",
    createRoundsRouter({
      ...routeGuards,
      requireProjectEditor: requireEditor,
      programId: dependencies.programId ?? null,
      allowDraftModel: dependencies.allowDraftModel ?? false,
    }),
  );
  app.route("/api", createEvidenceIntakeRouter({ ...dependencies, requireProjectEditor: requireEditor }));
  app.route(
    "/api",
    createResearchRouter({
      pool: dependencies.pool,
      model: dependencies.researchModel ?? createGeminiResearchModel(dependencies.ai, dependencies.model),
      fetchPage: safeFetch,
      collectGithub: (target, projectSiteKey) => collectGithub(target, projectSiteKey, { token: dependencies.githubToken }),
      requireProjectEditor: requireEditor,
      lookupProfileSnapshot: dependencies.lookupProfileSnapshot,
      runInBackground: dependencies.runInBackground,
    }),
  );

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    return context.json({ error: { code: "INTERNAL" } }, 500);
  });

  return app;
}

type FetchHandler = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/**
 * Next.js (trailingSlash: true) can redirect /api/x to /api/x/ before a proxy forwards it.
 * Hono and Better Auth both match paths strictly, so strip the slash before routing.
 */
export function stripApiTrailingSlash<F extends FetchHandler>(fetch: F): F {
  return ((request: Request, ...rest: never[]) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") || !url.pathname.endsWith("/")) return fetch(request, ...rest);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return fetch(new Request(url, request), ...rest);
  }) as F;
}
