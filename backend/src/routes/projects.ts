import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { normalizeUrl } from "../evidence/research/urls.js";
import { TICKER, availableTicker, tickerCandidates } from "../projects/ticker.js";
import type { TickerNamer } from "../projects/ticker-ai.js";
import { STAGES } from "../valuation/quality-scores.js";
import { ValuationServiceError, previewValuation } from "../valuation/service.js";
import { rejectForeignOrigin, type AllowedOrigins } from "./guards.js";
import { onceForKey, requireIdempotencyKey } from "./idempotency.js";

export interface ProjectsRouterDependencies {
  pool: Pool;
  /** Gemini ticker picks for new projects; omitted or failing → deterministic candidates. */
  nameTicker?: TickerNamer;
  publicOrigin: AllowedOrigins;
  requireIdentity: (context: Context) => Promise<{ identityId: string }>;
  requireProjectEditor: (context: Context, projectId: string) => Promise<{ identityId: string }>;
}

// Demo guard against runaway creation; the M§7.2 wallet step will gate this in production.
const MAX_PROJECTS_PER_FOUNDER = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // Market symbol (QPY); omitted → the first free suggestion for the name.
    ticker: z.string().trim().toUpperCase().regex(TICKER, "ticker must be 2–5 letters").optional(),
    tagline: z.string().trim().max(140).default(""),
    stage: z.enum(STAGES),
    entity_type: z.enum(["UNINCORPORATED", "INCORPORATED"]).default("UNINCORPORATED"),
    legal_name: optionalText(200),
    formation_state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).nullable().optional(),
    website_url: z.string().trim().max(2048).nullable().optional(),
    sector_code: z.string().regex(/^[a-z0-9_]+$/).nullable().optional(),
    // Privacy-safe default: a contact address is never public unless a future UI explicitly opts in.
    publish_contact_email: z.boolean().default(false),
    // Listing only; names and titles carry zero weight in scoring (M§2.3).
    founder: z.object({ display_name: z.string().trim().min(1).max(120), role_title: optionalText(80) }),
  })
  .strict()
  .refine((body) => body.entity_type === "INCORPORATED" || (!body.legal_name && !body.formation_state), {
    message: "legal_name and formation_state apply only to incorporated companies",
  });

export function slugBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  // Slugs share the /projects/:x path with ids, so never let one look like a uuid.
  return !base ? "project" : UUID.test(base) ? `p-${base}`.slice(0, 60) : base;
}

const fail = (status: 400 | 403 | 404 | 409, code: string, message: string) =>
  new HTTPException(status, { res: Response.json({ error: { code, message } }, { status }) });

async function freeSlug(client: PoolClient, base: string): Promise<string> {
  // Serialize creators of the same base slug so the suffix choice cannot race.
  await client.query(`select pg_advisory_xact_lock(hashtext('slug:' || $1))`, [base]);
  const { rows } = await client.query<{ slug: string }>(`select slug from projects where slug = $1 or slug like $1 || '-%'`, [base]);
  const taken = new Set(rows.map((row) => row.slug));
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw fail(409, "SLUG_UNAVAILABLE", "Too many projects share this name.");
}

// Current round: the latest one that reached the chain (drafts and cancellations stay private).
// Backers are distinct identities with a confirmed subscription.
const CURRENT_ROUND_SQL = `(select json_build_object('id', r.id, 'round_number', r.round_number, 'status', r.status, 'opens_at', r.opens_at,
                                  'closes_at', r.closes_at, 'unit_price_micro_usd', r.unit_price_micro_usd::text,
                                  'max_units', r.max_units::text, 'target_amount_micro_usd', r.target_amount_micro_usd::text,
                                  'max_subscription_micro_usd', r.max_subscription_micro_usd::text, 'protocol_fee_bps', r.protocol_fee_bps,
                                  'total_committed_micro_usd', r.total_committed_micro_usd::text,
                                  'backers', (select count(distinct sub.identity_id) from subscriptions sub
                                               where sub.round_id = r.id and sub.status in ('CONFIRMED', 'FINALIZED')))
           from rounds r where r.project_id = p.id and r.status not in ('DRAFT', 'CANCELLED')
          order by r.round_number desc limit 1)`;

