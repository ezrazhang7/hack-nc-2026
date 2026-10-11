# Evidence Research (Gemini + deterministic verification)

Scope: how a founder's links and text become scored evidence. Amends [MARKET ARCHITECTURE §6.2](MARKET%20ARCHITECTURE.md#62-gemini) and [BACKEND_STACK §10](BACKEND_STACK.md#10-gemini-m62). Approved by the project owner on 2026-10-10.

## 1. Principle

Gemini **finds and quotes** evidence. Deterministic code **decides what it is worth**. Gemini never sets an evidence status, a score, a weight, or a price; every number on a valuation page traces to a stored claim, a verbatim quote, a source, and a versioned rubric.

## 2. Decisions

| # | Decision | Effect |
|---|---|---|
| 1 | Gemini may assess four judgment sub-factors (`pain_urgency`, `differentiation`, `defensibility`, `growth_or_tailwind`) with verified citations | Stored as `AI_ASSESSED` claims, multiplier `c = 0.35`, so each bounded to `[0.325, 0.675]`; any stronger claim for the same sub-factor wins |
| 2 | Founders may drop only their own `FOUNDER_ATTESTED` statements | Third-party, collector, AI, and contradicted claims are always persisted; founders can mark them `founder_disputed` for a reviewer |
| 3 | Temperature stays at Gemini 3's default 1.0 | Google: "we strongly recommend keeping the temperature parameter at its default value of 1.0" for Gemini 3 ([docs](https://ai.google.dev/gemini-api/docs/gemini-3#temperature)); supersedes the earlier 0.2 |
| 4 | No Gemini background mode | It needs stored interactions (Google-side retention); runs execute in-process with a DB lease instead |
| 5 | Founder pass reads server-fetched page text; thinking `medium` for both passes (2026-10-11) | A YC company's facts were lost: the url_context tool hit Gemini's "too many tool calls" 400 in most runs, and `low` thinking skimmed team sections. Text mode succeeded 6/6 in ~3 s. `gemini-3.8-flash` was tried: 88 s and ~95k tokens per run, over the search cap, and it missed the launch, so the default stays `gemini-3.1-flash-lite` |

## 3. Pipeline

```text
POST /api/projects/:id/research-runs {website_url, urls[≤10], founder_text?, refresh?}
  → validate + canonicalize URLs → cache (24 h, same input+pipeline+model) → rate limit (3/h/project)
  → research_runs row (QUEUED; one in-flight run per project) → 202 {runId}
  background:
  1. Classify links: LinkedIn / Google Docs / YouTube → not readable, remediation warning; a LinkedIn profile with a founder-provided snapshot (M§6.5, `PROFILE_SNAPSHOT_FILES`) uses that text instead
  2. Server fetch of founder links (SSRF-guarded)          ┐
  3. GitHub REST collector (no AI)                         ├ in parallel
  4. Gemini founder pass: url_context + structured output  │
  5. Gemini corroboration pass: google_search + url_context┘
  6. Server fetch of every page the corroboration pass cites (≤15)
  7. verifier.ts assigns evidence_status; result stored on the run (SUCCEEDED / PARTIAL / FAILED)
GET  /api/projects/:id/research-runs/:runId                      → poll; proposals with status, quote, source
POST /api/projects/:id/research-runs/:runId/confirm {accept[], dispute[]}
  → evidence_claims + evidence_verifications (append-only), once per run
```

Code: `backend/src/evidence/` (`metrics.ts`, `decimal.ts`, `research/*`), `backend/src/routes/research.ts`, `backend/src/valuation/quality-scores.ts`, `backend/src/valuation/model-value.ts`. Migration: `db/migrations/0002_evidence_research.sql`. Model parameters: `db/seeds/valuation-v0.1.json`.

