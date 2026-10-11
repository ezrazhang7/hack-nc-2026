// Seeds the demo market (BACKEND_STACK §12.3): source-backed public startup profiles, evidence claims,
// valuations computed by the ACTIVE model, and one round each.
//   npm run db:seed              # writes to DATABASE_URL (idempotent; re-runs skip existing rows)
//   npm run db:seed -- --dry-run # prints each company's model price without touching the database
//
// DEMO SHORTCUTS (documented, not shown in the UI by product decision 2026-10-10):
//  - Founder names come from public YC profiles; seed-only identities use reserved example.edu addresses, never sign in,
//    and stay verification_status = NOT_STARTED.
//  - Claim statuses are assigned here instead of by research/verification.
//  - Rounds are inserted already OPEN/FILLED without an on-chain Round PDA, and
//    total_committed_micro_usd is seeded directly (no subscription rows). Production rounds leave
//    DRAFT only through the indexer (rounds/service.ts recordRoundOpened).
// Prices are never typed here: each one is the model's output for the claims below.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

import { campusEmailHash } from "../src/auth/campus-email.js";
import { METRICS, isMetricCode } from "../src/evidence/metrics.js";
import { computeValuation, parseValuationParams } from "../src/valuation/model-value.js";
import type { ClaimStatus, Stage } from "../src/valuation/quality-scores.js";
import { DEFAULT_MODEL_VERSION_ID, modelDocument, previewValuation } from "../src/valuation/service.js";
import { ROUND_POLICY } from "../src/rounds/policy.js";

type Source = "FOUNDER_STATEMENT" | "DOCUMENT" | "LINK" | "INTEGRATION";
type Claim = [metric: string, value: string, status: ClaimStatus, source: Source, subject?: string, sourceUri?: string];

interface Company {
  slug: string;
  /** Curated market symbol; matches migration 0005's backfill. */
  ticker: string;
  name: string;
  stage: Stage;
  tagline: string;
  description: string;
  websiteUrl: string;
  legalName?: string;
  formationState?: string;
  founders: [name: string, title: string][];
  claims: Claim[];
  /** Round state: percent of target committed, days since open, days until close. */
  round: { committedPct: number; openedDaysAgo: number; closesInDays: number };
}

const FA = "FOUNDER_ATTESTED", PW = "PUBLIC_WEAK";
const yc = (slug: string) => `https://www.ycombinator.com/companies/${slug}`;
const HEART_RELEASE = "https://www.heartaerospace.com/newsroom/heart-aerospace-raises-107-million-in-series-b-funding";

