import { GoogleGenAI } from "@google/genai";
import type { Hono } from "hono";
import { Pool } from "pg";

import { loadPurchaseServices } from './purchase/runtime.js';
import { createApi } from "./app.js";
import { createAuth, createAuthPool } from "./auth/better-auth.js";
import { createOtpSender } from "./auth/otp-delivery.js";
import { loadConfig, type Config } from "./config.js";
import { createOpenRouterResearchModel } from "./evidence/research/openrouter.js";
import { loadProfileSnapshots } from "./evidence/research/profile-snapshots.js";
import { safeFetch } from "./evidence/research/safe-fetch.js";
import type { ResearchDependencies } from "./evidence/research/runner.js";

export interface BootstrapOptions {
  /** Extra pg Pool settings, e.g. a small pool per Vercel instance. */
  poolOptions?: { max?: number; idleTimeoutMillis?: number };
  /** Keeps background research alive after the response (Vercel's waitUntil). */
  runInBackground?: ResearchDependencies["runInBackground"];
}

export interface Bootstrapped {
  app: Hono;
  config: Config;
  pool: Pool;
  authPool: Pool;
}

/** Shared by the local server (src/index.ts) and the Vercel entry (server.ts). */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Bootstrapped> {
  const config = loadConfig();

  const pool = new Pool({ connectionString: config.DATABASE_URL, ...options.poolOptions });
  const authPool = createAuthPool(config.DATABASE_URL, options.poolOptions);
  // An idle client can error when Tiger drops the connection; log it instead of crashing.
  for (const p of [pool, authPool]) {
    p.on("error", (error) => console.error("postgres pool error:", error.message));
  }

  // Invalid snapshot files fail startup rather than silently dropping founder-provided data.
  const lookupProfileSnapshot = config.PROFILE_SNAPSHOT_FILES?.length
    ? await loadProfileSnapshots(config.PROFILE_SNAPSHOT_FILES)
    : undefined;

  const researchModel =
    config.RESEARCH_PROVIDER === "openrouter" && config.OPENROUTER_API_KEY
      ? createOpenRouterResearchModel({
          apiKey: config.OPENROUTER_API_KEY,
          model: config.OPENROUTER_MODEL,
          fetchPage: safeFetch,
          appUrl: config.PUBLIC_ORIGIN,
        })
      : undefined;

  const app = createApi({
    pool,
    purchases:await loadPurchaseServices(pool,config),
    publicOrigin: config.PUBLIC_ORIGIN,
    trustedOrigins: config.TRUSTED_ORIGINS,
    programId: config.PROGRAM_ID ?? null,
    allowDraftModel: config.DEMO_MODE,
    ai: new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }),
    model: config.GEMINI_MODEL,
    githubToken: config.GITHUB_TOKEN,
    auth: createAuth({
      authPool,
      secret: config.BETTER_AUTH_SECRET,
      baseURL: config.PUBLIC_ORIGIN,
      trustedOrigins: config.TRUSTED_ORIGINS,
      campusDomains: config.CAMPUS_EMAIL_DOMAINS,
      sendOtp: createOtpSender(config.otpDelivery),
    }),
    emailHashPepper: config.EMAIL_HASH_PEPPER,
    campusDomains: config.CAMPUS_EMAIL_DOMAINS,
    lookupProfileSnapshot,
    researchModel,
    runInBackground: options.runInBackground,
    demoSignIn: config.DEMO_MODE,
  });

  return { app, config, pool, authPool };
}
