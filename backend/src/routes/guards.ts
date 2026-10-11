import type { Context } from "hono";

/** PUBLIC_ORIGIN, optionally followed by TRUSTED_ORIGINS (e.g. the *.vercel.app fallback). */
export type AllowedOrigins = string | readonly string[];

/** Exact origin match only; a missing Origin header is never allowed. */
export function isAllowedOrigin(origin: string | undefined, allowed: AllowedOrigins): boolean {
  if (!origin) return false;
  const list = typeof allowed === "string" ? [allowed] : allowed;
  return list.some((entry) => new URL(entry).origin === origin);
}

/**
 * BACKEND_STACK §7: non-GET requests must come from PUBLIC_ORIGIN (or a TRUSTED_ORIGINS entry).
 * Session cookies ride along on cross-site requests, so this is the CSRF control for routes
 * outside Better Auth.
 */
export function rejectForeignOrigin(context: Context, publicOrigin: AllowedOrigins): Response | null {
  if (isAllowedOrigin(context.req.header("origin"), publicOrigin)) return null;
  return context.json({ error: { code: "INVALID_ORIGIN", message: "Requests must come from the Prospecto site." } }, 403);
}