**Transport (`RESEARCH_PROVIDER`).** `gemini` uses the direct Gemini API with URL context and Google Search grounding (`research/gemini.ts`). `openrouter` (`research/openrouter.ts`) runs the same prompts, schemas, and verifier through OpenRouter: the founder pass sends page text our server already fetched (no paid URL tool), and the corroboration pass makes one Exa web search (5 results, $0.007 per request at OpenRouter's listed price) whose `url_citation` annotations feed step 6. Exa search is a different index from Google Search, so corroboration may find different pages; every cited page is still re-fetched and quote-checked. Adopted 2026-10-10 because the direct Gemini project's prepaid balance blocked all calls. **Current (2026-10-10, later):** back on `gemini` with a funded key and `GEMINI_MODEL=gemini-3.1-flash-lite` (the cheapest Gemini 3 model; structured output with tools is Gemini 3 only, and `gemini-2.5-flash` returns 404 for new keys). Passes use `thinking_level: "low"`. A live probe measured about 50k input tokens (half cached) and 2.5k output per run, roughly $0.015 per run, with about 7 searches inside the 5,000 free monthly. `openrouter` remains a fallback.

**Visit, then search (`research-corroboration-v2`).** The corroboration pass starts once our own fetch of the founder's website finishes, and receives that page's `<title>` and meta description as untrusted `<site_summary>` plus the bare domain, so it searches by domain and product, not by a name other companies may share. It never cites the summary. OpenRouter calls use temperature 0 (repeatable extraction on Gemini 2.5; the Gemini 3 "keep 1.0" guidance in §2 still applies to the direct adapter). The JSON schemas sent to the model carry only small array bounds (1–3 citations per assessment, at most 4 assessments): Gemini rejects schemas with large bounds, and zod still enforces every limit.

## 4. Evidence status rules (`verifier.ts`, version `verifier-v3`)

| Origin | Condition | Status |
|---|---|---|
| GitHub API | Repo homepage or owner profile site is the project domain | `INDEPENDENTLY_VERIFIED` |
| GitHub API | Not attributed (could be anyone's repo) | `PUBLIC_WEAK` |
| Founder text | Quote is verbatim in the submitted text | `FOUNDER_ATTESTED` |
| Founder link, founder-controlled (project domain or self-publishing host such as Notion, Vercel, GitHub, Medium, LinkedIn) | Quote found, or page unverifiable (client-rendered, unreadable) | `FOUNDER_ATTESTED` |
| Founder link, third-party | Quote found and page names the company | `PUBLIC_WEAK`; otherwise `FOUNDER_ATTESTED` |
| Search-found page | Not founder-controlled, quote found in **our own fetch**, page names the company **and** its domain (market metrics `tam_usd`/`market_growth_pct` exempt) | `PUBLIC_WEAK`; otherwise dropped |
| AI assessment | ≥1 citation whose quote is found in a fetched page; no pedigree reasoning | `AI_ASSESSED` |
| Founder-provided LinkedIn snapshot (M§6.5) | Never fetched. Treated as founder-controlled and complete: the quote must be found in the snapshot text (no "unverifiable" allowance); stored with fetch status `FOUNDER_PROVIDED` | `FOUNDER_ATTESTED` |
| Any | Value not literally in its quote, quote not in source, unknown metric, out of range | Dropped (listed in `rejected`) |
| `prior_shipped_products` = 1 (verifier-v2) | The quote contains a shipping verb (shipped, deployed, launched, released, published, "live at") instead of the numeral; larger counts still need the number | Same status rules as above |
| `prior_venture_users` / `prior_venture_revenue_usd` (metrics-v3) | Must name the prior venture in `subject`, and the venture's name must appear in the checked source. From founder text or a LinkedIn snapshot | `FOUNDER_ATTESTED` |
| Same, third-party page (search-found or founder-submitted) | Quote found, page names the venture **and** a founder (`project_members.display_name`), and is not the venture's own site (host label equals the venture name) | `PUBLIC_WEAK`; otherwise dropped (search) or `FOUNDER_ATTESTED` (founder link) |
| Contradiction | Same metric/subject/period differs by >25%: weaker claims that disagree with the strongest tier, or the whole group if the strongest tier disagrees internally | `MISSING_OR_CONTRADICTED` |

**verifier-v4 (2026-10-11).**
- A search citation that redirects to a page the founder submitted no longer replaces it. This collision rejected every founder claim from a YC profile as `UNKNOWN_SOURCE`.
- Directory listings given as the website (`ycombinator.com`, Crunchbase, Product Hunt, app stores, Wellfound, Devpost, F6S) are third-party, not founder-controlled.
- With no domain of its own, a search page confirms the company by naming it plus a founder's full name.
- A prior-venture quote that describes a job at that company ("Head of Product at X") is rejected as `EMPLOYMENT_NOT_VENTURE`.

Gemini's grounding metadata (`url_context_result`, `url_citation`) is recorded (`grounding_seen`) but is not sufficient on its own; the server-side quote check is the gate. A page on the founder's own domain is never more than founder-attested, however official it looks.

**Prior ventures (`research-corroboration-v3`).** The corroboration pass also receives the founders' listing names and any founder-provided profile text as untrusted `<founder_profile>`, and searches for third-party coverage naming both a prior venture and a founder. Names can collide (two people called Ana Lee); requiring venture and founder on one page is the minimum, and founder disputes plus reviewers handle the rest.

Pedigree (M§2.3): the metric vocabulary in `metrics.ts` is closed and is passed to Gemini as an enum, so schools, demographics, and employer prestige have no field to occupy. A regex on assessment rationales is a backstop only.

## 5. Scoring (`quality-scores.ts`)

Implements M§4.3–4.5 and BACKEND_STACK §5.1: rubric → `s ∈ {0, .25, .5, .75, 1}`; `adjusted = c·s + (1−c)·0.5`; per sub-factor the highest-`c` claim wins, then the higher rubric level `s`, then most recent, then metric code and claim id. `evidence_quality` is derived (share of claims with `c ≥ 0.65`, `c = 1`). Missing evidence is neutral, never negative.

**Effective stage (approved 2026-10-10).** Weights and scenario priors use the highest stage at or below the founder's declared stage whose `normalization_rules.stage_evidence` requirements all hold: PROTOTYPE needs `product_status` ≥ prototype, LAUNCHED needs `launched` (founder-attested suffices), EARLY_REVENUE needs MRR ≥ $1 and REPEATABLE_REVENUE MRR ≥ $5,000 plus ≥ 50% recurring, both at reviewer-verified strength (`c ≥ 0.85`, M§4.7 "verified revenue"). Without it, the stage dropdown alone moved the neutral scenario value 3.8× (IDEA $416k vs REPEATABLE_REVENUE $1.58M). Snapshots store both stages.

**Valuation (`model-value.ts`).** M§4.6–4.10: scenario probabilities `softmax(ln p_k + β_k(Q − 0.5))`; present values over `H = 5`; operating value `net_cash + ARR × stage multiple` at revenue stages (ARR = 12 × the strongest MRR claim with `c ≥ 0.85`), else 0; blend with M§4.8's `alpha_stage`; demand multiplier `exp(0.40(D − 0.5))` clamped to [0.75×, 1.5×] the previous round, or 1 for a first round. Model outputs are rounded to 8 decimals; the unit price is `floor(round_implied × 10^6 / 1,000,000)` micro-USD in exact integer arithmetic (M§4.10 and the `valuation_snapshots` check constraint; BACKEND_STACK §5.6 said round-half-up and was corrected). No net-cash metric exists yet, so `current_net_cash = 0`. Only `default_sector` envelopes exist, so sector does not yet change the value.

**Rubric thresholds in `valuation-v0.1.json` are invented demo priors** and need team sign-off before the model version leaves `DRAFT`. Stage and factor weights are M§4.3–4.4 verbatim.

## 6. Failure states

| Situation | Behavior |
|---|---|
| Gemini down / invalid JSON for one pass | Run is `PARTIAL`; the other pass and collectors still count |
| Both passes fail and no collector data | Run `FAILED` (`AI_UNAVAILABLE`); valuation still works from existing claims |
| Unreadable link (login, paywall, Google Docs, video, HTTP error) | `PARTIAL` with a per-source remediation warning |
| Process dies mid-run | Lease (5 min) expires; `recoverStaleRuns()` marks it `FAILED` (`LEASE_EXPIRED`) |
| Confirm retried | Row lock + `confirmed_at`: second call returns `ALREADY_CONFIRMED` |

## 7. Security

- SSRF: `safe-fetch.ts` allows http(s) on 80/443 only, validates every DNS answer inside the socket lookup (no rebinding window), blocks private/reserved IPv4 and IPv6 ranges, re-validates redirects (≤4), caps bodies at 2 MB after decompression, 8 s deadline.
- Prompt injection: page and founder text are delimited and labeled untrusted; output is schema-constrained; nothing Gemini says is trusted without the quote check.
- Privacy: founder text and run results are only served to project editors; page text stored is public web content (≤200 KB per page). `store: false` on every Gemini call.

## 8. Known limits (demo shortcuts)

- Deleting a profile snapshot erases `profile_snapshots.text`, but research runs that already used it keep a copy in `research_sources.text_excerpt` (append-only) and in confirmed claims' quotes. Production follow-up: erase those excerpts through a privileged deletion path.
- Saved snapshots (`/me/profile-snapshots`) are used only for projects whose founder or members include the snapshot's owner, and are part of the research cache key, so re-saving profile text triggers a fresh run.

- A third party could publish a page naming the startup and its domain with false numbers; it would count as `PUBLIC_WEAK` (0.65). Mitigations: contradiction marking, founder dispute, reviewer queue. Production follow-up: source reputation, domain age, reviewer sampling.
- `siteKey` approximates the registrable domain without the full Public Suffix List; unknown multi-part suffixes err toward "founder-controlled" (the lower level).
- PDFs and JS-rendered pages cannot be quote-checked by the server; claims from them stay founder-attested.
- Google Search is billed per executed query; the prompt asks for ≤6 and `research_runs.search_query_count` records usage, but the API offers no hard per-call cap that we found.
- Structured output with built-in tools is a Gemini 3 preview feature. Run `npm run probe:gemini` (backend) with a key before demoing; it was not run during implementation because no key was available.
- `traction_metrics`, score/valuation snapshots, reviewer verification endpoint, and the frontend review screen are not built here.
