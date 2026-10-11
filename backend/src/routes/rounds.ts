import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Pool } from "pg";
import { z } from "zod";

import {
  RoundError,
  createRoundDraft,
  deleteDraftRound,
  loadRound,
  loadRoundValuation,
  publicRound,
  quoteRound,
} from "../rounds/service.js";
import { ValuationServiceError, previewValuation } from "../valuation/service.js";
import { rejectForeignOrigin, type AllowedOrigins } from "./guards.js";
import { onceForKey, requireIdempotencyKey } from "./idempotency.js";

export interface RoundsRouterDependencies {
  pool: Pool;
  publicOrigin: AllowedOrigins;
  /** PROGRAM_ID, once the program is deployed; null keeps rounds at AWAITING_PROGRAM. */
  programId: string | null;
  /** DEMO_MODE only: rounds may cite the DRAFT model (its hash still pins the parameters). */
  allowDraftModel: boolean;
  requireIdentity: (context: Context) => Promise<{ identityId: string }>;
  requireProjectEditor: (context: Context, projectId: string) => Promise<{ identityId: string }>;
}

const uuid = z.string().uuid();
const draftSchema = z
  .object({
    max_units: z.string().regex(/^\d{1,19}$/).optional(),
    duration_days: z.number().int().optional(),
    opens_at: z.string().datetime().optional(),
    max_subscription_micro_usd: z.string().regex(/^\d{1,19}$/).optional(),
  })
  .strict();

function failWith(context: Context, error: unknown) {
  if (error instanceof RoundError || error instanceof ValuationServiceError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.httpStatus);
  }
  throw error;
}

/** 404 for drafts unless the caller can edit the project, so unpublished terms cannot be probed. */
async function visibleRound(deps: RoundsRouterDependencies, context: Context, roundId: string) {
  if (!uuid.safeParse(roundId).success) return null;
  const round = await loadRound(deps.pool, roundId);
  if (!round) return null;
  if (round.status === "DRAFT" || round.status === "CANCELLED") {
    try {
      await deps.requireProjectEditor(context, round.project_id);
    } catch (error) {
      if (error instanceof HTTPException) return null;
      throw error;
    }
  }
  return round;
}

export function createRoundsRouter(deps: RoundsRouterDependencies): Hono {
  const router = new Hono();

  // M§7.3 steps 1–4 (freeze snapshot, compute, hash, record) plus the open_round arguments for step 5.
  router.post("/projects/:projectId/rounds", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const projectId = uuid.safeParse(context.req.param("projectId"));
    if (!projectId.success) return context.json({ error: { code: "INVALID_PROJECT_ID" } }, 400);
    const { identityId } = await deps.requireProjectEditor(context, projectId.data);
    const key = requireIdempotencyKey(context);
    const body = draftSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return context.json({ error: { code: "INVALID_INPUT", message: body.error.issues[0]?.message ?? "Invalid input." } }, 400);

    try {
      const valuation = await previewValuation(deps.pool, projectId.data);
      const client = await deps.pool.connect();
      try {
        await client.query("begin");
        const result = await onceForKey(client, { identityId, operation: `open_round:${projectId.data}`, key, body: body.data }, async () => ({
          status: 201,
          body: await createRoundDraft(client, {
            projectId: projectId.data,
            identityId,
            request: body.data,
            valuation,
            allowDraftModel: deps.allowDraftModel,
            programId: deps.programId,
          }),
        }));
        await client.query("commit");
        return context.json(result.body, result.status);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      return failWith(context, error);
    }
  });

  router.get("/rounds/:roundId", async (context) => {
    const round = await visibleRound(deps, context, context.req.param("roundId"));
    if (!round) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    const project = await deps.pool.query<{ slug: string; name: string }>(`select slug, name from projects where id = $1`, [round.project_id]);
    return context.json({ round: publicRound(round), project: project.rows[0], valuation: await loadRoundValuation(deps.pool, round) });
  });

  router.get("/rounds/:roundId/quote", async (context) => {
    const round = await visibleRound(deps, context, context.req.param("roundId"));
    if (!round) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    const gross = context.req.query("gross_micro_usd");
    if (!gross || !/^\d{1,19}$/.test(gross)) return context.json({ error: { code: "INVALID_INPUT", message: "Pass gross_micro_usd as a whole number." } }, 400);
    try {
      return context.json({ quote: quoteRound(round, BigInt(gross)) });
    } catch (error) {
      return failWith(context, error);
    }
  });

  router.delete("/rounds/:roundId", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const roundId = uuid.safeParse(context.req.param("roundId"));
    if (!roundId.success) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    try {
      await deleteDraftRound(deps.pool, roundId.data, identityId);
      return context.body(null, 204);
    } catch (error) {
      return failWith(context, error);
    }
  });

  return router;
}