// M§10.4 "why is this the price?" for valuation snapshot v: model weights, category and sub-factor
// scores with their confidence, scenario probabilities, the blend, and the demand adjustment.
// Claims stay private: no ids, metric codes, or values, only each sub-factor's score, confidence, and status.
const EXPLANATION_SQL = `(select json_build_object(
          'model_status', m.status, 'factor_weights', m.factor_weights,
          'alpha', v.assumptions->'alpha', 'operating', (v.assumptions->'operating') - 'revenue_claim_id',
          'demand', v.assumptions->'demand', 'notes', v.assumptions->'notes', 'scenarios', v.scenario_details,
          'categories', s.factor_contributions->'categories',
          'subfactors', (select coalesce(jsonb_agg(f - 'claim_id' - 'metric_code'), '[]'::jsonb) from jsonb_array_elements(s.factor_contributions->'subfactors') f))
         from model_versions m, score_snapshots s
        where m.id = v.model_version_id and s.valuation_run_id = v.valuation_run_id
        limit 1)`;

interface PublicProjectRow {
  id: string;
  slug: string;
  ticker: string | null;
  name: string;
  tagline: string;
  description: string;
  stage: string;
  status: string;
  entity_type: string;
  legal_name: string | null;
  formation_state: string | null;
  website_url: string | null;
  sector_code: string | null;
  contact_email: string | null;
  founders: { display_name: string; role_title: string | null; role: string }[];
  valuation: Record<string, unknown> | null;
  round: Record<string, unknown> | null;
}

/** Public profile: listing fields, founders, published contact, latest valuation. Never private evidence. */
async function loadPublicProject(pool: Pool, where: "slug" | "id", value: string): Promise<PublicProjectRow | null> {
  const { rows } = await pool.query<PublicProjectRow>(
    `select p.id, p.slug, p.ticker, p.name, p.tagline, p.description, p.stage::text as stage, p.status::text as status, p.entity_type::text as entity_type,
            p.legal_name, p.formation_state, p.website_url, p.sector_code,
            case when p.publish_contact_email and u.email not like '%@guest.prospecto.invalid' then u.email end as contact_email,
            coalesce((select json_agg(json_build_object('display_name', m.display_name, 'role_title', m.role_title, 'role', m.role)
                                      order by m.joined_at, m.display_name)
                        from project_members m where m.project_id = p.id and m.display_name is not null), '[]'::json) as founders,
            (select json_build_object(
                      'calculated_at', v.calculated_at, 'model_version_id', v.model_version_id, 'model_hash', v.model_hash,
                      'declared_stage', v.declared_stage, 'effective_stage', v.effective_stage,
                      'current_operating_value', v.current_operating_value::text, 'scenario_value', v.scenario_value::text,
                      'model_reference_value', v.model_reference_value::text, 'round_implied_value', v.round_implied_value::text,
                      'unit_price_micro_usd', v.unit_price_micro_usd::text, 'reference_units', v.reference_units::text,
                      'evidence_root', v.evidence_root,
                      'scores', (select json_build_object('execution', s.execution_score, 'market', s.market_score, 'product', s.product_score,
                                                          'traction', s.traction_score, 'economics', s.economics_score, 'composite', s.composite_score)
                                   from score_snapshots s where s.valuation_run_id = v.valuation_run_id limit 1),
                      'explanation', ${EXPLANATION_SQL})
               from valuation_snapshots v where v.project_id = p.id order by v.calculated_at desc limit 1) as valuation,
            ${CURRENT_ROUND_SQL} as round
       from projects p
       join identities i on i.id = p.founder_identity_id
       join auth."user" u on u.id = i.auth_user_id
      where p.${where === "slug" ? "slug" : "id"} = $1 and p.status <> 'ARCHIVED'`,
    [value],
  );
  return rows[0] ?? null;
}

/** Feed cards: published projects with their latest price and current round, open rounds first. */
async function listPublishedProjects(pool: Pool) {
  const { rows } = await pool.query(
    `select p.slug, p.ticker, p.name, p.tagline, p.description, p.stage::text as stage, p.entity_type::text as entity_type,
            (select json_build_object('effective_stage', v.effective_stage, 'unit_price_micro_usd', v.unit_price_micro_usd::text,
                                      'model_version_id', v.model_version_id, 'calculated_at', v.calculated_at)
               from valuation_snapshots v where v.project_id = p.id order by v.calculated_at desc limit 1) as valuation,
            coalesce((select json_agg(json_build_object('display_name', m.display_name, 'role_title', m.role_title, 'role', m.role)
                                      order by m.joined_at, m.display_name)
                        from project_members m where m.project_id = p.id and m.display_name is not null), '[]'::json) as founders,
            ${CURRENT_ROUND_SQL} as round
       from projects p
      where p.status = 'PUBLISHED'
      order by exists (select 1 from rounds r where r.project_id = p.id and r.status in ('OPEN', 'SCHEDULED')) desc, p.created_at
      limit 100`,
  );
  return rows;
}

