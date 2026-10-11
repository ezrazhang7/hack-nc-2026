// Integration test for migration 0002 + runner + confirm against real PostgreSQL (PGlite/WASM).
// 0001 needs TimescaleDB, which PGlite lacks, so the tables 0002 depends on are recreated below
// from 0001's definitions (only the columns these flows touch).
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ResearchModelError, type ResearchModel } from "../../src/evidence/research/gemini.js";
import {
  confirmResearchRun,
  getResearchRun,
  recoverStaleRuns,
  startResearchRun,
  type ResearchDependencies,
} from "../../src/evidence/research/runner.js";
import type { FetchResult } from "../../src/evidence/research/safe-fetch.js";

const STUB_0001 = `
create type project_stage as enum ('IDEA', 'PROTOTYPE', 'LAUNCHED', 'EARLY_REVENUE', 'REPEATABLE_REVENUE');
create type evidence_source_type as enum ('FOUNDER_STATEMENT', 'DOCUMENT', 'LINK', 'INTEGRATION');
create type evidence_status as enum ('INDEPENDENTLY_VERIFIED', 'REVIEWER_VERIFIED', 'PUBLIC_WEAK', 'FOUNDER_ATTESTED', 'MISSING_OR_CONTRADICTED');
create function reject_append_only_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only; % is not allowed', tg_table_name, tg_op using errcode = 'restrict_violation'; end; $$;
create table identities (id uuid primary key default gen_random_uuid());
create table projects (
  id uuid primary key default gen_random_uuid(), name text not null, description text not null default '',
  tagline text not null default '', sector_code text, stage project_stage not null, founder_identity_id uuid references identities(id));
create table profile_snapshots (
  id uuid primary key default gen_random_uuid(), identity_id uuid not null references identities(id), profile_url text not null,
  text text, content_hash text, captured_at timestamptz not null default now(), deleted_at timestamptz);
create table project_members (
  project_id uuid not null references projects(id), identity_id uuid not null references identities(id),
  display_name text, joined_at timestamptz not null default now(), primary key (project_id, identity_id));
create table ai_intake_proposals (id uuid primary key default gen_random_uuid());
create table evidence_claims (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references projects(id),
  metric_code text not null check (length(metric_code) between 1 and 80), subject text, value_numeric numeric(30, 8), value_text text, unit text,
  period_start date, period_end date, source_type evidence_source_type not null, source_uri text,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'), ai_intake_proposal_id uuid references ai_intake_proposals(id),
  created_by_identity_id uuid not null references identities(id), supersedes_claim_id uuid unique references evidence_claims(id),
  created_at timestamptz not null default now(), check (value_numeric is not null or value_text is not null));
create trigger evidence_claims_append_only before update or delete on evidence_claims for each row execute function reject_append_only_mutation();
create table evidence_verifications (
  id bigint generated always as identity primary key, claim_id uuid not null references evidence_claims(id),
  status evidence_status not null, verified_by_identity_id uuid references identities(id), note text,
  created_at timestamptz not null default now(), check (status <> 'REVIEWER_VERIFIED' or verified_by_identity_id is not null));
create role prospecto_app;
`;

const migration = readFileSync(new URL("../../../db/migrations/0002_evidence_research.sql", import.meta.url), "utf8");
const [up, down] = migration.split("-- migrate:down");
const pinned = readFileSync(new URL("../../../db/migrations/0007_pinned_research_runs.sql", import.meta.url), "utf8").split("-- migrate:down")[0];

let db: PGlite;
let pool: Pool;
let projectId: string;
let identityId: string;

