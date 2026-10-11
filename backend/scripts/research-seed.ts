// Runs the live evidence-research pipeline (Gemini passes + deterministic verifier) for a seeded demo
// company and stores the run, so the result is cached and the demo never has to call Gemini live.
// The run is NOT confirmed: the curated seed claims stay the scored evidence (DEMO_COMPANY_CATALOG.md).
//
//   npx tsx --env-file-if-exists=../.env.local scripts/research-seed.ts treasury [--refresh]
import { GoogleGenAI } from "@google/genai";
import pg from "pg";

import { loadConfig } from "../src/config.js";
import { createGeminiResearchModel } from "../src/evidence/research/gemini.js";
import { collectGithub } from "../src/evidence/research/github.js";
import { executeResearchRun, getResearchRun, startResearchRun, type ResearchRequest } from "../src/evidence/research/runner.js";
import { safeFetch } from "../src/evidence/research/safe-fetch.js";

/** Public sources per seeded company (the catalog's primary sources) and the founder's own narrative. */
const SOURCES: Record<string, ResearchRequest> = {
  treasury: {
    website_url: "https://treasury.sh",
    urls: [
      "https://treasury.sh/about",
      "https://apps.apple.com/us/app/treasury-ai-money-manager/id6756083347",
      "https://news.ycombinator.com/item?id=46425301",
      "https://www.linkedin.com/in/junead-khan/",
    ],
    founder_text:
      "Treasury is a personal finance app with an AI advisor. It connects bank, card and investment accounts read-only through Plaid, " +
      "categorizes spending, tracks budgets, recurring bills and net worth, and answers money questions grounded in that data. " +
      "It is live on iOS and the web with a 14-day trial and a paid membership.",
  },
};

const slug = process.argv[2];
const request = slug ? SOURCES[slug] : undefined;
if (!request) throw new Error(`Usage: research-seed.ts <${Object.keys(SOURCES).join("|")}> [--refresh]`);

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
  const project = (await pool.query<{ id: string; founder_identity_id: string }>(
    `select id, founder_identity_id from projects where slug = $1`, [slug])).rows[0];
  if (!project) throw new Error(`No project "${slug}". Run npm run db:seed first.`);

  let work: Promise<void> | null = null;
  const deps = {
    pool,
    model: createGeminiResearchModel(new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }), config.GEMINI_MODEL, { fetchPage: safeFetch }),
    fetchPage: safeFetch,
    collectGithub: (target: { owner: string; repo: string | null }, siteKey: string | null) => collectGithub(target, siteKey, { token: config.GITHUB_TOKEN }),
    runInBackground: (task: () => Promise<void>) => { work = task(); },
  };
  const started = Date.now();
  const run = await startResearchRun(deps, {
    projectId: project.id, identityId: project.founder_identity_id,
    request: { ...request, refresh: process.argv.includes("--refresh") },
  });
  if (!run.cached) await (work ?? executeResearchRun(deps, run.runId));

  const stored = await getResearchRun(pool, project.id, run.runId);
  const result = stored.result;
  console.log(`${slug}: run ${stored.id} ${stored.status}${run.cached ? " (cached)" : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s, model ${config.GEMINI_MODEL}`);
  if (stored.error_code) console.log(`error: ${stored.error_code}`);
  if (result) {
    console.log("passes:", JSON.stringify(result.passes));
    console.table(result.sources.map(s => ({ url: s.url.slice(0, 60), fetch: s.fetch_status, gemini: s.gemini_status, grounded: s.grounding_seen })));
    console.table(result.proposals.map(p => ({ metric: p.metric_code, value: p.value_numeric ?? p.value_text, status: p.status, source: (p.source_url ?? "").slice(0, 50) })));
    if (result.rejected.length) console.table(result.rejected.map(r => ({ metric: r.metric_code, reason: r.reason })));
    for (const warning of result.warnings) console.log("warning:", warning);
  }
  if (!["SUCCEEDED", "PARTIAL"].includes(stored.status)) process.exitCode = 1;
} finally {
  await pool.end();
}
