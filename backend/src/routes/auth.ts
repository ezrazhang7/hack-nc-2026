import { Hono } from "hono";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { demoSignInEmail, isCampusEmail } from "../auth/campus-email.js";
import { requireIdentity, type IdentityDependencies } from "../auth/identity.js";

export interface AuthRouterDependencies extends IdentityDependencies {
  /** DEMO_MODE only; see POST /api/demo/sign-in below. */
  demoSignIn?: boolean;
}

const demoSignInSchema = z.object({ email: z.string().max(254).optional() });

/**
 * Better Auth owns /api/auth/* (campus email codes, sessions, sign-out):
 *   POST /api/auth/email-otp/send-verification-otp  { email, type: "sign-in" }
 *   POST /api/auth/sign-in/email-otp                { email, otp }
 *   GET  /api/auth/get-session, POST /api/auth/sign-out
 * GET /api/me adds the Prospecto identity on top of the session.
 *
 * DEMO SHORTCUT (DEMO_MODE=true only): POST /api/demo/sign-in { email? } signs in without sending a
 * code. Any input works (demoSignInEmail): an email as typed, other text as a stable guest, blank as a
 * new guest. It proves nothing about who is typing, so the UI must not call the result verified.
 * Production replacement: the emailed-code flow above.
 */
export function createAuthRouter(dependencies: AuthRouterDependencies): Hono {
  const router = new Hono();

  router.all("/auth/*", (context) => dependencies.auth.handler(context.req.raw));

  if (dependencies.demoSignIn) {
    router.post("/demo/sign-in", async (context) => {
      // Same-origin only, like Better Auth's own endpoints (blocks login CSRF from other sites).
      if (context.req.header("origin") !== new URL(dependencies.auth.options.baseURL ?? "").origin) {
        return context.json({ error: { code: "INVALID_ORIGIN" } }, 403);
      }
      const body = demoSignInSchema.safeParse(await context.req.json().catch(() => ({})));
      if (!body.success) return context.json({ error: { code: "INVALID_INPUT" } }, 400);
      const email = demoSignInEmail(body.data.email, randomUUID);
      if (!isCampusEmail(email, dependencies.campusDomains)) {
        return context.json({ error: { code: "CAMPUS_EMAIL_REQUIRED", message: "This server only accepts its configured email domains." } }, 400);
      }
      // Mint a code server-side and redeem it at once, so sessions and identities follow the normal path.
      const otp = await dependencies.auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
      return dependencies.auth.api.signInEmailOTP({
        body: { email, otp },
        headers: context.req.raw.headers,
        asResponse: true,
      });
    });
  }

  router.get("/me", async (context) => {
    const { identityId } = await requireIdentity(context, dependencies);
    const wallets = await dependencies.pool.query<{ address: string; is_primary: boolean }>(
      `select address, is_primary
         from wallets
        where identity_id = $1 and revoked_at is null
        order by created_at`,
      [identityId],
    );
    return context.json({
      identityId,
      verified: true,
      // True when DEMO_MODE sign-in is on: "verified" then means only "signed in", not email ownership.
      demoMode: dependencies.demoSignIn ?? false,
      wallets: wallets.rows.map((wallet) => ({ address: wallet.address, isPrimary: wallet.is_primary })),
    });
  });

  return router;
}
