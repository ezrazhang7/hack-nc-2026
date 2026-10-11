// Evidence research runs (docs/EVIDENCE_RESEARCH.md §3, §6).
// A run executes in-process after the API returns 202; the lease lets the worker fail runs whose
// process died. We deliberately do not use Gemini background mode, which requires stored
// interactions (Google-side retention of founder data).
import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { METRICS, METRIC_CATALOG_VERSION, isMetricCode } from "../metrics.js";
import {
  CORROBORATION_PASS_VERSION,
  FOUNDER_PASS_VERSION,
  ResearchModelError,
  type CorroborationPassOutput,
  type FounderPassOutput,
  type PassResult,
  type ResearchModel,
} from "./gemini.js";
import type { GithubCollection } from "./github.js";
import { dbProfileSnapshotLookup, type ProfileSnapshotLookup } from "./profile-snapshots.js";
import type { FetchResult, PageFetcher } from "./safe-fetch.js";
import { classifyUrl, hostOf, isFounderControlled, normalizeUrl, projectSiteKeyFor, siteKey } from "./urls.js";
import { VERIFIER_VERSION, verifyResearch, type EvidenceProposal, type RejectedProposal, type SourceRecord } from "./verifier.js";

export const PIPELINE_VERSION = [FOUNDER_PASS_VERSION, CORROBORATION_PASS_VERSION, VERIFIER_VERSION, METRIC_CATALOG_VERSION].join("+");

const MAX_URLS = 10;
const MAX_CITATION_FETCHES = 15;
const FETCH_CONCURRENCY = 4;
const LEASE_MS = 5 * 60_000;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const RUNS_PER_HOUR = 3;
const TEXT_EXCERPT_MAX = 200_000;

export const researchRequestSchema = z.object({
  website_url: z.string().max(2048).nullable().optional(),
  urls: z.array(z.string().max(2048)).max(MAX_URLS).default([]),
  founder_text: z.string().trim().max(20_000).nullable().optional(),
  refresh: z.boolean().optional(),
});
export type ResearchRequest = z.infer<typeof researchRequestSchema>;

export class ResearchError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

export interface ResearchDependencies {
  pool: Pool;
  model: ResearchModel;
  fetchPage: PageFetcher;
  collectGithub: (target: { owner: string; repo: string | null }, projectSiteKey: string | null) => Promise<GithubCollection>;
  /** Defaults to running on the next tick; tests inject a collector to await the work. */
  runInBackground?: (task: () => Promise<void>) => void;
  /** Founder-provided LinkedIn snapshots (M§6.5); without it, LinkedIn links stay unreadable. */
  lookupProfileSnapshot?: ProfileSnapshotLookup;
}

interface RunInput {
  website_url: string | null;
  urls: string[];
  founder_text: string | null;
}

interface ProjectRow {
  name: string;
  description: string;
  /** The founder's one-liner; research context only, never cited or scored. */
  tagline: string;
  sector_code: string | null;
  stage: string;
  /** Listing names of the founders and team (never scored); attribute prior ventures. */
  founder_names: string[];
  /** Live profile snapshots of the team, so saving new profile text invalidates the cache. */
  profile_hashes: string[];
}

export interface ResearchResult {
  proposals: EvidenceProposal[];
  rejected: RejectedProposal[];
  warnings: string[];
  passes: { founder: string; corroboration: string; github: string };
  sources: {
    url: string;
    final_url: string | null;
    origin: SourceRecord["origin"];
    founder_controlled: boolean;
    fetch_status: SourceRecord["fetchStatus"] | "FOUNDER_PROVIDED";
    gemini_status: string | null;
    grounding_seen: boolean;
  }[];
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Validates and canonicalizes the request; URLs are deduplicated and capped. */
export function normalizeRequest(request: ResearchRequest): RunInput {
  const bad: string[] = [];
  const canonical = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) bad.push(raw.slice(0, 200));
    return url;
  };
  const website = request.website_url ? canonical(request.website_url) : null;
  const urls = [...new Set(request.urls.map(canonical).filter((url): url is string => url !== null))].filter((url) => url !== website);
  if (bad.length) throw new ResearchError("INVALID_INPUT", 400, `Not a public http(s) URL: ${bad.join(", ")}`);
  if (urls.length + (website ? 1 : 0) > MAX_URLS) throw new ResearchError("INVALID_INPUT", 400, `At most ${MAX_URLS} links per run.`);
  const founderText = request.founder_text ? request.founder_text.normalize("NFKC") : null;
  if (!website && urls.length === 0 && !founderText) {
    throw new ResearchError("INVALID_INPUT", 400, "Add at least one link or a short written description.");
  }
  return { website_url: website, urls: urls.sort(), founder_text: founderText };
}

