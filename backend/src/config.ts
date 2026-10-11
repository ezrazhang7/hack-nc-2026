import { z } from "zod";

import { parseCampusDomains } from "./auth/campus-email.js";
import type { OtpDeliveryConfig } from "./auth/otp-delivery.js";

// Names and meanings follow docs/BACKEND_STACK.md §12.
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PUBLIC_ORIGIN: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string (Tiger console → service → Connect)"),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters (try: openssl rand -base64 32)"),
  EMAIL_HASH_PEPPER: z.string().min(16, "must be at least 16 characters (try: openssl rand -base64 32)"),
  CAMPUS_EMAIL_DOMAINS: z.string().transform((value, context) => {
    try {
      return parseCampusDomains(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid" });
      return z.NEVER;
    }
  }),
  DEMO_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  RESEND_API_KEY: z.string().min(1).optional(),
  OTP_EMAIL_FROM: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1),
  // Evidence research transport (EVIDENCE_RESEARCH §3): direct Gemini, or Gemini via OpenRouter.
  RESEARCH_PROVIDER: z.enum(["gemini", "openrouter"]).default("gemini"),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  GITHUB_TOKEN: z.string().min(1).optional(),
  // Deployed Anchor program (BACKEND_STACK §12). Unset: rounds stop at AWAITING_PROGRAM.
  PROGRAM_ID: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address").optional(),
  PURCHASES_ENABLED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  SOLANA_RPC_URL: z.url().default('https://api.devnet.solana.com'),
  PAYMENT_MINT: z.string().optional(),
  RELAYER_SECRET_KEY: z.string().optional(),
  PROGRAM_IDL_PATH: z.string().optional(),
  NESSIE_ENABLED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  FUNDING_PAUSED: z.enum(['true','false']).default('false').transform(value=>value==='true'),
  NESSIE_API_KEY: z.string().optional(), NESSIE_BASE_URL: z.url().optional(),
  NESSIE_PROFILE: z.string().optional(), NESSIE_PROFILE_PATH: z.string().optional(), NESSIE_TREASURY_ACCOUNT_ID: z.string().optional(),
  DEMO_GENERATION_ID: z.string().min(1).max(100).default('demo-v1'),
  // Comma-separated founder-provided LinkedIn snapshot files (MARKET ARCHITECTURE §6.5),
  // e.g. ../db/fixtures/demo-linkedin-snapshot.json. Unset: LinkedIn links stay unreadable.
  PROFILE_SNAPSHOT_FILES: z
    .string()
    .transform((value) => value.split(",").map((path) => path.trim()).filter((path) => path.length > 0))
    .optional(),
});

export type Config = z.infer<typeof envSchema> & { otpDelivery: OtpDeliveryConfig };

/** Parses process.env, failing with every problem listed by variable name (never by value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat blank `NAME=` lines in .env files as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment (see docs/BACKEND_STACK.md §12):\n${problems.join("\n")}`);
  }

  const config = parsed.data;
  if (config.RESEARCH_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY) {
    throw new Error("Invalid environment: RESEARCH_PROVIDER=openrouter needs OPENROUTER_API_KEY (openrouter.ai → Keys).");
  }
  let otpDelivery: OtpDeliveryConfig;
  if (config.DEMO_MODE) {
    otpDelivery = { mode: "demo" };
  } else if (config.RESEND_API_KEY && config.OTP_EMAIL_FROM) {
    otpDelivery = { mode: "resend", apiKey: config.RESEND_API_KEY, from: config.OTP_EMAIL_FROM };
  } else {
    // Fail closed: without a sender, nobody could sign in and codes would silently vanish.
    throw new Error("Invalid environment: set RESEND_API_KEY and OTP_EMAIL_FROM, or DEMO_MODE=true to log codes.");
  }
  return { ...config, otpDelivery };
}
