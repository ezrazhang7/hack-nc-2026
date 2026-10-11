import { createHash } from "node:crypto";

import { Hono, type Context } from "hono";
import type { Pool } from "pg";
import { z } from "zod";

import { canonicalLinkedinUrl } from "../evidence/research/profile-snapshots.js";
import { rejectForeignOrigin, type AllowedOrigins } from "./guards.js";

export interface ProfilesRouterDependencies {
  pool: Pool;
  publicOrigin: AllowedOrigins;
  requireIdentity: (context: Context) => Promise<{ identityId: string }>;
}

const MAX_LIVE_SNAPSHOTS = 5;
const snapshotSchema = z.object({ profile_url: z.string().trim().max(2048), text: z.string().trim().min(1).max(20_000) }).strict();
const uuid = z.string().uuid();

/**
 * Founder-provided LinkedIn profile text (M§6.5). LinkedIn is never fetched; the founder pastes
 * their own profile. Research uses it for projects the founder belongs to; claims from it stay
 * founder-attested unless a third-party page corroborates them. Delete erases the text.
 */
export function createProfilesRouter(deps: ProfilesRouterDependencies): Hono {
  const router = new Hono();

  router.get("/me/profile-snapshots", async (context) => {
    const { identityId } = await deps.requireIdentity(context);
    const { rows } = await deps.pool.query(
      `select id, profile_url, source, text, captured_at from profile_snapshots
        where identity_id = $1 and deleted_at is null order by captured_at desc`,
      [identityId],
    );
    return context.json({ snapshots: rows });
  });

  router.post("/me/profile-snapshots", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const body = snapshotSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: { code: "INVALID_INPUT", message: "Send profile_url and text (up to 20,000 characters)." } }, 400);
    const profileUrl = canonicalLinkedinUrl(body.data.profile_url);
    if (!profileUrl) return context.json({ error: { code: "INVALID_INPUT", message: "profile_url must be a linkedin.com/in/<handle> profile." } }, 400);
    const text = body.data.text.normalize("NFKC");

    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select pg_advisory_xact_lock(hashtext('profile:' || $1))`, [identityId]);
      // Saving again replaces the live snapshot for this profile; the old text is erased, not kept.
      await client.query(
        `update profile_snapshots set deleted_at = now(), text = null, content_hash = null
          where identity_id = $1 and profile_url = $2 and deleted_at is null`,
        [identityId, profileUrl],
      );
      const live = await client.query<{ n: string }>(
        `select count(*)::text as n from profile_snapshots where identity_id = $1 and deleted_at is null`,
        [identityId],
      );
      if (Number(live.rows[0].n) >= MAX_LIVE_SNAPSHOTS) {
        await client.query("rollback");
        return context.json({ error: { code: "SNAPSHOT_LIMIT", message: `At most ${MAX_LIVE_SNAPSHOTS} saved profiles.` } }, 409);
      }
      const { rows } = await client.query(
        `insert into profile_snapshots (identity_id, profile_url, source, text, content_hash)
         values ($1, $2, 'PASTED_TEXT', $3, $4)
         returning id, profile_url, source, captured_at`,
        [identityId, profileUrl, text, createHash("sha256").update(text).digest("hex")],
      );
      await client.query("commit");
      return context.json({ snapshot: rows[0] }, 201);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  router.delete("/me/profile-snapshots/:id", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const id = uuid.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    const result = await deps.pool.query(
      `update profile_snapshots set deleted_at = now(), text = null, content_hash = null
        where id = $1 and identity_id = $2 and deleted_at is null`,
      [id.data, identityId],
    );
    return result.rowCount ? context.body(null, 204) : context.json({ error: { code: "NOT_FOUND" } }, 404);
  });

  return router;
}