export function inputHash(input: RunInput, project: ProjectRow): string {
  return sha256(
    JSON.stringify({
      input: { ...input, founder_text: input.founder_text?.replace(/\s+/g, " ").trim() ?? null },
      project: {
        name: project.name,
        description: project.description,
        tagline: project.tagline,
        sector: project.sector_code,
        stage: project.stage,
        founders: project.founder_names,
        profiles: project.profile_hashes,
      },
    }),
  );
}

async function loadProject(db: Pool | PoolClient, projectId: string): Promise<ProjectRow> {
  const { rows } = await db.query<ProjectRow>(
    `select p.name, p.description, p.tagline, p.sector_code, p.stage,
            coalesce(array(select m.display_name from project_members m
                            where m.project_id = p.id and m.display_name is not null
                            order by m.joined_at, m.display_name), '{}') as founder_names,
            coalesce(array(select s.content_hash from profile_snapshots s
                            where s.deleted_at is null
                              and s.identity_id in (select p.founder_identity_id
                                                    union select m.identity_id from project_members m where m.project_id = p.id)
                            order by s.content_hash), '{}') as profile_hashes
       from projects p where p.id = $1`,
    [projectId],
  );
  if (!rows[0]) throw new ResearchError("NOT_FOUND", 404, "Project not found.");
  return rows[0];
}

export async function startResearchRun(
  deps: ResearchDependencies,
  params: { projectId: string; identityId: string; request: ResearchRequest },
): Promise<{ runId: string; status: string; cached: boolean }> {
  const input = normalizeRequest(params.request);
  const project = await loadProject(deps.pool, params.projectId);
  const hash = inputHash(input, project);

  if (!params.request.refresh) {
    const cached = await deps.pool.query<{ id: string; status: string }>(
      `select id, status from research_runs
        where project_id = $1 and input_hash = $2 and pipeline_version = $3 and model = $4
          and status in ('SUCCEEDED', 'PARTIAL') and created_at > now() - make_interval(secs => $5)
        order by created_at desc limit 1`,
      [params.projectId, hash, PIPELINE_VERSION, deps.model.model, CACHE_TTL_MS / 1000],
    );
    if (cached.rows[0]) return { runId: cached.rows[0].id, status: cached.rows[0].status, cached: true };
  }

  const recent = await deps.pool.query<{ count: string }>(
    `select count(*) from research_runs where project_id = $1 and created_at > now() - interval '1 hour'`,
    [params.projectId],
  );
  if (Number(recent.rows[0].count) >= RUNS_PER_HOUR) {
    throw new ResearchError("RATE_LIMITED", 429, `At most ${RUNS_PER_HOUR} research runs per project per hour.`);
  }

  let runId: string;
  try {
    const inserted = await deps.pool.query<{ id: string }>(
      `insert into research_runs (project_id, requested_by_identity_id, input, input_hash, pipeline_version, model)
       values ($1, $2, $3::jsonb, $4, $5, $6) returning id`,
      [params.projectId, params.identityId, JSON.stringify(input), hash, PIPELINE_VERSION, deps.model.model],
    );
    runId = inserted.rows[0].id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ResearchError("RESEARCH_IN_PROGRESS", 409, "A research run for this project is already in progress.");
    }
    throw error;
  }

  // Fire and forget: failures are recorded on the run row; the caller polls.
  const task = () => executeResearchRun(deps, runId).catch(() => undefined);
  if (deps.runInBackground) deps.runInBackground(task);
  else setImmediate(() => void task());
  return { runId, status: "QUEUED", cached: false };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

const UNSUPPORTED_HINTS: Record<string, string> = {
  LOGIN_REQUIRED: "needs a login, so it can't be read automatically. Paste the relevant facts (role, years of relevant work) as text; they count as founder-attested.",
  GOOGLE_WORKSPACE: "is a Google Docs/Drive file, which can't be read automatically. Export it as a public PDF or web page, or paste the facts as text.",
  VIDEO: "is a video, which isn't analyzed. Paste the key facts as text.",
};