const COMPANIES: Company[] = [
  {
    slug: "quippy", ticker: "QPY", name: "Quippy", stage: "LAUNCHED",
    tagline: "Daily, adaptive practice for the conversations that matter most.",
    description: "Short, realistic practice conversations with line-by-line feedback and a curriculum that adapts to each person's patterns.",
    websiteUrl: "https://quippyapp.com",
    legalName: "Quippy App, Inc.",
    founders: [["Jonathan Li", "Founder/CEO"]],
    claims: [["product_status", "launched", PW, "LINK"], ["prior_shipped_products", "2", PW, "LINK", undefined, yc("quippy")], ["team_functions_count", "3", FA, "LINK", undefined, yc("quippy")], ["full_time_founders", "1", FA, "LINK", undefined, yc("quippy")]],
    round: { committedPct: 72, openedDaysAgo: 4, closesInDays: 10 },
  },
  {
    slug: "heart-aerospace", ticker: "HEART", name: "Heart Aerospace", stage: "PROTOTYPE",
    tagline: "Electrifying regional air travel.",
    description: "Heart is developing hybrid-electric regional aircraft and has flown a full-scale demonstrator.",
    websiteUrl: "https://www.heartaerospace.com",
    founders: [["Anders Forslund", "Founder/CEO"]],
    claims: [["product_status", "prototype", PW, "LINK", undefined, HEART_RELEASE], ["team_functions_count", "4", PW, "LINK", undefined, yc("heart-aerospace")], ["full_time_founders", "1", FA, "LINK", undefined, yc("heart-aerospace")]],
    round: { committedPct: 96, openedDaysAgo: 11, closesInDays: 3 },
  },
  {
    slug: "elimentary", ticker: "ELMT", name: "Elimentary", stage: "LAUNCHED",
    tagline: "AI agents for private-capital operations.",
    description: "Agents automate borrowing-base calculations, loan-tape analysis, NAV calculations and other middle- and back-office work.",
    websiteUrl: "https://www.elimentary.com",
    founders: [["Yogesh Gorjilla", "Founder/CEO"], ["Mannat Saini", "Founder/CTO"], ["Manoj Sarda", "Founder/COO"]],
    claims: [["product_status", "launched", PW, "LINK"], ["prior_shipped_products", "3", PW, "LINK", undefined, yc("elimentary")], ["prior_venture_users", "20000000", PW, "LINK", "Credit products", yc("elimentary")], ["team_functions_count", "4", PW, "LINK", undefined, yc("elimentary")], ["full_time_founders", "3", FA, "LINK", undefined, yc("elimentary")]],
    round: { committedPct: 81, openedDaysAgo: 6, closesInDays: 8 },
  },
  {
    slug: "sinter-systems", ticker: "SNTR", name: "Sinter", stage: "PROTOTYPE",
    tagline: "A faster plastics pipeline from prototype to production.",
    description: "Sinter combines online quoting, additive tooling and an in-house manufacturing workflow for iteration-heavy hardware teams.",
    websiteUrl: "https://www.sinter.systems",
    legalName: "Sinter System Inc.",
    founders: [["Oliver Johnson", "Founder/CEO"], ["Justin Kwon", "Founder/COO"]],
    claims: [["product_status", "beta", PW, "LINK"], ["prior_shipped_products", "2", PW, "LINK", undefined, yc("sinter-systems")], ["team_functions_count", "4", PW, "LINK", undefined, yc("sinter-systems")], ["full_time_founders", "2", FA, "LINK", undefined, yc("sinter-systems")]],
    round: { committedPct: 63, openedDaysAgo: 5, closesInDays: 9 },
  },
  {
    slug: "papaya", ticker: "PAPY", name: "Papaya", stage: "LAUNCHED",
    tagline: "Continuous optimization for AI agents.",
    description: "Papaya analyzes production agent traces and ranks fixes by their expected quality, latency and cost impact.",
    websiteUrl: "https://papaya.fyi",
    founders: [["Macy Mody", "Founder/CEO"], ["Niyaz Puzhikkunnath", "Founder/CPO"], ["Faiz Vadakkumpadath", "Founder"]],
    claims: [["product_status", "launched", PW, "LINK"], ["prior_shipped_products", "3", PW, "LINK", undefined, yc("papaya")], ["prior_venture_revenue_usd", "10000000", PW, "LINK", "SafeBase", yc("papaya")], ["team_functions_count", "4", PW, "LINK", undefined, yc("papaya")], ["full_time_founders", "3", FA, "LINK", undefined, yc("papaya")]],
    round: { committedPct: 88, openedDaysAgo: 8, closesInDays: 6 },
  },
  {
    slug: "vyra", ticker: "VYRA", name: "Vyra", stage: "LAUNCHED",
    tagline: "Autonomous video editing for non-editors.",
    description: "Creators upload real footage, describe the edit they want and receive a polished draft in minutes.",
    websiteUrl: "https://www.usevyra.com",
    founders: [["Caleb Pong", "Founder"], ["Sulan Zhang", "Founder"]],
    claims: [["product_status", "launched", PW, "LINK"], ["active_users", "76438", PW, "LINK"], ["prior_venture_users", "60000", PW, "LINK", "sulansart", yc("vyra")], ["team_functions_count", "4", PW, "LINK", undefined, yc("vyra")], ["full_time_founders", "2", FA, "LINK", undefined, yc("vyra")]],
    round: { committedPct: 93, openedDaysAgo: 10, closesInDays: 4 },
  },
  {
    slug: "memorable", ticker: "MEMO", name: "Memorable", stage: "LAUNCHED",
    tagline: "Procedural, graph-based memory for AI agents.",
    description: "Memorable turns successful agent traces into reusable workflows and retrieves them for similar tasks.",
    websiteUrl: "https://www.memorable.sh",
    founders: [["Nikhil Krishnaswamy", "Founder/CEO"], ["Advaiyt Sane", "Founder/CTO"]],
    claims: [["product_status", "launched", PW, "LINK"], ["prior_shipped_products", "3", PW, "LINK", undefined, yc("memorable")], ["team_functions_count", "3", PW, "LINK", undefined, yc("memorable")], ["full_time_founders", "2", FA, "LINK", undefined, yc("memorable")]],
    round: { committedPct: 69, openedDaysAgo: 3, closesInDays: 11 },
  },
  {
    slug: "linklane", ticker: "LINK", name: "LinkLane", stage: "LAUNCHED",
    tagline: "AI-powered freight brokerage in seconds.",
    description: "LinkLane quotes, books and tracks freight while agents find carriers, negotiate rates and manage each load.",
    websiteUrl: "https://linklane.ai",
    founders: [["Christopher Ruaño", "Founder/CEO"], ["Patryk Wekwejt", "Founder/COO"]],
    claims: [["product_status", "launched", PW, "LINK"], ["tam_usd", "1000000000000", PW, "LINK", undefined, yc("linklane")], ["team_functions_count", "4", PW, "LINK", undefined, yc("linklane")], ["full_time_founders", "2", FA, "LINK", undefined, yc("linklane")]],
    round: { committedPct: 76, openedDaysAgo: 7, closesInDays: 7 },
  },
];

