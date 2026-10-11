// Seeds the demo market (BACKEND_STACK §12.3): fictional campus startups, their evidence claims,
// valuations computed by the ACTIVE model, and one round each.
//   npm run db:seed              # writes to DATABASE_URL (idempotent; re-runs skip existing rows)
//   npm run db:seed -- --dry-run # prints each company's model price without touching the database
//
// DEMO SHORTCUTS (documented, not shown in the UI by product decision 2026-10-10):
//  - Founders are fictional; their identities use reserved example.edu addresses, never sign in,
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
type Claim = [metric: string, value: string, status: ClaimStatus, source: Source, subject?: string];

interface Company {
  slug: string;
  /** Curated market symbol; matches migration 0005's backfill. */
  ticker: string;
  name: string;
  stage: Stage;
  tagline: string;
  description: string;
  legalName?: string;
  formationState?: string;
  founders: [name: string, title: string][];
  claims: Claim[];
  /** Round state: percent of target committed, days since open, days until close. */
  round: { committedPct: number; openedDaysAgo: number; closesInDays: number };
}

const FA = "FOUNDER_ATTESTED", IV = "INDEPENDENTLY_VERIFIED", PW = "PUBLIC_WEAK";

const COMPANIES: Company[] = [
  {
    slug: "mothlight", ticker: "MOTH", name: "Mothlight", stage: "IDEA",
    tagline: "Mothlight wants to find you a quiet room at 2 a.m.",
    description: "Two sophomores, a napkin sketch and a waitlist of 40. No code yet.",
    founders: [["Jonah Mercer", "Co-founder · product"], ["Tess Okafor", "Co-founder · research"]],
    claims: [["product_status", "idea", FA, "FOUNDER_STATEMENT"], ["customer_interviews_count", "40", FA, "DOCUMENT"], ["waitlist_signups", "40", PW, "LINK"], ["team_functions_count", "2", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "0", FA, "FOUNDER_STATEMENT"]],
    round: { committedPct: 38, openedDaysAgo: 5, closesInDays: 9 },
  },
  {
    slug: "fernhill-robotics", ticker: "FERN", name: "Fernhill Robotics", stage: "EARLY_REVENUE",
    tagline: "The $900 robot weeding 31 small farms",
    description: "Started as an NC State senior design project. Farms pay a monthly service fee per robot.",
    legalName: "Fernhill Robotics, Inc.", formationState: "NC",
    founders: [["Priya Raman", "Chief executive"], ["Marcus Odom", "Hardware & firmware"], ["Lena Hartwell", "Field operations"]],
    claims: [["product_status", "launched", PW, "LINK"], ["mrr_usd", "2325", IV, "INTEGRATION"], ["active_users", "31", IV, "INTEGRATION"], ["mom_growth_pct", "12", IV, "INTEGRATION"], ["recurring_revenue_share_pct", "70", IV, "INTEGRATION"], ["retention_m1_pct", "90", FA, "FOUNDER_STATEMENT"], ["gross_margin_pct", "45", FA, "DOCUMENT"], ["runway_months", "10", FA, "DOCUMENT"], ["team_functions_count", "4", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "2", FA, "FOUNDER_STATEMENT"], ["relevant_experience_years", "3", FA, "FOUNDER_STATEMENT"], ["repo_commits_90d", "140", IV, "INTEGRATION"], ["repo_active_weeks_13w", "12", IV, "INTEGRATION"]],
    round: { committedPct: 61, openedDaysAgo: 2, closesInDays: 12 },
  },
  {
    slug: "quillnote", ticker: "QUIL", name: "Quillnote", stage: "LAUNCHED",
    tagline: "Quillnote’s notes app reaches four campuses",
    description: "1,200 weekly users. Closing Friday.",
    legalName: "Quillnote LLC", formationState: "NC",
    founders: [["Dev Kapoor", "Chief executive"], ["Hana Liu", "Design & growth"]],
    claims: [["product_status", "launched", PW, "LINK"], ["active_users", "1200", IV, "INTEGRATION"], ["dau_mau_pct", "22", IV, "INTEGRATION"], ["retention_m1_pct", "38", IV, "INTEGRATION"], ["mom_growth_pct", "18", IV, "INTEGRATION"], ["cac_usd", "4", FA, "FOUNDER_STATEMENT"], ["repo_commits_90d", "210", IV, "INTEGRATION"], ["repo_active_weeks_13w", "13", IV, "INTEGRATION"], ["team_functions_count", "3", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "2", FA, "FOUNDER_STATEMENT"]],
    round: { committedPct: 91, openedDaysAgo: 12, closesInDays: 2 },
  },
  {
    slug: "tidewater-sensors", ticker: "TIDE", name: "Tidewater Sensors", stage: "PROTOTYPE",
    tagline: "Soil sensors, tested on three farms",
    description: "A working prototype and an honest label.",
    founders: [["Samuel Brooks", "Founder"], ["Ivy Chen", "Hardware"]],
    claims: [["product_status", "prototype", PW, "LINK"], ["loi_count", "3", FA, "DOCUMENT"], ["customer_interviews_count", "25", FA, "DOCUMENT"], ["team_functions_count", "2", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "1", FA, "FOUNDER_STATEMENT"], ["relevant_experience_years", "2", FA, "FOUNDER_STATEMENT"], ["repo_commits_90d", "45", IV, "INTEGRATION"], ["repo_active_weeks_13w", "7", IV, "INTEGRATION"]],
    round: { committedPct: 54, openedDaysAgo: 6, closesInDays: 15 },
  },
  {
    slug: "dormfold", ticker: "DORM", name: "Dormfold", stage: "IDEA",
    tagline: "Your laundry, folded by Tuesday",
    description: "Just opened. Looking for its first 50 backers.",
    founders: [["Malik Grant", "Founder"]],
    claims: [["product_status", "idea", FA, "FOUNDER_STATEMENT"], ["customer_interviews_count", "12", FA, "DOCUMENT"], ["waitlist_signups", "60", PW, "LINK"], ["team_functions_count", "1", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "0", FA, "FOUNDER_STATEMENT"]],
    round: { committedPct: 12, openedDaysAgo: 1, closesInDays: 20 },
  },
  {
    slug: "bracket-bio", ticker: "BRKT", name: "Bracket Bio", stage: "PROTOTYPE",
    tagline: "A $40 test strip for lab benches",
    description: "Two grad students, one bench prototype.",
    legalName: "Bracket Bio, Inc.", formationState: "DE",
    founders: [["Nadia Petrova", "Co-founder · biology"], ["Owen Fisher", "Co-founder · chemistry"]],
    claims: [["product_status", "prototype", FA, "FOUNDER_STATEMENT"], ["relevant_experience_years", "5", FA, "FOUNDER_STATEMENT"], ["customer_interviews_count", "18", FA, "DOCUMENT"], ["tam_usd", "1200000000", FA, "DOCUMENT"], ["loi_count", "1", FA, "DOCUMENT"], ["team_functions_count", "2", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "2", FA, "FOUNDER_STATEMENT"]],
    round: { committedPct: 27, openedDaysAgo: 3, closesInDays: 18 },
  },
  {
    slug: "orchard-os", ticker: "ORCH", name: "Orchard OS", stage: "LAUNCHED",
    tagline: "Scheduling software for small orchards",
    description: "Live with nine growers this season.",
    legalName: "Orchard OS, Inc.", formationState: "NC",
    founders: [["Rosa Delgado", "Chief executive"], ["Ben Whitaker", "Field lead"]],
    claims: [["product_status", "launched", PW, "LINK"], ["active_users", "9", IV, "INTEGRATION"], ["mrr_usd", "450", IV, "INTEGRATION"], ["retention_m1_pct", "89", IV, "INTEGRATION"], ["team_functions_count", "3", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "2", FA, "FOUNDER_STATEMENT"], ["repo_commits_90d", "95", IV, "INTEGRATION"], ["repo_active_weeks_13w", "10", IV, "INTEGRATION"]],
    round: { committedPct: 66, openedDaysAgo: 7, closesInDays: 7 },
  },
  {
    slug: "kiln-labs", ticker: "KILN", name: "Kiln Labs", stage: "REPEATABLE_REVENUE",
    tagline: "Shift scheduling for campus employers",
    description: "Kiln Labs’ round is full. Follow for the next one.",
    legalName: "Kiln Labs, Inc.", formationState: "DE",
    founders: [["Grace Adeyemi", "Chief executive"], ["Theo Lambert", "Chief technology officer"]],
    claims: [["product_status", "launched", IV, "LINK"], ["mrr_usd", "18000", IV, "INTEGRATION"], ["recurring_revenue_share_pct", "85", IV, "INTEGRATION"], ["active_users", "4000", IV, "INTEGRATION"], ["mom_growth_pct", "9", IV, "INTEGRATION"], ["retention_m1_pct", "62", IV, "INTEGRATION"], ["gross_margin_pct", "72", FA, "DOCUMENT"], ["cac_usd", "35", FA, "DOCUMENT"], ["cac_payback_months", "4", FA, "DOCUMENT"], ["runway_months", "14", FA, "DOCUMENT"], ["team_functions_count", "5", FA, "FOUNDER_STATEMENT"], ["full_time_founders", "2", FA, "FOUNDER_STATEMENT"], ["relevant_experience_years", "4", FA, "FOUNDER_STATEMENT"]],
    round: { committedPct: 100, openedDaysAgo: 9, closesInDays: 5 },
  },
];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const emailFor = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.edu`;
const isNumeric = (metric: string) => isMetricCode(metric) && METRICS[metric].kind !== "product_status";
const claimHash = (slug: string, [metric, value, status, source, subject]: Claim) =>
  sha256(JSON.stringify(["demo-seed", slug, metric, subject ?? null, value, status, source]));

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
    for (const c of COMPANIES) {
      // Identities for every founder (fictional; never signed in).
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
                                   publish_contact_email, founder_identity_id, ticker)
             values ($1, $2, $3, $4, $5::project_stage, 'PUBLISHED', $6::entity_type, $7, $8, false, $9, $10) returning id`,
            [c.slug, c.name, c.tagline, c.description, c.stage, c.legalName ? "INCORPORATED" : "UNINCORPORATED", c.legalName ?? null, c.formationState ?? null, identityIds[0], c.ticker],
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
          const [metric, value, status, source, subject] = claim;
          const inserted = await pool.query<{ id: string }>(
            `insert into evidence_claims (project_id, metric_code, subject, value_numeric, value_text, unit, source_type, content_hash, created_by_identity_id)
             values ($1, $2, $3, $4, $5, $6, $7::evidence_source_type, $8, $9) returning id`,
            [project.id, metric, subject ?? null, isNumeric(metric) ? value : null, isNumeric(metric) ? null : value, isMetricCode(metric) ? METRICS[metric].unit : null, source, claimHash(c.slug, claim), identityIds[0]],
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
