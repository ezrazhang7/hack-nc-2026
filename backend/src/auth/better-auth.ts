import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { Pool } from "pg";

import { isCampusEmail } from "./campus-email.js";
import type { OtpSender } from "./otp-delivery.js";

export interface AuthOptions {
  /** Pool whose search_path is the auth schema; see createAuthPool. */
  authPool: Pool;
  /** BETTER_AUTH_SECRET: signs session cookies and hashes stored OTPs. */
  secret: string;
  /** PUBLIC_ORIGIN, e.g. http://localhost:8787; the only trusted origin (same-origin static export). */
  baseURL: string;
  campusDomains: readonly string[];
  sendOtp: OtpSender;
  /** Defaults to true outside http://localhost. */
  secureCookies?: boolean;
}

// Campus email codes are the only sign-in method; these are the two endpoints that accept an email.
const EMAIL_PATHS = new Set(["/email-otp/send-verification-otp", "/sign-in/email-otp"]);

/** Better Auth reaches only its own tables (migration 0001, schema "auth"). */
export function createAuthPool(connectionString: string, poolOptions: { max?: number; idleTimeoutMillis?: number } = {}): Pool {
  return new Pool({ connectionString, ...poolOptions, options: "-c search_path=auth" });
}

export function createAuth(options: AuthOptions) {
  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [options.baseURL],
    database: options.authPool,
    advanced: {
      // auth.* ids are uuid columns, and identities.auth_user_id references auth."user"(id).
      database: { generateId: "uuid" },
      cookiePrefix: "prospecto",
      useSecureCookies: options.secureCookies ?? !options.baseURL.startsWith("http://localhost"),
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!EMAIL_PATHS.has(ctx.path)) return;
        const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown };
        if (typeof body.email !== "string" || !isCampusEmail(body.email, options.campusDomains)) {
          throw new APIError("BAD_REQUEST", { message: "Use an email address this server accepts." });
        }
        if (ctx.path === "/email-otp/send-verification-otp" && body.type !== "sign-in") {
          throw new APIError("BAD_REQUEST", { message: "Only sign-in codes are supported." });
        }
      }),
    },
    plugins: [
      emailOTP({
        // BACKEND_STACK §4: 10-minute codes, at most 5 attempts, stored hashed.
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return;
          // Not awaited, per Better Auth guidance, so response time does not reveal delivery.
          void options.sendOtp(email, otp).catch((error: unknown) => {
            console.error("sign-in code delivery failed:", error instanceof Error ? error.message : "unknown error");
          });
        },
      }),
    ],
  });
}

export type ProspectoAuth = ReturnType<typeof createAuth>;