function asPool(pg: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params as never[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

const SITE = "https://mothlight.app/";
const SITE_TEXT = "Mothlight: quiet study rooms at 2 a.m. We are in public beta. Over 1,200 students joined our waitlist this fall. ".repeat(4);
const PRESS = "https://dailytarheel.com/article/mothlight";
const PRESS_TEXT = "Mothlight (mothlight.app) won first place at Carolina Pitch Night. The app reports 800 monthly active users. ".repeat(4);

const pages: Record<string, string> = { [SITE]: SITE_TEXT, [PRESS]: PRESS_TEXT };
const fetchPage = async (url: string): Promise<FetchResult> => ({
  status: pages[url] ? "OK" : "HTTP_ERROR",
  requestedUrl: url,
  finalUrl: url,
  httpStatus: pages[url] ? 200 : 404,
  contentType: "text/html",
  text: pages[url] ?? null,
  contentSha256: pages[url] ? "a".repeat(64) : null,
  truncated: false,
});

const telemetry = { urlContext: [], citationUrls: [], searchQueries: ["mothlight unc"], groundingCalls: 1, totalTokens: 1000 };
const workingModel: ResearchModel = {
  model: "fake-gemini-3",
  founderPass: async () => ({
    output: {
      claims: [
        { metric_code: "waitlist_signups", value: "1200", period_end: null, source_url: SITE, quote: "Over 1,200 students joined our waitlist this fall." },
        { metric_code: "full_time_founders", value: "2", period_end: null, source_url: "founder_text", quote: "2 full-time founders" },
      ],
      warnings: [],
    },
    telemetry: { ...telemetry, urlContext: [{ url: SITE, status: "success" }] },
  }),
  corroborationPass: async () => ({
    output: {
      claims: [{ metric_code: "active_users", value: "800", period_end: null, source_url: PRESS, quote: "The app reports 800 monthly active users." }],
      assessments: [],
      warnings: [],
    },
    telemetry: { ...telemetry, citationUrls: [PRESS] },
  }),
};
const failingModel: ResearchModel = {
  model: "fake-gemini-3",
  founderPass: async () => {
    throw new ResearchModelError("AI_UNAVAILABLE", "down");
  },
  corroborationPass: async () => {
    throw new ResearchModelError("AI_UNAVAILABLE", "down");
  },
};

function deps(model: ResearchModel, tasks: (() => Promise<void>)[]): ResearchDependencies {
  return {
    pool,
    model,
    fetchPage,
    collectGithub: async () => ({ claims: [], warnings: [] }),
    runInBackground: (task) => tasks.push(task),
  };
}

const request = { website_url: SITE, urls: ["https://www.linkedin.com/in/ana"], founder_text: "We are 2 full-time founders." };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB_0001);
  await db.exec(up);
  await db.exec(pinned);
  pool = asPool(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  identityId = (await db.query<{ id: string }>(`insert into identities default values returning id`)).rows[0].id;
  projectId = (
    await db.query<{ id: string }>(`insert into projects (name, description, stage) values ('Mothlight', 'Quiet study rooms at 2 a.m.', 'PROTOTYPE') returning id`)
  ).rows[0].id;
});

