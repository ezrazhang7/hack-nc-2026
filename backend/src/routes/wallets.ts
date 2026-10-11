import { randomBytes } from "node:crypto";

import { Hono, type Context } from "hono";
import type { Pool } from "pg";
import { z } from "zod";

import { challengeMessage, isSolanaAddress, verifyWalletSignature } from "../wallets/solana.js";
import { rejectForeignOrigin, type AllowedOrigins } from "./guards.js";

export interface WalletsRouterDependencies {
  pool: Pool;
  publicOrigin: AllowedOrigins;
  requireIdentity: (context: Context) => Promise<{ identityId: string }>;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const addressSchema = z.object({ address: z.string().trim().refine(isSolanaAddress, "not a Solana address") }).strict();
const verifySchema = z.object({ address: z.string().trim().refine(isSolanaAddress), signature: z.string().trim().min(64).max(128) }).strict();

/**
 * Wallet binding (M§7.2 step 2, §10.1): a signed, single-use, expiring nonce proves the caller
 * controls the wallet. The database keeps a wallet on one identity forever and caps identities at
 * two active wallets, so a new wallet never creates a new eligible identity.
 */
export function createWalletsRouter(deps: WalletsRouterDependencies): Hono {
  const router = new Hono();

  router.post("/wallets/challenge", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const body = addressSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: { code: "INVALID_INPUT", message: "Send a Solana wallet address." } }, 400);
    const nonce = randomBytes(24).toString("base64url");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const message = challengeMessage(body.data.address, nonce, issuedAt, expiresAt);
    await deps.pool.query(
      `insert into wallet_challenges (nonce, wallet_address, identity_id, message, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)`,
      [nonce, body.data.address, identityId, message, issuedAt, expiresAt],
    );
    return context.json({ message, nonce, expiresAt: expiresAt.toISOString() }, 201);
  });

  router.post("/wallets/verify", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const body = verifySchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: { code: "INVALID_INPUT", message: "Send address and the base58 signature." } }, 400);
    const { address, signature } = body.data;

    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      // Consume the newest live challenge for this identity + wallet; each nonce works once.
      const challenge = await client.query<{ message: string }>(
        `update wallet_challenges set consumed_at = now()
          where nonce = (select nonce from wallet_challenges
                          where identity_id = $1 and wallet_address = $2 and consumed_at is null and expires_at > now()
                          order by created_at desc limit 1 for update)
          returning message`,
        [identityId, address],
      );
      const message = challenge.rows[0]?.message;
      if (!message || !verifyWalletSignature(address, message, signature)) {
        await client.query("commit"); // A failed attempt still burns the nonce.
        return context.json({ error: { code: "WALLET_NOT_VERIFIED", message: "Signature did not match a live challenge. Request a new one." } }, 409);
      }
      const existing = await client.query<{ identity_id: string; revoked_at: Date | null }>(
        `select identity_id, revoked_at from wallets where address = $1`,
        [address],
      );
      const row = existing.rows[0];
      if (row && row.identity_id !== identityId) {
        await client.query("commit");
        return context.json({ error: { code: "WALLET_TAKEN", message: "This wallet is bound to another account." } }, 409);
      }
      if (!row) {
        const hasPrimary = await client.query(
          `select 1 from wallets where identity_id = $1 and is_primary and revoked_at is null`,
          [identityId],
        );
        await client.query(
          `insert into wallets (address, identity_id, verified_signature, is_primary) values ($1, $2, $3, $4)`,
          [address, identityId, signature, hasPrimary.rowCount === 0],
        );
      } else if (row.revoked_at) {
        await client.query(`update wallets set revoked_at = null, verified_signature = $2 where address = $1`, [address, signature]);
      }
      await client.query("commit");
      const wallet = await deps.pool.query<{ address: string; is_primary: boolean }>(
        `select address, is_primary from wallets where address = $1`,
        [address],
      );
      return context.json({ wallet: { address, isPrimary: wallet.rows[0].is_primary } });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      // guard_wallet_binding: at most 2 active wallets per identity.
      if ((error as { code?: string }).code === "23514") {
        return context.json({ error: { code: "WALLET_LIMIT", message: "Two wallets are already bound. Revoke one first." } }, 409);
      }
      throw error;
    } finally {
      client.release();
    }
  });

  return router;
}