const view = ({ id: _id, ...row }: PublicProjectRow, projectId?: string) => (projectId ? { id: projectId, ...row } : row);

export function createProjectsRouter(deps: ProjectsRouterDependencies): Hono {
  const router = new Hono();

  // M§7.2 step 3. DEMO SHORTCUT: no wallet or on-chain Project PDA yet; the project starts as a DRAFT.
  router.post("/projects", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const { identityId } = await deps.requireIdentity(context);
    const key = requireIdempotencyKey(context);
    const parsed = createProjectSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid input." } }, 400);
    const body = parsed.data;
    let website: string | null = null;
    if (body.website_url) {
      website = normalizeUrl(body.website_url);
      if (!website) return context.json({ error: { code: "INVALID_INPUT", message: "website_url must be a public http(s) URL." } }, 400);
    }

    // Outside the transaction so a slow model never holds a lock. A replayed key ignores the result.
    const picks = !body.ticker && deps.nameTicker
      ? await deps.nameTicker({ name: body.name, tagline: body.tagline }).catch(() => [] as string[])
      : [];

    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      const result = await onceForKey(client, { identityId, operation: "create_project", key, body }, async () => {
        const owned = await client.query<{ n: string }>(`select count(*)::text as n from projects where founder_identity_id = $1`, [identityId]);
        if (Number(owned.rows[0].n) >= MAX_PROJECTS_PER_FOUNDER) {
          throw fail(409, "PROJECT_LIMIT", `A founder can create at most ${MAX_PROJECTS_PER_FOUNDER} projects in the demo.`);
        }
        const slug = await freeSlug(client, slugBase(body.name));
        const ticker = body.ticker ?? (await availableTicker(client, body.name, picks));
        const created = await client.query<{ id: string }>(
          `insert into projects
             (slug, name, tagline, stage, entity_type, legal_name, formation_state, website_url, sector_code, publish_contact_email, founder_identity_id, ticker)
           values ($1, $2, $3, $4::project_stage, $5::entity_type, $6, $7, $8, $9, $10, $11, $12)
           returning id`,
          [slug, body.name, body.tagline, body.stage, body.entity_type, body.legal_name ?? null, body.formation_state ?? null, website, body.sector_code ?? null, body.publish_contact_email, identityId, ticker],
        );
        const projectId = created.rows[0].id;
        await client.query(
          `insert into project_members (project_id, identity_id, role, display_name, role_title) values ($1, $2, 'FOUNDER', $3, $4)`,
          [projectId, identityId, body.founder.display_name, body.founder.role_title ?? null],
        );
        return { status: 201, body: { project: { id: projectId, slug, ticker, status: "DRAFT" } } };
      });
      await client.query("commit");
      return context.json(result.body, result.status);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: string }).code === "23503") throw fail(400, "UNKNOWN_SECTOR", "sector_code is not a known sector.");
      if ((error as { code?: string; constraint?: string }).constraint === "projects_ticker_unique") {
        throw fail(409, "TICKER_TAKEN", "That ticker is taken. Try another.");
      }
      throw error;
    } finally {
      client.release();
    }
  });

  router.post("/projects/:projectId/publish", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const projectId = context.req.param("projectId");
    if (!UUID.test(projectId)) return context.json({ error: { code: "INVALID_PROJECT_ID" } }, 400);
    await deps.requireProjectEditor(context, projectId);
    const { rows } = await deps.pool.query<{ slug: string }>(
      `update projects set status = 'PUBLISHED', updated_at = now() where id = $1 and status = 'DRAFT' returning slug`,
      [projectId],
    );
    if (!rows[0]) return context.json({ error: { code: "NOT_DRAFT", message: "Only a draft project can be published." } }, 409);
    return context.json({ project: { id: projectId, slug: rows[0].slug, status: "PUBLISHED" } });
  });

  router.post("/projects/:projectId/valuation/preview", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    const projectId = context.req.param("projectId");
    if (!UUID.test(projectId)) return context.json({ error: { code: "INVALID_PROJECT_ID" } }, 400);
    await deps.requireProjectEditor(context, projectId);
    try {
      return context.json(await previewValuation(deps.pool, projectId));
    } catch (error) {
      if (error instanceof ValuationServiceError) return context.json({ error: { code: error.code, message: error.message } }, error.httpStatus);
      throw error;
    }
  });

  router.get("/projects", async (context) => context.json({ projects: await listPublishedProjects(deps.pool) }));

  // Intake helper: a free symbol for a name, and whether a typed one is still available.
  router.get("/tickers/suggest", async (context) => {
    const name = (context.req.query("name") ?? "").slice(0, 120);
    const typed = (context.req.query("ticker") ?? "").trim().toUpperCase();
    const suggestion = name.trim() ? await availableTicker(deps.pool, name) : null;
    let available: boolean | null = null;
    if (typed) {
      if (!TICKER.test(typed)) available = false;
      else available = !(await deps.pool.query(`select 1 from projects where ticker = $1`, [typed])).rowCount;
    }
    return context.json({ suggestion, candidates: name.trim() ? tickerCandidates(name).slice(0, 4) : [], ticker: typed || null, available });
  });

  // Read-only: the symbol POST /projects would ask Gemini for, plus the published listing that already
  // holds it under the same name (the /list/demo Quippy preset resolves to the seeded QPY this way
  // instead of creating a duplicate). Same Gemini call and deterministic fallback as creation.
  router.post("/tickers/name", async (context) => {
    const foreign = rejectForeignOrigin(context, deps.publicOrigin);
    if (foreign) return foreign;
    await deps.requireIdentity(context);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120), tagline: z.string().trim().max(140).default("") })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: { code: "INVALID_INPUT", message: parsed.error.issues[0]?.message ?? "Invalid input." } }, 400);
    const { name, tagline } = parsed.data;
    const gemini = deps.nameTicker ? await deps.nameTicker({ name, tagline }).catch(() => [] as string[]) : [];
    const picks = gemini.length ? gemini : tickerCandidates(name).filter((c) => /^[A-Z]{2,4}$/.test(c));
    const ticker = picks[0] ?? null;
    const listed = ticker
      ? (await deps.pool.query<{ slug: string; name: string; ticker: string }>(
          `select slug, name, ticker from projects where ticker = $1 and status = 'PUBLISHED' and lower(name) = lower($2)`,
          [ticker, name],
        )).rows[0] ?? null
      : null;
    return context.json({ ticker, picks, source: gemini.length ? "gemini" : "fallback", listed });
  });

  // The caller's own projects (founder or member), so founder tools never ask for an id.
  router.get("/me/projects", async (context) => {
    const { identityId } = await deps.requireIdentity(context);
    const { rows } = await deps.pool.query(
      `select p.id, p.slug, p.ticker, p.name, p.status::text as status, p.solana_project_pda, p.receipt_mint, ${CURRENT_ROUND_SQL} as round
         from projects p
        where p.founder_identity_id = $1
           or exists (select 1 from project_members m where m.project_id = p.id and m.identity_id = $1)
        order by p.created_at desc`,
      [identityId],
    );
    return context.json({ projects: rows });
  });

  // Public profile by slug. Drafts are visible only to their editors (by id or slug).
  router.get("/projects/:slugOrId", async (context) => {
    const value = context.req.param("slugOrId");
    const byId = UUID.test(value);
    if (!byId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    const project = await loadPublicProject(deps.pool, byId ? "id" : "slug", value);
    if (!project) return context.json({ error: { code: "NOT_FOUND" } }, 404);
    if (project.status !== "PUBLISHED" || byId) {
      // 404 (not 401/403) for drafts and id lookups by non-editors, so ids and drafts cannot be probed.
      try {
        await deps.requireProjectEditor(context, project.id);
      } catch (error) {
        if (error instanceof HTTPException) return context.json({ error: { code: "NOT_FOUND" } }, 404);
        throw error;
      }
      return context.json({ project: view(project, project.id) });
    }
    return context.json({ project: view(project) });
  });

  return router;
}