describe("research runner + confirm (PostgreSQL)", () => {
  it("runs, verifies, persists sources, and confirms exactly once", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const started = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    expect(started).toMatchObject({ status: "QUEUED", cached: false });
    await Promise.all(tasks.map((task) => task()));

    const run = await getResearchRun(pool, projectId, started.runId);
    // LinkedIn could not be read, so the run is PARTIAL with a remediation hint.
    expect(run.status).toBe("PARTIAL");
    expect(run.result!.warnings.join(" ")).toMatch(/linkedin\.com needs a login/);
    const byMetric = Object.fromEntries(run.result!.proposals.map((p) => [p.metric_code, p]));
    expect(byMetric.waitlist_signups).toMatchObject({ status: "FOUNDER_ATTESTED", droppable: true });
    expect(byMetric.full_time_founders).toMatchObject({ status: "FOUNDER_ATTESTED", source_type: "FOUNDER_STATEMENT" });
    expect(byMetric.active_users).toMatchObject({ status: "PUBLIC_WEAK", droppable: false });

    const sources = await db.query<{ url: string; origin: string; fetch_status: string }>(`select url, origin, fetch_status from research_sources where run_id = $1 order by url`, [started.runId]);
    expect(sources.rows).toEqual([
      { url: PRESS, origin: "SEARCH_CITATION", fetch_status: "OK" },
      { url: SITE, origin: "FOUNDER_SUBMITTED", fetch_status: "OK" },
      { url: "https://www.linkedin.com/in/ana", origin: "FOUNDER_SUBMITTED", fetch_status: "UNSUPPORTED_LINK" },
    ]);

    // Founders cannot drop third-party evidence; they can only dispute it.
    await expect(
      confirmResearchRun(pool, { projectId, runId: started.runId, identityId, accept: [byMetric.active_users.id], dispute: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const confirmed = await confirmResearchRun(pool, {
      projectId,
      runId: started.runId,
      identityId,
      accept: [byMetric.full_time_founders.id], // waitlist claim not accepted → dropped
      dispute: [byMetric.active_users.id],
    });
    expect(confirmed.claimIds).toHaveLength(2);

    const claims = await db.query<{ metric_code: string; value_numeric: string; source_type: string; status: string; note: string; research_source_id: string | null }>(
      `select c.metric_code, c.value_numeric::text, c.source_type::text, v.status::text, v.note, c.research_source_id
         from evidence_claims c join evidence_verifications v on v.claim_id = c.id
        where c.project_id = $1 order by c.metric_code`,
      [projectId],
    );
    expect(claims.rows).toEqual([
      expect.objectContaining({ metric_code: "active_users", value_numeric: "800.00000000", status: "PUBLIC_WEAK", note: "system:quote-check;third-party;GROUNDING_CITED;founder_disputed" }),
      expect.objectContaining({ metric_code: "full_time_founders", source_type: "FOUNDER_STATEMENT", status: "FOUNDER_ATTESTED", research_source_id: null }),
    ]);
    expect(claims.rows[0].research_source_id).not.toBeNull();

    await expect(confirmResearchRun(pool, { projectId, runId: started.runId, identityId, accept: [], dispute: [] })).rejects.toMatchObject({
      code: "ALREADY_CONFIRMED",
    });
    // Research sources are append-only.
    await expect(db.query(`update research_sources set url = 'x' where run_id = $1`, [started.runId])).rejects.toThrow(/append-only/);
  });

  it("uses a founder-provided LinkedIn snapshot instead of fetching LinkedIn (M§6.5)", async () => {
    const PROFILE = "https://www.linkedin.com/in/ana";
    const PROFILE_TEXT = "Ana Lee. Built and shipped Quietly, a study timer used by 300 students, at HackNC 2026.";
    let founderTextSeen: string | null = null;
    const model: ResearchModel = {
      ...workingModel,
      founderPass: async (input) => {
        founderTextSeen = input.founderText;
        return {
          output: {
            claims: [
              { metric_code: "prior_shipped_products", value: "1", period_end: null, source_url: PROFILE, quote: "Built and shipped Quietly, a study timer used by 300 students" },
              // Not in the snapshot: the quote check must still drop it.
              { metric_code: "relevant_experience_years", value: "5", period_end: null, source_url: PROFILE, quote: "5 years at a growth agency" },
            ],
            warnings: [],
          },
          telemetry,
        };
      },
    };
    const tasks: (() => Promise<void>)[] = [];
    const started = await startResearchRun(
      {
        ...deps(model, tasks),
        lookupProfileSnapshot: async (url) => (url === PROFILE ? { profileUrl: PROFILE, capturedAt: "2026-10-10", text: PROFILE_TEXT } : null),
      },
      { projectId, identityId, request: { website_url: SITE, urls: [PROFILE] } },
    );
    await Promise.all(tasks.map((task) => task()));

    expect(founderTextSeen).toContain(PROFILE_TEXT);
    const run = await getResearchRun(pool, projectId, started.runId);
    // Every founder link was usable, so the run is not PARTIAL because of LinkedIn.
    expect(run.status).toBe("SUCCEEDED");
    expect(run.result!.warnings.join(" ")).toMatch(/provided by the founder/);
    expect(run.result!.warnings.join(" ")).not.toMatch(/needs a login/);
    const shipped = run.result!.proposals.find((p) => p.metric_code === "prior_shipped_products");
    expect(shipped).toMatchObject({ status: "FOUNDER_ATTESTED", source_url: PROFILE, value_numeric: "1" });
    expect(run.result!.proposals.some((p) => p.metric_code === "relevant_experience_years")).toBe(false);
    expect(run.result!.rejected.some((r) => r.metric_code === "relevant_experience_years")).toBe(true);
    expect(run.result!.sources.find((s) => s.url === PROFILE)).toMatchObject({ fetch_status: "FOUNDER_PROVIDED", founder_controlled: true });

    const stored = await db.query<{ fetch_status: string; text_excerpt: string }>(
      `select fetch_status, text_excerpt from research_sources where run_id = $1 and url = $2`,
      [started.runId, PROFILE],
    );
    expect(stored.rows[0]).toEqual({ fetch_status: "FOUNDER_PROVIDED", text_excerpt: PROFILE_TEXT });
  });

  it("passes profile leads and founder names to corroboration and stores the prior venture as subject", async () => {
    const PROFILE = "https://www.linkedin.com/in/ana";
    const PROFILE_TEXT = "Ana Lee. Built Quietly, a study timer used by 300 students, at HackNC 2026.";
    await db.query(`insert into project_members (project_id, identity_id, display_name) values ($1, $2, 'Ana Lee')`, [projectId, identityId]);
    let seen: Parameters<ResearchModel["corroborationPass"]>[0] | null = null;
    const model: ResearchModel = {
      ...workingModel,
      founderPass: async () => ({
        output: {
          claims: [{ metric_code: "prior_venture_users", value: "300", period_end: null, source_url: PROFILE, quote: "Quietly, a study timer used by 300 students", subject: "Quietly" }],
          warnings: [],
        },
        telemetry,
      }),
      corroborationPass: async (input) => {
        seen = input;
        return workingModel.corroborationPass(input);
      },
    };
    const tasks: (() => Promise<void>)[] = [];
    const started = await startResearchRun(
      {
        ...deps(model, tasks),
        lookupProfileSnapshot: async (url) => (url === PROFILE ? { profileUrl: PROFILE, capturedAt: "2026-10-10", text: PROFILE_TEXT } : null),
      },
      { projectId, identityId, request: { website_url: SITE, urls: [PROFILE] } },
    );
    await Promise.all(tasks.map((task) => task()));

    expect(seen!.founderNames).toEqual(["Ana Lee"]);
    expect(seen!.founderProfile).toContain(PROFILE_TEXT);
    const run = await getResearchRun(pool, projectId, started.runId);
    const prior = run.result!.proposals.find((p) => p.metric_code === "prior_venture_users")!;
    expect(prior).toMatchObject({ subject: "Quietly", status: "FOUNDER_ATTESTED", droppable: true });

    await confirmResearchRun(pool, { projectId, runId: started.runId, identityId, accept: [prior.id], dispute: [] });
    const stored = await db.query<{ subject: string; unit: string }>(
      `select subject, unit from evidence_claims where research_run_id = $1 and metric_code = 'prior_venture_users'`,
      [started.runId],
    );
    expect(stored.rows).toEqual([{ subject: "Quietly", unit: "users" }]);
  });

  it("searches after visiting: corroboration gets the founder site's own title/description", async () => {
    let seen: Parameters<ResearchModel["corroborationPass"]>[0] | null = null;
    const model: ResearchModel = {
      ...workingModel,
      corroborationPass: async (input) => {
        seen = input;
        return workingModel.corroborationPass(input);
      },
    };
    const withSummary = async (url: string): Promise<FetchResult> => ({
      ...(await fetchPage(url)),
      ...(url === SITE ? { summary: { title: "Mothlight", description: "Quiet study rooms at 2 a.m." } } : {}),
    });
    const tasks: (() => Promise<void>)[] = [];
    await startResearchRun({ ...deps(model, tasks), fetchPage: withSummary }, { projectId, identityId, request: { website_url: SITE, urls: [] } });
    await Promise.all(tasks.map((task) => task()));
    expect(seen).toMatchObject({ siteSummary: "Mothlight — Quiet study rooms at 2 a.m.", project: { website: SITE } });
  });

  it("serves a pinned run from cache past the 24-hour TTL, and only a pinned one", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const first = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    await Promise.all(tasks.splice(0).map((task) => task()));
    await db.query("update research_runs set created_at = now() - interval '3 days' where id = $1", [first.runId]);
    const expired = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    expect(expired.cached).toBe(false);
    await Promise.all(tasks.splice(0).map((task) => task()));
    await db.query("update research_runs set created_at = now() - interval '3 days', pinned = true where id = $1", [first.runId]);
    await db.query("update research_runs set created_at = now() - interval '3 days' where id <> $1", [first.runId]);
    expect(await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request })).toEqual({ runId: first.runId, status: "PARTIAL", cached: true });
  });

  it("serves identical input from cache and enforces the hourly limit", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const first = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    await Promise.all(tasks.splice(0).map((task) => task()));
    const second = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    expect(second).toEqual({ runId: first.runId, status: "PARTIAL", cached: true });

    for (let i = 0; i < 2; i += 1) {
      await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request: { ...request, refresh: true } });
      await Promise.all(tasks.splice(0).map((task) => task()));
    }
    await expect(startResearchRun(deps(workingModel, tasks), { projectId, identityId, request: { ...request, refresh: true } })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("allows one in-flight run per project", async () => {
    const tasks: (() => Promise<void>)[] = [];
    await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    await expect(startResearchRun(deps(workingModel, tasks), { projectId, identityId, request: { ...request, refresh: true } })).rejects.toMatchObject({
      code: "RESEARCH_IN_PROGRESS",
    });
  });

  it("fails cleanly when Gemini is down and nothing deterministic was collected", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const started = await startResearchRun(deps(failingModel, tasks), { projectId, identityId, request });
    await Promise.all(tasks.map((task) => task()));
    const run = await getResearchRun(pool, projectId, started.runId);
    expect(run).toMatchObject({ status: "FAILED", error_code: "AI_UNAVAILABLE", result: null });
    await expect(confirmResearchRun(pool, { projectId, runId: started.runId, identityId, accept: [], dispute: [] })).rejects.toMatchObject({
      code: "RESEARCH_NOT_READY",
    });
  });

  it("recovers runs whose lease expired", async () => {
    const tasks: (() => Promise<void>)[] = [];
    const started = await startResearchRun(deps(workingModel, tasks), { projectId, identityId, request });
    await db.query(`update research_runs set status = 'RUNNING', lease_expires_at = now() - interval '1 minute' where id = $1`, [started.runId]);
    expect(await recoverStaleRuns(pool)).toBeGreaterThanOrEqual(1);
    expect((await getResearchRun(pool, projectId, started.runId)).error_code).toBe("LEASE_EXPIRED");
  });

  it("rejects malformed and internal URLs at the boundary", async () => {
    await expect(startResearchRun(deps(workingModel, []), { projectId, identityId, request: { urls: ["ftp://x"] } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(startResearchRun(deps(workingModel, []), { projectId, identityId, request: { urls: [] } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("has a working down migration", async () => {
    const scratch = new PGlite();
    await scratch.exec(STUB_0001);
    await scratch.exec(up);
    await scratch.exec(down);
    const tables = await scratch.query(`select to_regclass('research_runs') as runs, to_regclass('research_sources') as sources`);
    expect(tables.rows[0]).toEqual({ runs: null, sources: null });
    await scratch.close();
  });
});