const LEGACY_SEED_SLUGS = ["mothlight", "fernhill-robotics", "quillnote", "tidewater-sensors", "dormfold", "bracket-bio", "orchard-os", "kiln-labs"];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const emailFor = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.edu`;
const isNumeric = (metric: string) => isMetricCode(metric) && METRICS[metric].kind !== "product_status";
const claimHash = (slug: string, [metric, value, status, source, subject, sourceUri]: Claim, fallbackUri: string) =>
  sha256(JSON.stringify(["demo-seed", slug, metric, subject ?? null, value, status, source, sourceUri ?? fallbackUri]));

function validate() {
  for (const c of COMPANIES) {
    for (const [metric] of c.claims) if (!isMetricCode(metric)) throw new Error(`${c.slug}: unknown metric ${metric}`);
    if (c.round.committedPct < 0 || c.round.committedPct > 100) throw new Error(`${c.slug}: committedPct out of range`);
  }
}

function dryRun() {
  const seed = JSON.parse(readFileSync(new URL(`../../db/seeds/${DEFAULT_MODEL_VERSION_ID}.json`, import.meta.url), "utf8"));
  const params = parseValuationParams(modelDocument(seed));
  for (const c of COMPANIES) {
    const claims = c.claims.map(([metric, value, status], i) => ({
      id: `c${i}`, metric_code: metric, value_numeric: isNumeric(metric) ? value : null,
      value_text: isNumeric(metric) ? null : value, status, created_at: new Date(0),
    }));
    const v = computeValuation(params, { declared_stage: c.stage, claims, prior_round: null });
    const price = (Number(v.unit_price_micro_usd) / 1e6).toFixed(6);
    console.log(`${c.slug.padEnd(20)} ${c.stage.padEnd(19)} → ${v.stage.effective.padEnd(19)} Q=${v.scores.composite.toFixed(3)} $${price}`);
  }
}

async function seed() {
  const url = process.env.DATABASE_URL, pepper = process.env.EMAIL_HASH_PEPPER;
  if (!url || !pepper) throw new Error("DATABASE_URL and EMAIL_HASH_PEPPER are required (see .env.example).");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    // Replacement is recoverable: hide only the known old demo fixtures, never user-created data.
    await pool.query(`update projects set status = 'ARCHIVED', updated_at = now() where slug = any($1::text[]) and status <> 'ARCHIVED'`, [LEGACY_SEED_SLUGS]);
    for (const c of COMPANIES) {
      // Synthetic auth identities for the public founder profiles; these accounts never sign in.
      const identityIds: string[] = [];
      for (const [name] of c.founders) {
        const email = emailFor(name);
        const user = await pool.query<{ id: string }>(
          `insert into auth."user" (name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $2, false, now(), now())
           on conflict (email) do update set email = excluded.email returning id`,
          [name, email],
        );
        const identity = await pool.query<{ id: string }>(
          `insert into identities (auth_user_id, campus_email_hash) values ($1, $2)
           on conflict (auth_user_id) do update set auth_user_id = excluded.auth_user_id returning id`,
          [user.rows[0].id, campusEmailHash(email, pepper)],
        );
        identityIds.push(identity.rows[0].id);
      }

      let project = (await pool.query<{ id: string }>(`select id from projects where slug = $1`, [c.slug])).rows[0];
      if (!project) {
        project = (
          await pool.query<{ id: string }>(
            `insert into projects (slug, name, tagline, description, stage, status, entity_type, legal_name, formation_state,
                                   website_url, publish_contact_email, founder_identity_id, ticker)
             values ($1, $2, $3, $4, $5::project_stage, 'PUBLISHED', $6::entity_type, $7, $8, $9, false, $10, $11) returning id`,
            [c.slug, c.name, c.tagline, c.description, c.stage, c.legalName ? "INCORPORATED" : "UNINCORPORATED", c.legalName ?? null, c.formationState ?? null, c.websiteUrl, identityIds[0], c.ticker],
          )
        ).rows[0];
        for (const [i, [name, title]] of c.founders.entries()) {
          await pool.query(
            `insert into project_members (project_id, identity_id, role, display_name, role_title, joined_at)
             values ($1, $2, 'FOUNDER', $3, $4, now() + $5 * interval '1 millisecond') on conflict do nothing`,
            [project.id, identityIds[i], name, title, i],
          );
        }
      }

      const hasClaims = (await pool.query(`select 1 from evidence_claims where project_id = $1 limit 1`, [project.id])).rowCount;
      if (!hasClaims) {
        for (const claim of c.claims) {
          const [metric, value, status, source, subject, sourceUri] = claim;
          const inserted = await pool.query<{ id: string }>(
            `insert into evidence_claims (project_id, metric_code, subject, value_numeric, value_text, unit, source_type, source_uri, content_hash, created_by_identity_id)
             values ($1, $2, $3, $4, $5, $6, $7::evidence_source_type, $8, $9, $10) returning id`,
            [project.id, metric, subject ?? null, isNumeric(metric) ? value : null, isNumeric(metric) ? null : value, isMetricCode(metric) ? METRICS[metric].unit : null, source, sourceUri ?? c.websiteUrl, claimHash(c.slug, claim, c.websiteUrl), identityIds[0]],
          );
          await pool.query(`insert into evidence_verifications (claim_id, status, note) values ($1, $2::evidence_status, 'demo-seed')`, [inserted.rows[0].id, status]);
        }
      }

      // The ACTIVE model prices the claims and records the snapshot (reused when inputs are unchanged).
      const valuation = await previewValuation(pool, project.id);

      const hasRound = (await pool.query(`select 1 from rounds where project_id = $1 limit 1`, [project.id])).rowCount;
      if (!hasRound) {
        const price = BigInt(valuation.values.unitPriceMicroUsd);
        const maxUnits = ROUND_POLICY.defaultMaxUnits;
        const target = maxUnits * price;
        const cap = (target * ROUND_POLICY.defaultMaxSubscriptionBps) / 10_000n;
        const committed = (target * BigInt(c.round.committedPct)) / 100n;
        await pool.query(
          `insert into rounds
             (project_id, round_number, opens_at, closes_at, unit_price_micro_usd, max_units, target_amount_micro_usd,
              max_subscription_micro_usd, protocol_fee_bps, founder_fee_share_bps, model_version_id, valuation_snapshot_id,
              valuation_calculated_at, model_hash, evidence_root, total_committed_micro_usd, status)
           select $1, 1, date_trunc('second', now()) - $2 * interval '1 day', date_trunc('second', now()) + $3 * interval '1 day',
                  v.unit_price_micro_usd, $4, $5, $6, $7, $8, v.model_version_id, v.id, v.calculated_at, v.model_hash, v.evidence_root,
                  $9, $10::round_status
             from valuation_snapshots v where v.id = $11`,
          [project.id, c.round.openedDaysAgo, c.round.closesInDays, String(maxUnits), String(target), String(cap < price ? price : cap),
           Number(ROUND_POLICY.protocolFeeBps), Number(ROUND_POLICY.founderFeeShareBps), String(committed),
           c.round.committedPct >= 100 ? "FILLED" : "OPEN", valuation.snapshot.id],
        );
      }
      console.log(`${c.slug.padEnd(20)} ${valuation.stage.effective.padEnd(19)} $${valuation.values.unitPrice}${valuation.snapshot.reused ? " (unchanged)" : ""}`);
    }
  } finally {
    await pool.end();
  }
}

validate();
if (process.argv.includes("--dry-run")) dryRun();
else await seed();