interface SourceRow extends SourceRecord {
  httpStatus: number | null;
  contentType: string | null;
  contentSha256: string | null;
  geminiStatus: string | null;
  /** Founder-supplied profile text (M§6.5); stored and shown as fetch status FOUNDER_PROVIDED. */
  founderProvided?: boolean;
}

function sourceFromFetch(fetched: FetchResult, url: string, origin: SourceRecord["origin"], projectSiteKey: string | null): SourceRow {
  const finalUrl = fetched.finalUrl ? normalizeUrl(fetched.finalUrl) : null;
  return {
    url,
    finalUrl: finalUrl !== url ? finalUrl : null,
    origin,
    // Judge control by where the content actually lives (after redirects).
    founderControlled: isFounderControlled(finalUrl ?? url, projectSiteKey),
    fetchStatus: fetched.status,
    text: fetched.text,
    groundingSeen: false,
    httpStatus: fetched.httpStatus,
    contentType: fetched.contentType,
    contentSha256: fetched.contentSha256,
    geminiStatus: null,
  };
}

/** Claims the lease, runs collectors + both Gemini passes, verifies, and stores the result. */
export async function executeResearchRun(deps: ResearchDependencies, runId: string): Promise<void> {
  const claimed = await deps.pool.query<{ project_id: string; input: RunInput }>(
    `update research_runs
        set status = 'RUNNING', started_at = coalesce(started_at, now()), lease_expires_at = now() + make_interval(secs => $2)
      where id = $1 and (status = 'QUEUED' or (status = 'RUNNING' and lease_expires_at < now()))
      returning project_id, input`,
    [runId, LEASE_MS / 1000],
  );
  if (!claimed.rows[0]) return;
  const { project_id: projectId, input } = claimed.rows[0];

  try {
    const project = await loadProject(deps.pool, projectId);
    const projectSiteKey = projectSiteKeyFor(input.website_url);
    const warnings: string[] = [];
    const sources = new Map<string, SourceRow>();
    const geminiUrls: string[] = [];
    const githubTargets: { owner: string; repo: string | null }[] = [];
    const profileTexts: string[] = [];
    // Snapshots saved through the API first, then the demo fixture files (PROFILE_SNAPSHOT_FILES).
    const fromDb = dbProfileSnapshotLookup(deps.pool, projectId);
    const lookupSnapshot = async (url: string) => (await fromDb(url)) ?? (await deps.lookupProfileSnapshot?.(url)) ?? null;

    // 1. Classify and fetch founder links (deterministic, no AI).
    const founderUrls = [...(input.website_url ? [input.website_url] : []), ...input.urls];
    const fetchable: string[] = [];
    for (const url of founderUrls) {
      const kind = classifyUrl(url);
      if (kind.kind === "unsupported") {
        const snapshot = kind.reason === "LOGIN_REQUIRED" ? await lookupSnapshot(url) : null;
        if (snapshot) {
          // Never fetched: the founder supplied this text. It is quote-checked like a page, and
          // founderControlled keeps every claim from it FOUNDER_ATTESTED (EVIDENCE_RESEARCH §4).
          warnings.push(`${hostOf(url)}: used profile details provided by the founder (captured ${snapshot.capturedAt}); they count as founder-attested.`);
          profileTexts.push(`Profile details provided by the founder for ${url}:\n${snapshot.text}`);
          sources.set(url, {
            url,
            finalUrl: null,
            origin: "FOUNDER_SUBMITTED",
            founderControlled: true,
            fetchStatus: "OK",
            text: snapshot.text,
            groundingSeen: false,
            httpStatus: null,
            contentType: "text/plain",
            contentSha256: sha256(snapshot.text),
            geminiStatus: null,
            founderProvided: true,
            complete: true,
          });
          continue;
        }
        warnings.push(`${hostOf(url)} ${UNSUPPORTED_HINTS[kind.reason]}`);
        sources.set(url, {
          url,
          finalUrl: null,
          origin: "FOUNDER_SUBMITTED",
          founderControlled: isFounderControlled(url, projectSiteKey),
          fetchStatus: "UNSUPPORTED_LINK",
          text: null,
          groundingSeen: false,
          httpStatus: null,
          contentType: null,
          contentSha256: null,
          geminiStatus: null,
        });
        continue;
      }
      if (kind.kind === "github" && githubTargets.length < 2) githubTargets.push({ owner: kind.owner, repo: kind.repo });
      fetchable.push(url);
      geminiUrls.push(url);
    }

    const founderFetches = mapLimit(fetchable, FETCH_CONCURRENCY, deps.fetchPage);
    const github = Promise.all(githubTargets.map((target) => deps.collectGithub(target, projectSiteKey)));
    const projectContext = { name: project.name, oneLiner: project.tagline || project.description, sector: project.sector_code, stage: project.stage };
    const founderText = [input.founder_text, ...profileTexts].filter((text): text is string => Boolean(text)).join("\n\n") || null;
    const [founderPass, corroborationPass] = await Promise.allSettled([
      deps.model.founderPass({ project: projectContext, urls: geminiUrls, founderText }),
      // Visit, then search: corroboration waits only for our own fetch of the founder's site, so it
      // can search by domain and product (the site's title/description) instead of a bare name.
      founderFetches.then((fetched) => {
        const index = input.website_url ? fetchable.indexOf(input.website_url) : -1;
        const summary = index >= 0 ? fetched[index]?.summary : undefined;
        const siteSummary = [summary?.title, summary?.description].filter(Boolean).join(" — ") || null;
        return deps.model.corroborationPass({
          project: { ...projectContext, website: input.website_url },
          siteSummary,
          founderNames: project.founder_names,
          founderProfile: profileTexts.join("\n\n") || null,
        });
      }),
    ]);

    (await founderFetches).forEach((fetched, index) => {
      const url = fetchable[index];
      const source = sourceFromFetch(fetched, url, "FOUNDER_SUBMITTED", projectSiteKey);
      if (fetched.status !== "OK") warnings.push(`Could not read ${hostOf(url)} (${fetched.status}); claims from it stay founder-attested.`);
      sources.set(url, source);
    });

    let githubStatus = githubTargets.length ? "OK" : "SKIPPED";
    const collected: GithubCollection["claims"] = [];
    try {
      for (const result of await github) {
        collected.push(...result.claims);
        warnings.push(...result.warnings);
      }
    } catch {
      githubStatus = "FAILED";
      warnings.push("GitHub could not be reached; activity metrics were skipped.");
    }

    const passStatus = (outcome: PromiseSettledResult<unknown>) =>
      outcome.status === "fulfilled" ? "OK" : `FAILED:${outcome.reason instanceof ResearchModelError ? outcome.reason.code : "INTERNAL"}`;
    const founder = founderPass.status === "fulfilled" ? (founderPass.value as PassResult<FounderPassOutput>) : null;
    const corroboration =
      corroborationPass.status === "fulfilled" ? (corroborationPass.value as PassResult<CorroborationPassOutput>) : null;

    // 2. Record what Gemini says it fetched; fetch every third-party page it cites ourselves.
    for (const entry of founder?.telemetry.urlContext ?? []) {
      const source = sources.get(normalizeUrl(entry.url) ?? "");
      if (source) {
        source.geminiStatus = entry.status;
        source.groundingSeen = true;
      }
    }
    const groundingUrls = new Set(
      [...(corroboration?.telemetry.citationUrls ?? []), ...(corroboration?.telemetry.urlContext.map((entry) => entry.url) ?? [])]
        .map(normalizeUrl)
        .filter((url): url is string => url !== null),
    );
    const citedByModel = [
      ...(corroboration?.output.claims.map((claim) => claim.source_url) ?? []),
      ...(corroboration?.output.assessments.flatMap((assessment) => assessment.citations.map((citation) => citation.source_url)) ?? []),
    ];
    const toFetch = [...new Set([...citedByModel.map(normalizeUrl), ...groundingUrls])]
      .filter((url): url is string => url !== null && !sources.has(url))
      .slice(0, MAX_CITATION_FETCHES);
    const citationFetches = await mapLimit(toFetch, FETCH_CONCURRENCY, deps.fetchPage);
    citationFetches.forEach((fetched, index) => {
      const source = sourceFromFetch(fetched, toFetch[index], "SEARCH_CITATION", projectSiteKey);
      source.groundingSeen = groundingUrls.has(toFetch[index]) || (source.finalUrl !== null && groundingUrls.has(source.finalUrl));
      sources.set(toFetch[index], source);
    });

    // 3. Deterministic verification.
    const verified = verifyResearch({
      project: { name: project.name, siteKey: projectSiteKey, founderNames: project.founder_names },
      founderText,
      sources: [...sources.values()],
      founderClaims: founder?.output.claims ?? [],
      corroborationClaims: corroboration?.output.claims ?? [],
      assessments: corroboration?.output.assessments ?? [],
      collected,
    });
    warnings.push(...(founder?.output.warnings ?? []), ...(corroboration?.output.warnings ?? []));

    const passes = { founder: passStatus(founderPass), corroboration: passStatus(corroborationPass), github: githubStatus };
    const bothFailed = !founder && !corroboration;
    if (bothFailed && collected.length === 0) {
      await finishRun(deps.pool, runId, { status: "FAILED", errorCode: passes.founder.slice("FAILED:".length) });
      return;
    }
    const partial = !founder || !corroboration || githubStatus === "FAILED" || [...sources.values()].some((s) => s.origin === "FOUNDER_SUBMITTED" && s.fetchStatus !== "OK");
    const result: ResearchResult = {
      proposals: verified.proposals,
      rejected: verified.rejected,
      warnings: [...new Set(warnings)].slice(0, 40),
      passes,
      sources: [...sources.values()].map((source) => ({
        url: source.url,
        final_url: source.finalUrl,
        origin: source.origin,
        founder_controlled: source.founderControlled,
        fetch_status: source.founderProvided ? "FOUNDER_PROVIDED" : source.fetchStatus,
        gemini_status: source.geminiStatus,
        grounding_seen: source.groundingSeen,
      })),
    };

    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      for (const source of sources.values()) {
        await client.query(
          `insert into research_sources
             (run_id, url, final_url, origin, founder_controlled, fetch_status, http_status, content_type, content_sha256, text_excerpt, grounding_seen)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (run_id, url) do nothing`,
          [
            runId,
            source.url,
            source.finalUrl,
            source.origin,
            source.founderControlled,
            source.founderProvided ? "FOUNDER_PROVIDED" : source.fetchStatus,
            source.httpStatus,
            source.contentType,
            source.contentSha256,
            source.text?.slice(0, TEXT_EXCERPT_MAX) ?? null,
            source.groundingSeen,
          ],
        );
      }
      await finishRun(client, runId, {
        status: partial ? "PARTIAL" : "SUCCEEDED",
        result,
        // Billing counts executed queries; prefer the usage counter, fall back to logged queries.
        searchQueries: corroboration ? corroboration.telemetry.groundingCalls || corroboration.telemetry.searchQueries.length : 0,
        totalTokens: founder || corroboration ? (founder?.telemetry.totalTokens ?? 0) + (corroboration?.telemetry.totalTokens ?? 0) : null,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch {
    await finishRun(deps.pool, runId, { status: "FAILED", errorCode: "INTERNAL" }).catch(() => undefined);
  }
}

async function finishRun(
  db: Pool | PoolClient,
  runId: string,
  outcome:
    | { status: "FAILED"; errorCode: string }
    | { status: "SUCCEEDED" | "PARTIAL"; result: ResearchResult; searchQueries: number; totalTokens: number | null },
): Promise<void> {
  if (outcome.status === "FAILED") {
    await db.query(
      `update research_runs set status = 'FAILED', error_code = $2, finished_at = now(), lease_expires_at = null
        where id = $1 and status = 'RUNNING'`,
      [runId, outcome.errorCode],
    );
    return;
  }
  await db.query(
    `update research_runs
        set status = $2, result = $3::jsonb, search_query_count = $4, total_tokens = $5, finished_at = now(), lease_expires_at = null
      where id = $1 and status = 'RUNNING'`,
    [runId, outcome.status, JSON.stringify(outcome.result), outcome.searchQueries, outcome.totalTokens],
  );
}

/** For the worker/startup: fail runs whose process died mid-flight. Founders can re-run. */
export async function recoverStaleRuns(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `update research_runs set status = 'FAILED', error_code = 'LEASE_EXPIRED', finished_at = now(), lease_expires_at = null
      where status = 'RUNNING' and lease_expires_at < now()`,
  );
  return rowCount ?? 0;
}

export async function getResearchRun(pool: Pool, projectId: string, runId: string) {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    error_code: string | null;
    result: ResearchResult | null;
    created_at: Date;
    finished_at: Date | null;
    confirmed_at: Date | null;
  }>(
    `select id, status, error_code, result, created_at, finished_at, confirmed_at
       from research_runs where id = $1 and project_id = $2`,
    [runId, projectId],
  );
  if (!rows[0]) throw new ResearchError("NOT_FOUND", 404, "Research run not found.");
  return rows[0];
}

export const confirmRequestSchema = z.object({
  accept: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(200).default([]),
  dispute: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(200).default([]),
});

export function claimContentHash(proposal: EvidenceProposal): string {
  return sha256(
    JSON.stringify([proposal.metric_code, proposal.subject ?? null, proposal.value_numeric, proposal.value_text, proposal.period_end, proposal.source_type, proposal.source_url, proposal.quote]),
  );
}

function unitFor(metricCode: string): string | null {
  if (metricCode.startsWith("assessment.")) return "rubric_level";
  return isMetricCode(metricCode) ? METRICS[metricCode].unit : null;
}

/**
 * Persists a run's proposals as immutable claims. Everything the system found is kept except the
 * founder's own droppable statements they did not accept; disputes are recorded for reviewers.
 * One confirmation per run (row lock + confirmed_at), so retries cannot duplicate claims.
 */
export async function confirmResearchRun(
  pool: Pool,
  params: { projectId: string; runId: string; identityId: string; accept: string[]; dispute: string[] },
): Promise<{ claimIds: string[] }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ status: string; result: ResearchResult | null; confirmed_at: Date | null }>(
      `select status, result, confirmed_at from research_runs where id = $1 and project_id = $2 for update`,
      [params.runId, params.projectId],
    );
    const run = rows[0];
    if (!run) throw new ResearchError("NOT_FOUND", 404, "Research run not found.");
    if (run.confirmed_at) throw new ResearchError("ALREADY_CONFIRMED", 409, "This research run was already confirmed.");
    if (!run.result) throw new ResearchError("RESEARCH_NOT_READY", 409, "This research run has no results to confirm.");

    const proposals = new Map(run.result.proposals.map((proposal) => [proposal.id, proposal]));
    const accept = new Set(params.accept);
    const dispute = new Set(params.dispute);
    for (const id of accept) {
      if (!proposals.get(id)?.droppable) throw new ResearchError("INVALID_INPUT", 400, `Proposal ${id} is not an optional founder statement.`);
    }
    for (const id of dispute) {
      const proposal = proposals.get(id);
      if (!proposal || proposal.droppable) throw new ResearchError("INVALID_INPUT", 400, `Proposal ${id} cannot be disputed.`);
    }

    const sourceIds = new Map(
      (await client.query<{ id: string; url: string }>(`select id, url from research_sources where run_id = $1`, [params.runId])).rows.map(
        (row) => [row.url, row.id],
      ),
    );
    const claimIds: string[] = [];
    for (const proposal of run.result.proposals) {
      if (proposal.droppable && !accept.has(proposal.id)) continue;
      const inserted = await client.query<{ id: string }>(
        `insert into evidence_claims
           (project_id, metric_code, value_numeric, value_text, unit, period_end, source_type, source_uri, content_hash,
            created_by_identity_id, source_quote, research_run_id, research_source_id, subject)
         values ($1, $2, $3, $4, $5, $6, $7::evidence_source_type, $8, $9, $10, $11, $12, $13, $14)
         returning id`,
        [
          params.projectId,
          proposal.metric_code,
          proposal.value_numeric,
          proposal.value_text,
          unitFor(proposal.metric_code),
          proposal.period_end,
          proposal.source_type,
          proposal.source_url,
          claimContentHash(proposal),
          params.identityId,
          proposal.quote?.slice(0, 600) ?? null,
          params.runId,
          proposal.source_url ? (sourceIds.get(proposal.source_url) ?? null) : null,
          proposal.subject ?? null,
        ],
      );
      const claimId = inserted.rows[0].id;
      const note = [proposal.method, ...proposal.reasons, ...(dispute.has(proposal.id) ? ["founder_disputed"] : [])].join(";");
      await client.query(
        `insert into evidence_verifications (claim_id, status, verified_by_identity_id, note)
         values ($1, $2::evidence_status, null, $3)`,
        [claimId, proposal.status, note],
      );
      claimIds.push(claimId);
    }
    await client.query(`update research_runs set confirmed_at = now(), confirmed_by_identity_id = $2 where id = $1`, [
      params.runId,
      params.identityId,
    ]);
    await client.query("commit");
    return { claimIds };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
