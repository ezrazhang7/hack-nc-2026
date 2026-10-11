// Runs the live evidence-research pipeline (Gemini passes + deterministic verifier) for a seeded demo
// company and stores the run, so the result is cached and the demo never has to call Gemini live.
// The run is pinned and NOT confirmed: the curated seed claims stay the scored evidence (DEMO_COMPANY_CATALOG.md).
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
  "quippy": {
    website_url: "https://quippyapp.com",
    urls: [
      "https://www.ycombinator.com/companies/quippy",
      "https://www.linkedin.com/in/12lijonathan",
    ],
    founder_text: "Quippy offers short, realistic practice conversations with line-by-line feedback and a curriculum that adapts to each person's patterns. It is live on iOS and Android.",
  },
  "heart-aerospace": {
    website_url: "https://www.heartaerospace.com",
    urls: [
      "https://www.ycombinator.com/companies/heart-aerospace",
      "https://www.heartaerospace.com/newsroom/heart-aerospace-raises-107-million-in-series-b-funding",
      "https://www.linkedin.com/in/anders-forslund",
    ],
    founder_text: "Heart is developing hybrid-electric regional aircraft and has flown a full-scale demonstrator.",
  },
  "elimentary": {
    website_url: "https://www.elimentary.com",
    urls: [
      "https://www.ycombinator.com/companies/elimentary",
      "https://www.linkedin.com/in/yogeshgorjilla",
      "https://www.linkedin.com/in/manojsarda",
    ],
    founder_text: "Elimentary runs a live operations product for private-capital teams.",
  },
  "sinter-systems": {
    website_url: "https://www.sinter.systems",
    urls: [
      "https://www.ycombinator.com/companies/sinter-systems",
      "https://www.linkedin.com/in/jkwonn",
    ],
    founder_text: "Sinter offers live quoting and a dashboard with an in-house prototype workflow; production tooling is coming soon.",
  },
  "papaya": {
    website_url: "https://papaya.fyi",
    urls: [
      "https://www.ycombinator.com/companies/papaya",
      "https://www.linkedin.com/in/macy-berg",
      "https://www.linkedin.com/in/niyazpk",
      "https://www.linkedin.com/in/vpfaiz",
    ],
    founder_text: "Papaya is a live production-trace product that has run more than 200 analyses.",
  },
  "vyra": {
    website_url: "https://www.usevyra.com",
    urls: [
      "https://www.ycombinator.com/companies/vyra",
      "https://www.linkedin.com/in/cjpong",
      "https://www.linkedin.com/in/sulan-zhang",
    ],
    founder_text: "Vyra is a live web and iOS editor for creators with public pricing.",
  },
  "memorable": {
    website_url: "https://www.memorable.sh",
    urls: [
      "https://www.ycombinator.com/companies/memorable",
      "https://www.linkedin.com/in/nikhil-krishnaswamy",
      "https://github.com/yc-software/qm",
      "https://github.com/garrytan/gbrain",
    ],
    founder_text: "Memorable ships a live CLI and integrations.",
  },
  "linklane": {
    website_url: "https://linklane.ai",
    urls: [
      "https://www.ycombinator.com/companies/linklane",
      "https://www.linkedin.com/company/linklane-logistics",
    ],
    founder_text: "LinkLane quotes, books and tracks freight while agents find carriers, negotiate rates and manage each load.",
  },
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

  // Pin the run so the cache serves it past the 24-hour TTL (migration 0007).
  await pool.query(`update research_runs set pinned = true where id = $1 and status in ('SUCCEEDED', 'PARTIAL')`, [run.runId]);
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
