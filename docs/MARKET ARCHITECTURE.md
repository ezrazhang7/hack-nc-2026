# Campus Startup Primary Market

## Product, Valuation, Tokenization, and Systems Architecture

**Status:** Hackathon implementation specification  
**Version:** 0.1  
**Default environment:** Solana Devnet with simulated currency  
**Product category:** Primary-issuance startup market simulator

**Nessie purchase flow:** [NESSIE_PURCHASE_FLOW.md](NESSIE_PURCHASE_FLOW.md) specifies bank-to-wallet funding, guarded minting, signed subscriptions, recovery, API contracts, and numerical fixtures. It refines funding, finality, event keys, and scheduled-close behavior without changing valuation or fee formulas.

---

## Contents

1. Executive summary
2. Product principles
3. Market architecture
4. Valuation methodology and weightings
5. Technical stack
6. Tiger Data, Gemini, and Solana integrations
7. Minting and tokenization
8. Data schema
9. Backend modules and APIs
10. Identity and manipulation controls
11. Reliability and reconciliation
12. Security requirements
13. Legal and product boundary
14. Cost strategy
15. Hackathon implementation plan
16. Testing checklist
17. Deferred production decisions
18. Final architecture

---

## 1. Executive summary

The product lets a student founder create a startup profile, submit evidence, receive a transparent model-implied valuation, and open a small primary issuance round. Other students subscribe directly from that issuance. They do not buy from or sell to other participants, and they cannot short the startup.

The system intentionally is **not** a stock exchange:

- no central limit order book;
- no investor-to-investor secondary trading;
- no automated market maker or continuous bonding curve;
- no leverage, margin, liquidation, or shorting;
- no claim that a hackathon receipt is legal equity;
- no use of an LLM to determine prices or settle transactions.

**Demo exception:** a clearly labeled, off-chain, seeded market simulator may show secondary-style trading (bonding curve, buys and sells, volume) for the demo company using play credits only. It never touches the system described here: it reads the real unit price, model value, and evidence one way, and its activity reaches valuation formulas only as a labeled what-if. See AGENTS.md (scope discipline) and [DEMO_UI_PLAN.md](DEMO_UI_PLAN.md).

The hackathon version uses four sponsor technologies with non-overlapping responsibilities:

- **Capital One Nessie** simulates bank account balances and transfers to fund demo wallets; it does not settle startup receipts.
- **Tiger Data** is the operational database, immutable analytics history, and time-series dashboard engine.
- **Gemini** extracts structured claims from messy founder submissions and explains already-computed results.
- **Solana** enforces issuance rules, processes simulated payment, records allocations, and mints non-transferable participation receipts.

The valuation has two components:

1. **Model-implied reference value:** stage, sector, traction, product evidence, execution evidence, economics, and scenario outcomes.
2. **Crowd-demand adjustment:** a bounded adjustment based on the prior round's fill rate, breadth of participation, and concentration—not raw hype.

Every valuation stores its inputs, formulas, model version, and evidence references. A participant should always be able to answer: **“Why is this the price?”**

> **Legal boundary:** The Devnet product is a simulation and should describe its assets as non-transferable participation receipts or index units, not shares. Tokenization and non-transferability do not create a securities-law exemption. A real-money or return-bearing version requires qualified legal counsel, an actual issuer, offering documents, identity/compliance controls, and likely a registered or exempt intermediary structure.

---

## 2. Product principles

### 2.1 Primary issuance only

Every subscription is between a participant and the startup's current issuance round. Participants never transact with one another.

This eliminates the need for:

- bid/ask books;
- market makers;
- matching priority;
- secondary liquidity;
- short inventory;
- a liquidation engine;
- continuous price discovery.

An investor-to-investor resale would be secondary trading. It is excluded from the MVP.

### 2.2 Periodic rounds, not a continuous curve

Each startup opens a discrete issuance round at a single published price. Everyone accepted in that round receives the same price. Price changes occur **between rounds**, after new evidence and the preceding round's demand are evaluated.

This is preferable to a bonding curve because it is:

- easier to understand;
- deterministic and auditable;
- resistant to transaction-order front-running;
- compatible with pro-rata allocation;
- cheaper to implement;
- closer to primary fundraising than continuous speculative trading.

An “epoch” is therefore unnecessary terminology. The product should use **round**:

```text
Draft → Scheduled → Open → Filled/Expired → Finalized or Refunding
```

### 2.3 Evidence over pedigree

School prestige, race, gender, family background, and other protected or proxy attributes must have zero direct weight.

Relevant accomplishments may count only when converted into specific, verifiable evidence:

- a shipped project;
- sustained open-source contributions;
- relevant technical or operating experience;
- a documented competition result;
- prior customer discovery;
- prior revenue or usage;
- domain-specific expertise.

The model should not penalize a founder for having no prior record. Missing evidence receives a neutral prior with wider uncertainty, not a negative score. This is how the market remains open to dark horses.

### 2.4 Determinism at the financial boundary

The following must be deterministic:

- evidence status;
- factor normalization;
- factor weights;
- scenario probabilities;
- reference valuation;
- round price;
- allocation;
- fee distribution;
- minting;
- refunds.

Gemini may propose a structured interpretation, but deterministic application code validates the output and performs all calculations.

---

## 3. Market architecture

Large markets use sequencing, immutable event histories, derived read models, and reconciliation. NYSE's order-by-order feeds distribute events in matching-engine order, while Polymarket distinguishes order matching from later on-chain settlement. The system here adopts those bookkeeping ideas without building their exchange machinery.[^nyse-feed][^polymarket-settlement]

### 3.1 Canonical event flow

```text
User command
    ↓
Authenticate + authorize
    ↓
Validate against current round state
    ↓
Assign idempotency key / submit Solana transaction
    ↓
Solana program performs atomic state transition
    ↓
Confirmed chain event is indexed into Tiger Data
    ↓
Continuous aggregates update API read models
    ↓
UI displays provisional or finalized state
```

Every meaningful event includes:

```text
event_id
project_id
round_id
event_type
actor_identity_id
actor_wallet
amount
valuation_model_version
occurred_at
solana_signature
instruction_index
confirmation_status
```

### 3.2 Sources of truth

| Domain | Authoritative source |
|---|---|
| Subscription payment and receipt balance | Solana program state |
| Round parameters once opened | Solana Round PDA |
| Founder profile and private evidence | Tiger PostgreSQL |
| Evidence verification status | Tiger PostgreSQL |
| Model definition and weights | Versioned application configuration in Tiger |
| Model output history | Immutable valuation snapshots in Tiger |
| Dashboard charts | Tiger continuous aggregates derived from canonical events |
| Gemini interpretation | Never authoritative; cached proposal only |
| Mock bank balances/transfers | Nessie API; validated by the server adapter |
| Wallet funding mint/replay protection | Solana FundingReceipt PDA; saga recovery trail in Tiger |

The backend must never overwrite chain truth. A reconciliation worker compares indexed records with Solana and inserts missing events idempotently.

---

## 4. Valuation methodology

### 4.1 Why traditional methods need modification

| Method | Pre-seed usefulness | Use in this product |
|---|---:|---|
| DCF | Low when revenue and margins are unknown | Scenario framework only; never pretend a single forecast is precise |
| Public comparables | Moderate as a sector ceiling/anchor | Establish mature revenue multiples and margin envelopes, then discount heavily |
| Precedent venture rounds | Moderate | Calibrate stage/sector baselines if data is comparable and recent |
| Precedent M&A transactions | Moderate for terminal outcomes | Estimate plausible acquisition outcomes, not today's direct value |
| First Chicago/scenario method | High | Probability-weighted downside, base, and upside outcomes |
| Venture capital method | Moderate | Cross-check terminal outcome and required return |
| Scorecard/Berkus-style factors | High at idea stage | Structure qualitative evidence; not a substitute for calibration |
| LBO method | Very low | Excluded; pre-seed companies generally lack stable cash flow and debt capacity |
| Black–Scholes | Very low for company valuation | Excluded from core valuation; potentially relevant only to a defined option instrument |

IPEV describes private-capital valuation as a fair-value estimation exercise using appropriate techniques and judgment, not a universal formula.[^ipev] Damodaran's young-company framework emphasizes revenue growth, sustainable margins, reinvestment efficiency, private-company risk, and failure probability.[^damodaran-paper] The system follows those principles but exposes its assumptions instead of claiming accounting-grade fair value.

### 4.2 Valuation outputs

The backend produces four distinct values:

```text
fundamental_scenario_value
current_operating_value
model_reference_value
round_implied_value
```

They must not be collapsed in storage.

- **Fundamental scenario value** estimates risk-adjusted future outcomes.
- **Current operating value** uses verified assets, revenue, and relevant sector multiples when available.
- **Model reference value** blends those values according to company stage.
- **Round implied value** applies a bounded demand adjustment from the preceding round.

### 4.3 Factor scores

Every factor is normalized to the interval `[0, 1]`. Scores should be computed from explicit rubrics and verified claims, not free-form judgment.

#### Execution score `E`

```text
E = 0.35 × shipped_work
  + 0.25 × relevant_domain_ability
  + 0.20 × execution_velocity
  + 0.10 × team_coverage
  + 0.10 × commitment_evidence
```

Examples of accepted evidence include deployed products, commit history over time, relevant work, customer interviews, and complementary team roles. Prior founder success may inform `shipped_work`; university name does not.

#### Market score `M`

```text
M = 0.35 × plausible_market_size
  + 0.25 × growth_or_tailwind
  + 0.20 × pain_urgency
  + 0.20 × reachable_initial_segment
```

Market size is scenario-based. A CPG company can score well for a clearly reachable and profitable segment even if its theoretical ceiling is below that of a global software platform.

#### Product/evidence score `P`

```text
P = 0.30 × product_completeness
  + 0.25 × user_validation
  + 0.20 × differentiation
  + 0.15 × defensibility
  + 0.10 × evidence_quality
```

#### Traction score `T`

Traction is sector-specific. It must not compare raw SaaS users directly with CPG purchase orders.

```text
T = 0.30 × growth
  + 0.25 × retention_or_repeat_use
  + 0.20 × revenue_or_commitments
  + 0.15 × engagement_or_usage_depth
  + 0.10 × acquisition_efficiency
```

For pre-launch companies, signed pilots, credible waitlists with confirmation, interviews, prototypes used, or letters of intent may substitute for revenue—but must be labeled as weaker evidence.

#### Economics score `U`

```text
U = 0.30 × gross_margin_potential
  + 0.25 × capital_efficiency
  + 0.20 × payback_or_sales_efficiency
  + 0.15 × recurring_or_repeat_revenue_quality
  + 0.10 × runway
```

### 4.4 Stage-dependent category weights

The relative importance of the categories changes as observable data arrives.

| Stage | Execution `E` | Market `M` | Product `P` | Traction `T` | Economics `U` |
|---|---:|---:|---:|---:|---:|
| Idea | 40% | 30% | 20% | 5% | 5% |
| Prototype / pre-launch | 30% | 25% | 25% | 15% | 5% |
| Launched / pre-revenue | 25% | 25% | 20% | 25% | 5% |
| Early revenue | 20% | 20% | 10% | 35% | 15% |
| Repeatable revenue | 15% | 15% | 10% | 35% | 25% |

The composite quality score is:

```text
Q = wE × E + wM × M + wP × P + wT × T + wU × U
```

#### Rationale and limits of the weights

The factor selection is grounded in accepted valuation practice: young-company value depends on growth, margins, reinvestment, failure risk, business characteristics, and founder history; early founder choices and intellectual-property activity can predict later growth orientation; human and financial capital have predictive value.[^damodaran-drivers][^nber-growth][^human-capital]

The **exact percentages are product calibration priors**, not scientific constants. No credible research supports a universal factor table for every pre-seed startup. Therefore:

- weights are stored in a versioned table rather than hard-coded invisibly;
- backtesting must eventually replace hand-set priors;
- every score snapshot records the applicable model version;
- sector and stage cohorts must be calibrated separately;
- sensitive and prestige-proxy features are prohibited;
- model performance and disparate impact should be audited before real use.

### 4.5 Evidence confidence

Each claim receives a verification multiplier `c`:

| Evidence status | `c` |
|---|---:|
| Independently verified API or document | 1.00 |
| Reviewer-verified artifact | 0.85 |
| Public but weakly attributable source | 0.65 |
| Founder-attested only | 0.35 |
| AI-assessed judgment factor with a verified citation ([EVIDENCE_RESEARCH §4](EVIDENCE_RESEARCH.md)) | 0.35 |
| Missing or contradicted | 0.00 |

For a metric with raw normalized score `s` and a neutral prior `μ = 0.50`:

```text
adjusted_score = c × s + (1 − c) × μ
```

This avoids treating unverifiable claims as facts while also avoiding an automatic zero for a new founder with little history.

### 4.6 Scenario valuation

Define four mutually exclusive terminal scenarios:

1. failure/shutdown;
2. sustainable small business;
3. venture-scale base outcome;
4. breakout/dark-horse outcome.

For scenario `k`:

```text
terminal_enterprise_value_k = terminal_revenue_k × sector_multiple_k

present_value_k = terminal_enterprise_value_k / (1 + r_k)^H

fundamental_scenario_value = Σ(probability_k × present_value_k)
                           + current_net_cash
```

Where:

- `H` is the forecast horizon, initially five years;
- `r_k` is a scenario-specific annual discount rate;
- terminal revenue and multiples use sector-specific outcome envelopes;
- probabilities sum to `1.0`;
- failure value defaults to recoverable net assets, normally near zero.

The composite quality score tilts—but cannot eliminate—the baseline scenario probabilities:

```text
logit_odds_k = baseline_logit_odds(stage, sector, k)
             + beta_k × (Q − 0.50)

probability_k = softmax(logit_odds)_k
```

The breakout scenario remains non-zero for an unknown team. Strong evidence raises its probability, while lack of pedigree alone does not reduce it below the sector-stage prior.

### 4.7 Current operating value

When there is verified revenue:

```text
current_operating_value = current_net_cash
                        + verified_ARR × stage_adjusted_revenue_multiple
```

For transaction-oriented sectors, replace ARR with an appropriate metric such as gross profit, contribution profit, or trailing revenue. The metric and multiple source are stored with the snapshot.

At the idea stage:

```text
current_operating_value = max(0, verified_net_assets)
```

This correctly acknowledges that current tangible value may be near zero without asserting that the future opportunity is worth zero.

### 4.8 Blending current and future value

```text
model_reference_value = alpha_stage × current_operating_value
                      + (1 − alpha_stage) × fundamental_scenario_value
```

| Stage | Current weight `alpha_stage` | Scenario weight |
|---|---:|---:|
| Idea | 10% | 90% |
| Prototype / pre-launch | 20% | 80% |
| Launched / pre-revenue | 30% | 70% |
| Early revenue | 50% | 50% |
| Repeatable revenue | 70% | 30% |

These are calibration priors. The scenario component dominates early because historical financial statements contain little information; the operating component gains weight as repeatable economics appear.

### 4.9 Crowd-belief adjustment

Crowd belief affects only the **next** round. It never changes the price for people already participating in an open round.

Define:

```text
fill_rate = accepted_dollars / target_dollars

buyer_breadth = min(1, unique_eligible_buyers / target_unique_buyers)

HHI = Σ(buyer_allocation_share_i²)

deconcentration = 1 − normalized_HHI

demand_score D = 0.55 × min(1, fill_rate)
               + 0.30 × buyer_breadth
               + 0.15 × deconcentration
```

Founder, team, duplicate-identity, and flagged subscriptions are excluded from these calculations.

Convert demand to a bounded multiplier:

```text
demand_multiplier = exp(0.40 × (D − 0.50))
```

For `D ∈ [0,1]`, the multiplier is approximately `0.82×–1.22×`. This prevents crowd enthusiasm from overwhelming fundamentals.

The next round's implied value is:

```text
raw_round_value = model_reference_value × demand_multiplier

round_implied_value = clamp(
  raw_round_value,
  previous_round_value × 0.75,
  previous_round_value × 1.50
)
```

The asymmetric cap permits strong verified progress while limiting abrupt manipulation. A material financing, contract, or other exceptional event may bypass the cap only through a separately labeled model event.

### 4.10 Unit price

The simulator uses a fixed reference unit count:

```text
REFERENCE_UNITS = 1,000,000

unit_price_micro_usd = floor(round_implied_value × 1,000,000 / REFERENCE_UNITS)

allocated_units = floor(project_proceeds_micro_usd / unit_price_micro_usd)
```

All settlement amounts are integers in micro-USD, the mock USDC base unit (6 decimals, matching real USDC). This is both the storage precision and the price tick: at the prices this model produces (for example $0.135824 per unit for a $135,824 valuation), a one-cent tick would misstate the valuation by several percent, which is why US equities quote sub-dollar stocks in $0.0001 increments. Rounding the unit price down changes each unit by less than $0.000001, so the whole valuation by less than $1. Sub-unit dust (`project_proceeds − allocated_units × unit_price`) stays in project proceeds (purchase flow §8). The UI may display rounded values, but displayed values never feed back into calculations.

These are index or participation units, not a representation of legal capitalization. If a future regulated product issues real securities, actual fully diluted capitalization and security rights replace `REFERENCE_UNITS`.

### 4.11 Round allocation

At round close:

```text
if total_requested ≤ available_amount:
    accepted_i = requested_i
else:
    accepted_i = available_amount × requested_i / total_requested
```

Use integer flooring per subscription as specified in BACKEND_STACK §6.3. Aggregate rounding remainder is not redistributed; it remains in participant refunds. Excess simulated currency is refunded to wallets. See the purchase flow's golden fixtures. Pro-rata allocation is preferred over first-come-first-served because it reduces bot and latency advantages.

### 4.12 Fees and founder reward

The founder already benefits from primary-issuance proceeds. The additional founder reward must therefore come out of the platform fee, not be charged as an unexplained second fee.

Initial configurable example:

```text
protocol_fee_bps = 100                 # 1.00%
founder_fee_share_bps = 4000           # 40% of the fee = 0.40% of accepted

protocol_fee = floor(accepted × protocol_fee_bps / 10,000)
founder_reward = floor(protocol_fee × founder_fee_share_bps / 10,000)
platform_revenue = protocol_fee − founder_reward
project_proceeds = accepted − protocol_fee
```

The fee is charged on the **accepted** amount only, so refunded oversubscription is never charged. Each rounded value is floored (in the participant's favor), and the remaining values are derived by subtraction, so the parts always reconcile to the accepted amount exactly. Multiplications use 128-bit intermediates (`u128` in Rust, `BigInt` in TypeScript, `NUMERIC` in SQL).

The UI displays all four values before confirmation. For an unincorporated hackathon profile, all amounts remain simulated.

---

## 5. Technical stack

### 5.1 Application stack

```text
Frontend:       Next.js 15 + React 19 + TypeScript in web/, static export (output: "export") to web/out/
Styling:        Hand-written CSS with design tokens (web/styles/*.css, route-scoped classes);
                GSAP + ScrollTrigger and fonts via next/font/google
Wallet:         Solana wallet adapter / current Solana client packages
Backend:        Node.js + TypeScript, implemented as one modular monolith
Validation:     Zod schemas shared between API and Gemini structured output
Database:       Tiger Cloud PostgreSQL + TimescaleDB
ORM/querying:   Drizzle or direct parameterized SQL
Chain program:  Rust + Anchor
Chain:          Solana Devnet
Asset program:  Token-2022
Payment asset:  Mock USDC-style Devnet mint
AI:             Gemini Flash-class model with structured JSON output
Charts:         Lightweight Charts, Recharts, or equivalent
Hosting:        One web/API deployment plus one scheduled worker
```

### 5.2 What not to add

Do not add the following to the hackathon build:

- Kafka;
- Redis unless a demonstrated bottleneck requires it;
- Kubernetes;
- multiple backend services;
- a bespoke chain indexer cluster;
- a custom oracle network;
- a central limit order book;
- a production custody system;
- real ACH, cash, Bitcoin, or mainnet funds.

PostgreSQL transactions, Solana atomic transactions, an RPC subscription, and a scheduled reconciliation worker are sufficient.

---

## 6. Integration responsibilities

### 6.1 Tiger Data

Tiger stores relational product data and time-series observations in one PostgreSQL-compatible system. Continuous aggregates precompute dashboard series, matching the Tiger Data use case promoted in MLH's current prize materials.[^mlh-prizes]

Use standard PostgreSQL tables for:

- identities and wallets;
- projects and founders;
- evidence and verification;
- model versions;
- rounds and subscriptions;
- canonical chain transactions;
- idempotency records.

Use hypertables for:

- traction measurements;
- score snapshots;
- valuation snapshots;
- operational market metrics.

Use continuous aggregates for:

- amount raised per minute/hour/day;
- unique participants per round;
- cumulative receipts issued;
- valuation and score history;
- founder rewards;
- project activity feeds.

Tiger provides financial aggregation helpers such as candlestick aggregates, but the UI should label the result as “implied valuation history,” not stock-price candles.[^tiger-candlestick]

### 6.2 Gemini

Gemini performs four bounded tasks:

1. **Claim extraction:** turn founder narrative and uploaded text into a proposed structured claim list.
2. **Evidence triage:** describe what proof is missing and route evidence to a verification method.
3. **Explanation:** translate deterministic factor contributions into plain language.
4. **Evidence research:** read the founder's links (URL context) and search the web (Google Search grounding) for cited, verbatim-quoted claims and cited assessments of four judgment factors. Deterministic code re-fetches every source, checks each quote, and assigns the evidence status; see [EVIDENCE_RESEARCH.md](EVIDENCE_RESEARCH.md).

Example structured output:

```json
{
  "claims": [
    {
      "metric": "monthly_revenue",
      "value": 800,
      "unit": "USD",
      "period_start": "2026-09-01",
      "period_end": "2026-09-30",
      "source_type": "founder_attested",
      "verification_required": true
    }
  ],
  "missing_evidence": ["payment processor export"],
  "warnings": []
}
```

Gemini supports schema-constrained structured output, but syntactically valid JSON is not proof that a claim is true. The application must validate semantics and evidence.[^gemini-structured]

Cost controls:

- call Gemini only when evidence content changes;
- hash normalized content and cache the result;
- use a Flash-class model;
- cap document size and output tokens;
- batch explanations when possible;
- never call Gemini during subscription settlement;
- never regenerate identical explanations on page load.

Tier requirement: on Gemini 3.x models, Google Search grounding is **not available on the free tier**; the paid tier includes 5,000 search requests per month (shared across Gemini 3 models), then $14 per 1,000.[^gemini-pricing] A free-tier key fails the corroboration pass with HTTP 429 ("exceeded your current quota") before any usage is recorded. URL context is free on both tiers, so the founder pass still runs and the research run ends `PARTIAL`. Enable billing on the key's project before demoing corroboration. Use a fast Flash model (in testing on 2026-10-10, `gemini-3.8-flash` took about 40 s to answer a trivial prompt and exceeded the 90 s pass timeout; `gemini-3.5-flash` answered in about 1 s). If the direct Gemini API is unavailable, `RESEARCH_PROVIDER=openrouter` runs the same research through Gemini on OpenRouter (EVIDENCE_RESEARCH §3).

### 6.3 Solana

Solana owns the money-like state transition. The Devnet subscription instruction atomically validates the round, accepts mock currency into its vault, and records the commitment. After scheduled close, guarded settlement instructions split fees, mint final receipts, and refund excess. Do not issue final receipts at commitment time for pro-rata rounds.

MLH explicitly directs hackathon teams to Solana Devnet and highlights Anchor as a program-development framework.[^mlh-solana]

Solana accounts:

```text
Project PDA
  project_id
  founder_wallet
  receipt_mint
  treasury_vault
  founder_reward_bps
  status

Round PDA
  project
  round_number
  opens_at
  closes_at
  unit_price_micro_usd
  max_units
  target_amount
  model_hash
  evidence_root
  total_committed
  status

Subscription PDA
  round
  buyer_wallet
  gross_amount
  accepted_amount
  units
  refunded_amount
  status

Vault PDA / token accounts
  project proceeds
  protocol fees
  founder rewards
```

Program instructions:

```text
initialize_protocol
fund_mock_usdc
create_project
open_round
subscribe
finalize_round
mint_final_allocation
refund_excess
cancel_and_refund
withdraw_project_proceeds
withdraw_founder_rewards
```

---

### 6.4 Capital One Nessie

Use the complete [Nessie purchase-flow design](NESSIE_PURCHASE_FLOW.md). A server-side adapter reads fictional account balances and transfers mock dollars to a configured funding treasury; a durable saga then mints wallet tokens through a replay-protected FundingReceipt PDA. Solana stays authoritative for participation, and Tiger records recovery evidence.

Nessie funding and startup subscription are separate. No second bank debit, merchant purchase, or automatic bank payout is created when users subscribe or receive token refunds. Ambiguous provider writes are reconciled without blind retries. Validate the actual API contract with the team's sandbox key before implementation.

---

### 6.5 Founder profiles (LinkedIn)

The founder flow is **paste two links (startup website and LinkedIn), and the system does the rest**. The website goes through evidence research (§6.2). LinkedIn needs a different path, because LinkedIn pages require sign-in and LinkedIn's terms prohibit scraping.

**Never scrape LinkedIn.** That includes third-party scraper APIs: Proxycurl shut down in July 2025 after LinkedIn sued it, and the case ended in a permanent injunction requiring it to delete the data.[^proxycurl] The research pipeline already classifies LinkedIn URLs as `LOGIN_REQUIRED` and never fetches them.

**Demo path: a stored profile snapshot.** The founder still pastes the LinkedIn URL. If a snapshot of the profile, provided by the founder with consent, is stored for that canonical URL, the pipeline uses its text as founder-provided text, in place of fetching the page.

- The snapshot holds only evidence-bearing facts. Location, connection and follower counts, interests, and other people's names are not stored.
- Every claim from it is `FOUNDER_ATTESTED` (the founder-attested multiplier, §4.5), exactly like pasted founder text.
- The UI labels it "LinkedIn details provided by the founder", never "scraped" or "verified".
- The demo snapshot is `backend/fixtures/demo-linkedin-snapshot.json`, loaded through `PROFILE_SNAPSHOT_FILES` and matched on the `/in/<handle>` path, so URL variants match. Delete it when the founder asks.
- The snapshot is quote-checked as a complete source: a quote missing from it is dropped, and it is stored with fetch status `FOUNDER_PROVIDED`.

**What a profile can contribute.** Under the closed metric vocabulary (`metrics-v2`) and §2.3, profile fields are treated as follows:

| Profile field | Treatment |
|---|---|
| School, degree, employer names, titles, follower counts | Zero weight (§2.3). No metric exists for them. |
| Years of work directly relevant to this startup's domain | `relevant_experience_years` → `relevant_domain_ability` |
| Functions the team covers (engineering, design, sales, ...) | `team_functions_count` → `team_coverage` |
| Full-time commitment, if stated | `full_time_founders` → `commitment_evidence`. Never inferred from "student". |
| Prior shipped projects | `prior_shipped_products` → `shipped_work` (see below) |
| Competition results | No metric yet |
| Self-listed skills | Not evidence on their own |

**Prior shipped work (`metrics-v2`, approved 2026-10-10).** §2.3 lists "a shipped project" and "a documented competition result" as evidence, and §4.3 says prior founder success may inform `shipped_work`. `prior_shipped_products` counts products the founders previously shipped to real users, excluding this startup, and feeds `shipped_work`. Its demo rubric maps 0 to the neutral 0.5 (no penalty for having no record), 1 to 0.75, and 3 or more to 1; these thresholds are invented priors pending sign-off. When several claims feed one sub-factor with equal confidence, the higher rubric level wins, so a past project can add credit but never erase credit for this startup's own launched product. Founders usually describe a product ("built and shipped X") without stating a count, so the verifier accepts a value of 1 when the verbatim quote contains a shipping verb; larger counts must be stated. A competition result alone is not yet scored.

**Prior-venture traction (`metrics-v3`, approved 2026-10-10).** `prior_venture_users` (peak users) and `prior_venture_revenue_usd` (annual revenue) of a venture a founder built before this startup feed `shipped_work`. Each claim names the venture in `subject`, so two ventures never contradict each other. From a profile they are founder-attested (each bounded to [0.325, 0.675]); a third-party page naming both the venture and a founder raises one to public-weak. Demo rubrics map 0 to neutral 0.5, users ≥ 1,000 to 0.75 and ≥ 10,000 to 1, revenue ≥ $10,000 to 0.75 and ≥ $100,000 to 1; invented priors pending sign-off.

**Long-term options**

| Option | What it provides | Limits |
|---|---|---|
| **Verified on LinkedIn API** (preferred) | With the member's OAuth consent: identity plus LinkedIn-verified workplace and profile details. The Lite tier is free for all members, up to 5,000 requests per day.[^li-verified] | App approval and LinkedIn's branding rules; not a substitute for regulated ID checks. Employer names still carry zero weight; it proves the founder is real and confirms relevant experience. |
| **Member data export upload** | The founder's own "Get a copy of your data" archive (positions, education, skills). Works everywhere with no API approval. | Extra step for the founder; still founder-attested. Confirm the archive's file layout before parsing it. |
| **Sign In with LinkedIn (OpenID Connect)** | Name, email, picture only[^li-oidc] | Proves account ownership only; LinkedIn states it is not identity verification. |
| **Member Data Portability API** | Full structured profile with consent[^li-dma] | EU/EEA/Switzerland members only, so not usable for a US campus. |

---

## 7. Minting and tokenization process

“Minting,” not mining, is the relevant process. No proof-of-work mining is involved.

### 7.1 Receipt design

Create one Token-2022 mint per project with:

- `NonTransferable` enabled;
- zero or fixed decimals;
- mint authority controlled by the protocol PDA;
- metadata clearly stating “Devnet participation receipt; not equity; no redemption promise”;
- no holder-controlled transfer path.

Solana's `NonTransferable` extension causes normal transfer instructions to fail, while still allowing authorized minting and holder burning.[^solana-nontransferable]

For the simplest version, receipts represent cumulative allocated index units across rounds. The `Subscription PDA` preserves the price and round at which each allocation occurred.

### 7.2 Project onboarding

```text
1. Founder verifies campus identity.
2. Founder connects a wallet and signs a challenge.
3. Backend creates project record in Tiger.
4. Solana program creates Project PDA.
5. Program creates Token-2022 non-transferable receipt mint.
6. Mint authority is assigned to the program PDA.
7. Chain addresses are written back to the project record.
```

### 7.3 Opening a round

```text
1. Valuation service freezes an evidence snapshot.
2. Service computes all scores and scenario values.
3. Canonical JSON is hashed.
4. Backend writes valuation snapshot to Tiger.
5. Authorized transaction calls open_round.
6. Round PDA stores price, supply, timing, model hash, and evidence root.
7. Tiger records and indexes the confirmed chain event.
```

The full evidence stays off-chain. Only tamper-evident hashes and public round parameters go on-chain.

### 7.4 Subscription

```text
1. Participant verifies identity and connects wallet.
2. UI displays round price, requested amount, fees, and risk disclosure.
3. Backend issues a short-lived eligibility attestation or allowlist proof.
4. Participant signs the subscribe transaction.
5. Program verifies round state and eligibility.
6. Mock USDC moves atomically into the vault.
7. Subscription PDA is created or updated.
8. Program emits SubscriptionAccepted.
9. After allocation is final, receipt units are minted.
10. Indexer records the transaction in Tiger.
```

If the product uses immediate fixed allocation rather than end-of-round pro rata, steps 8–9 may occur in the same transaction. Pro-rata oversubscription requires commitments first and final minting after close.

### 7.5 Finalization and refunds

```text
1. Round reaches scheduled close time. Target attainment is a progress indicator and does not end a pro-rata round early.
2. Program calculates or verifies deterministic pro-rata allocation.
3. Accepted amounts become withdrawable project proceeds.
4. Protocol fee is split between platform and founder reward vault.
5. Excess commitment becomes refundable.
6. Final receipt units are minted.
7. Round status becomes Finalized.
```

For a hackathon, pro-rata calculations may be computed off-chain and verified using a committed Merkle root if fully on-chain iteration is too expensive. A small demo cohort can instead finalize each subscription directly.

---

## 8. Data schema

The canonical DDL is the single migration [`db/migrations/0001_market_schema.sql`](../db/migrations/0001_market_schema.sql). This section explains its design; when they differ, fix whichever is wrong rather than letting them drift.

### 8.1 Core tables

| Area | Table | Notes |
|---|---|---|
| Auth | `auth."user"`, `auth.session`, `auth.account`, `auth.verification` | Better Auth with the emailOTP plugin for campus-email codes and sessions. Reached only through Better Auth. |
| Identity | `identities` | Linked 1:1 to `auth."user"`. Stores a keyed HMAC of the campus email, `platform_role` (user, reviewer, admin), and risk flags. |
| Identity | `wallets`, `wallet_challenges` | Wallet binding by signed, single-use, expiring nonce (§12). At most 2 active wallets and one primary per identity, and a wallet never moves to another identity (§10.1), enforced in the database. |
| Projects | `sectors`, `projects`, `project_members` | Founder and team membership drive the self-subscription rules (§10.1). |
| Evidence | `ai_intake_proposals` | Cached Gemini proposals, keyed by content hash and prompt version. Advisory only. |
| Evidence | `evidence_claims` | Immutable. A correction supersedes exactly one prior claim. |
| Evidence | `evidence_verifications` | Append-only status history (§4.5 levels). The latest row is the current status (`evidence_claim_current_status` view). Confidence multipliers come from the model version, not this table. |
| Model | `model_versions` | Parameters freeze once a version leaves `DRAFT`. At most one `ACTIVE`. |
| Rounds | `rounds` | Terms (price, supply, timing, fees, model hash, evidence root) freeze once a round leaves `DRAFT` (§10.3), and must match the valuation snapshot they cite. `target ≤ max_units × unit_price` guarantees allocations cannot exceed supply. One active round per project. |
| Settlement | `subscriptions`, `chain_events` | Mirrors of Solana state; the chain is authoritative. Chain events are deduplicated by `(chain, signature, instruction_index, event_index)`, and only their confirmation status may advance. |
| Funding | `banking_accounts`, `funding_intents`, `banking_attempts`, `funding_chain_attempts`, `funding_transitions`, `subscription_intents` | The Nessie funding saga and identity-scoped subscription reservations; see the purchase flow §5–§7. |
| Ops | `idempotency_keys`, `rate_limits`, `indexer_state`, `audit_log` | Same idempotency key and same request replay the stored response; a different request is a conflict (§11.2). Rate-limit counters (§10.2), the reconciliation cursor (§11.3), and the append-only admin audit trail. |

### 8.2 Time-series hypertables

| Hypertable | Time column | Purpose |
|---|---|---|
| `traction_metrics` | `observed_at` | Traction points derived from evidence claims |
| `score_snapshots` | `calculated_at` | Factor scores per valuation run |
| `valuation_snapshots` | `calculated_at` | Values, unit price, and hashes per valuation run. Primary key `(id, calculated_at)`; rounds reference both columns. |
| `market_metrics` | `observed_at` | Integer metrics derived from finalized chain events, written in the same transaction as the event |

Score and valuation snapshots from one run share a `valuation_run_id`. The `market_metrics` codes are gross, accepted, fee, founder reward, refund, receipt units minted, and `NEW_PARTICIPANT`. `NEW_PARTICIPANT` is `1` for an identity's first finalized subscription to a project, so summing it gives cumulative unique participants.

### 8.3 Continuous aggregates

All are real-time (`materialized_only = false`), so the live demo reflects new rows immediately, and each has a refresh policy.

| View | Source | Shows |
|---|---|---|
| `project_metrics_1m` / `project_metrics_1h` | `market_metrics` (1h rolls up 1m) | Totals per project and metric |
| `round_funding_progress` | `market_metrics` | Committed and accepted micro-USD and subscription count per round per minute; running totals are computed at query time |
| `project_valuation_daily` | `valuation_snapshots` | First, high, low, and last implied value and unit price per day, labeled "implied valuation history" |
| `project_participant_growth` | `market_metrics` | Daily new participants |
| `project_founder_rewards_daily` | `market_metrics` | Daily founder rewards |

The frontend reads these views instead of scanning raw events. The demand score (§4.9) is not computed from them: it reads `subscriptions` directly, with founder, team, and flagged identities excluded.

### 8.4 Conventions

- **Money:** market amounts mirrored from Solana are `BIGINT` micro-USD (`*_micro_usd`), rounded as in §4.10–4.12. Model outputs (scores, valuations) are exact `NUMERIC`, never floating point. The Nessie funding tables use the same `BIGINT` micro-USD. The UI shows dollars (`$50.00`, with unit prices and sub-cent amounts up to six decimals), formatted from the integer without floating point; displayed values never feed back into calculations.
- **IDs and time:** `uuid` keys and `timestamptz` throughout.
- **Immutable history:** evidence claims, verifications, snapshots, traction, market metrics, funding transitions, and the audit log are append-only. The runtime role has no `UPDATE`/`DELETE` on them, and a trigger rejects those operations as a second guard. Corrections append new rows.
- **Hypertable keys:** every unique key on a hypertable includes its time column (a TimescaleDB requirement). Foreign keys may point from a hypertable to a regular table or from a regular table to a hypertable, never between two hypertables.

### 8.5 Roles

Migrations run as the service owner (`tsdbadmin` on Tiger Cloud). The API and worker connect as `prospecto_app`, which has `SELECT` on everything, `INSERT` where rows are created, `UPDATE` only on mutable state, and no `DELETE`, `TRUNCATE`, or DDL outside Better Auth's own schema.

---

## 9. Backend modules and APIs

### 9.1 Modular monolith

```text
identity/
projects/
evidence/
valuation/
rounds/
solana/
indexing/
analytics/
ai/
```

These are code boundaries, not separate deployed services.

### 9.2 API surface

```text
POST   /api/auth/email-otp/send-verification-otp   (Better Auth: campus email code)
POST   /api/auth/sign-in/email-otp                 (Better Auth: session cookie)
POST   /api/demo/sign-in                           (DEMO_MODE only: campus email, no code)
GET    /api/me
GET    /api/me/profile-snapshots                   (also POST; DELETE /:id)
POST   /api/wallets/challenge
POST   /api/wallets/verify
GET    /api/projects
POST   /api/projects
GET    /api/projects/:slug
POST   /api/projects/:id/publish
POST   /api/projects/:id/evidence
POST   /api/projects/:id/evidence/extract
POST   /api/projects/:id/research-runs             (GET /:runId, POST /:runId/confirm)
POST   /api/projects/:id/valuation/preview
POST   /api/projects/:id/rounds
GET    /api/rounds/:id
POST   /api/rounds/:id/eligibility
POST   /api/rounds/:id/subscribe/prepare
GET    /api/rounds/:id/subscriptions/me
GET    /api/projects/:id/history
GET    /api/transactions/:signature
```

The subscription endpoint prepares a transaction; the user's wallet signs it. The backend should not custody the user's private key.

### 9.3 Valuation service contract

Input:

```json
{
  "projectId": "uuid",
  "asOf": "timestamp",
  "modelVersion": "valuation-v0.1",
  "evidenceSnapshotHash": "sha256",
  "priorRoundId": "uuid-or-null"
}
```

Output:

```json
{
  "scores": {
    "execution": 0.64,
    "market": 0.72,
    "product": 0.55,
    "traction": 0.31,
    "economics": 0.40,
    "composite": 0.571
  },
  "values": {
    "currentOperating": 1000,
    "fundamentalScenario": 145000,
    "modelReference": 130600,
    "demandMultiplier": 1.04,
    "roundImplied": 135824,
    "unitPrice": 0.135824
  },
  "modelHash": "sha256",
  "explanationInputs": []
}
```

All currency calculations use integers in the smallest unit on-chain. Floating-point arithmetic must not determine payment or allocation.

---

## 10. Identity, self-trading, and manipulation controls

### 10.1 Founder self-subscription

The Solana program can reject the registered founder wallet, but a wallet check alone cannot stop a founder from creating another wallet.

The MVP should therefore bind wallets to a verified campus identity:

- one identity may control a limited number of wallets;
- project founders and team members cannot subscribe to their own project;
- related flagged identities are excluded from the demand score;
- changing wallets does not create a new eligible identity;
- the eligibility attestation expires and is scoped to one round.

### 10.2 Sybil and whale resistance

Controls:

- per-identity round cap;
- per-wallet and per-device rate limits;
- unique campus-email verification;
- buyer breadth in the demand score;
- HHI concentration penalty;
- anomaly flags for circular funding or coordinated timestamps;
- delayed final demand calculation until the round closes;
- model inputs frozen before opening.

### 10.3 No price changes during an open round

Traction updates submitted while a round is open apply to the next round. This prevents a founder, buyer, or administrator from changing the price after seeing commitments.

### 10.4 Explainability

Every valuation page should show:

- stage and sector baseline;
- factor scores and weights;
- verification confidence;
- scenario probabilities;
- current-versus-future blend;
- prior-round demand adjustment;
- model version and timestamp;
- material changes since the prior valuation.

---

## 11. Reliability and reconciliation

### 11.1 Confirmation states

```text
Prepared → Submitted → Confirmed → Finalized
                         ↘ Failed
```

The UI may display `Confirmed` provisionally but should distinguish it from `Finalized`.

### 11.2 Idempotency

- Every mutation request carries an idempotency key.
- Each chain event is uniquely identified by chain, signature, instruction index, and event index within that instruction.
- Indexing the same transaction twice must not create a second subscription.
- Round finalization must be safe to retry.
- Withdrawal and refund status come from program accounts, not UI state.

### 11.3 Reconciliation worker

Every minute in the demo environment:

```text
1. Fetch recently changed program accounts/signatures.
2. Compare against chain_events.
3. Insert missing events.
4. Refresh affected subscription and round mirrors.
5. Mark stale provisional transactions.
6. Emit an operational alert for irreconcilable differences.
```

### 11.4 Snapshots and replay

Tiger's derived metrics must be rebuildable from canonical chain events plus immutable off-chain evidence and model snapshots. Store model code commit and input hashes so a historical valuation can be reproduced.

---

## 12. Security requirements

- Never store wallet private keys.
- Store API keys only in server-side secret management.
- Require wallet-signature challenges with nonce and expiration.
- Validate Gemini output with the same Zod schema used by application code.
- Sanitize uploaded text and treat it as untrusted input.
- Use parameterized SQL.
- Make administrator actions append-only and auditable.
- Separate the authority that verifies evidence from the program upgrade authority where practical.
- Use a multisig for any mainnet upgrade authority in a future version.
- Cap round values and transaction amounts in the program.
- Add pause/cancel-and-refund paths before accepting anything of value.
- Test arithmetic overflow, rounding, duplicate subscription, premature finalization, and refund behavior.

---

## 13. Legal and product boundary

The detailed posture, product language guide and real-money roadmap are in [LEGAL_POSTURE.md](LEGAL_POSTURE.md).

### 13.1 Hackathon-safe positioning

Use:

- Solana Devnet;
- faucet-issued mock currency;
- non-transferable participation receipts;
- explicit simulation disclosures;
- no promise of profit, redemption, ownership, dividends, or conversion;
- no real cash, Bitcoin, stablecoins, or mainnet settlement.

Do not market the receipt as a share, security, investment, or synthetic exposure to a real company.

### 13.2 Why tokenization is not a loophole

U.S. securities analysis looks at the economic arrangement, not merely whether an instrument is called a token. Regulation Crowdfunding is a structured exemption involving issuer disclosure, investor limits, and a registered intermediary; the SEC states that a funding portal may not hold investor funds or securities, among other restrictions.[^sec-regcf][^sec-intermediary]

An unincorporated team also cannot casually promise corporate “shares” that do not legally exist. A future real-money product requires a separate legal architecture. Possible routes to investigate with counsel include:

- requiring a legal issuer before fundraising;
- partnering with a registered Regulation Crowdfunding intermediary;
- using a compliant special-purpose vehicle where permitted;
- limiting the product to non-investment patronage, donations, rewards, or purchases with no financial-return promise;
- operating only as analytics and simulation software.

None of these should be treated as a loophole or assumed exemption.

---

## 14. Cost strategy

### 14.1 Keep variable costs event-driven

- Gemini runs on evidence changes, not reads.
- Solana transactions occur only for project creation, round actions, subscriptions, and withdrawals/refunds.
- Tiger continuous aggregates serve charts.
- Content-hash caching prevents duplicate AI calls.
- The frontend polls a compact endpoint or uses server-sent events; it does not repeatedly scan the chain.
- Old time-series chunks can use Tiger's compression/columnar storage policies.

### 14.2 Avoid premature infrastructure

One web application, one database, one Solana program, and one scheduled worker are enough for the demo and early campus pilot.

---

## 15. Hackathon implementation plan

### Phase 1: deterministic vertical slice

1. Create project and founder profile.
2. Enter a small set of manual evidence claims.
3. Calculate transparent scores and reference valuation.
4. Open a fixed-price round in Tiger only.
5. Render the valuation breakdown and funding-progress chart.

### Phase 2: sponsor integrations

1. Add Gemini structured claim extraction.
2. Convert metrics tables to Tiger hypertables and add continuous aggregates.
3. Deploy Anchor program to Solana Devnet.
4. Create mock currency and one non-transferable receipt mint.
5. Add the Nessie funding adapter, durable saga, and guarded FundingReceipt mint path.
6. Complete one end-to-end subscription from a Nessie-funded wallet.

### Phase 3: trust and demo polish

1. Add wallet/campus identity binding.
2. Reject founder self-subscription.
3. Display model/evidence hashes and Solana explorer links.
4. Demonstrate a failed receipt transfer.
5. Demonstrate an oversubscribed or refunded round.
6. Show a second-round price updated by verified evidence and bounded demand.

### Recommended live demo

```text
Founder submits a narrative and GitHub/revenue evidence
→ Gemini extracts claims and requests missing proof
→ deterministic backend produces an explainable valuation
→ founder opens a five-minute Devnet issuance round
→ students fund demo wallets through Nessie mock transfers
→ three students subscribe with the resulting mock tokens
→ Solana records allocations and mints non-transferable receipts
→ Tiger updates funding, participant, and valuation dashboards
→ founder self-subscription and receipt transfer both fail
→ next round reflects new traction plus bounded crowd demand
```

---

## 16. Testing checklist

### Valuation

- Same inputs and model version always yield the same output.
- Category weights sum to `1.0` for every stage.
- Scenario probabilities sum to `1.0`.
- Missing evidence moves a score toward neutral rather than zero.
- School name and protected attributes cannot enter features.
- Demand multiplier remains within documented bounds.
- A single participant cannot create maximum demand score.
- Historical valuations reproduce from stored inputs.

### Solana

- Founder wallet cannot subscribe to own project.
- Closed or not-yet-open round rejects subscriptions.
- Subscription cannot exceed caps.
- Payment and state update are atomic.
- Non-transferable receipt rejects transfer.
- Duplicate instruction does not double-mint.
- Finalization cannot exceed maximum units.
- Excess funds can be refunded exactly once.
- Fee split matches disclosed basis points.

### Data and indexing

- Re-indexing a signature creates no duplicate event.
- Missed WebSocket event is recovered by reconciliation.
- Confirmed and finalized status are distinguished.
- Continuous aggregates match raw-event totals.
- Private evidence never appears in public APIs or on-chain.

---

## 17. Decisions deferred beyond the MVP

- real-money offering structure;
- incorporation and standardized security documents;
- registered intermediary partnership;
- KYC/AML and sanctions screening;
- tax reporting;
- custody and fiat/Bitcoin on-ramps;
- investor accreditation or Regulation Crowdfunding limits;
- legally enforceable shareholder rights;
- secondary trading or issuer repurchases;
- production oracle governance;
- externally calibrated sector/transaction datasets;
- formal model-risk and fairness audits.

---

## 18. Final architecture in one view

```text
┌──────────────────────── Next.js UI ────────────────────────┐
│ profiles │ evidence │ valuation explanation │ subscribe   │
└────────────────────────────┬────────────────────────────────┘
                             │
                 ┌───────────▼───────────┐
                 │ TypeScript monolith   │
                 │ identity + valuation  │
                 │ rounds + tx builder   │
                 └──────┬─────────┬──────┘
                        │         │
         structured     │         │ signed transaction
         extraction     │         │
                 ┌──────▼───┐ ┌───▼────────────────────────┐
                 │ Gemini   │ │ Solana Devnet + Anchor     │
                 │ advisory │ │ payment, allocation, mint  │
                 └──────────┘ └─────────────┬──────────────┘
                                           │ events/state
                 ┌─────────────────────────▼──────────────┐
                 │ Tiger Data / PostgreSQL               │
                 │ evidence + model versions             │
                 │ indexed chain events + time series    │
                 │ continuous aggregates + read models   │
                 └────────────────────────────────────────┘
```

Nessie funds demo wallets through the guarded saga described in [NESSIE_PURCHASE_FLOW.md](NESSIE_PURCHASE_FLOW.md).

The essential rule is simple:

> **Gemini interprets, deterministic code values, Solana settles, and Tiger remembers.**

---

## References

[^ipev]: International Private Equity and Venture Capital Valuation Board, [2025 IPEV Valuation Guidelines](https://www.privateequityvaluation.com/Portals/0/Documents/Guidelines/2025%20IPEV%20Valuation%20Guidelines.pdf).
[^damodaran-paper]: Aswath Damodaran, [*Valuing Young, Start-up and Growth Companies: Estimation Issues and Valuation Challenges*](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/younggrowth.pdf).
[^damodaran-drivers]: Aswath Damodaran, [Young Growth Companies: Value Drivers](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/littlebook/younggrowthvaluedrivers.htm).
[^nber-growth]: Christian Catalini, Jorge Guzman, and Scott Stern, [*Passive Versus Active Growth: Evidence from Founder Choices and Venture Capital Investment*](https://www.nber.org/papers/w26073), NBER Working Paper 26073.
[^human-capital]: Arnold C. Cooper, F. Javier Gimeno-Gascon, and Carolyn Y. Woo, [*Initial Human and Financial Capital as Predictors of New Venture Performance*](https://www.sciencedirect.com/science/article/pii/0883902694900132), Journal of Business Venturing.
[^nyse-feed]: NYSE, [TAQ Integrated Feed](https://beta.nyse.com/market-data/historical/taq-integrated-feed) and [Pillar Gateway Binary Protocol](https://www.nyse.com/publicdocs/nyse/NYSE_Pillar_Gateway_Binary_Protocol_Specification.pdf).
[^polymarket-settlement]: Polymarket, [Trading Quickstart: matching and on-chain settlement](https://docs.polymarket.com/trading/quickstart).
[^mlh-prizes]: Major League Hacking, [Upcoming Hackathon Prizes](https://www.mlh.com/events/prizes).
[^mlh-solana]: Major League Hacking, [Build with Solana](https://www.mlh.com/partners/solana).
[^tiger-candlestick]: Tiger Data, [Financial analysis with `candlestick_agg`](https://docs.tigerdata.com/api/latest/hyperfunctions/financial-analysis/candlestick_agg/).
[^gemini-structured]: Google AI for Developers, [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
[^gemini-pricing]: Google AI for Developers, [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) (Grounding with Google Search and URL context rows, checked 2026-10-10).
[^proxycurl]: Social Media Today, [LinkedIn wins legal case against data scrapers Proxycurl](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/); Nubela, [Goodbye, Proxycurl](https://nubela.co/blog/goodbye-proxycurl/).
[^li-verified]: Microsoft Learn, [Verified on LinkedIn FAQ](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/verified-on-linkedin/faq).
[^li-oidc]: Microsoft Learn, [Sign In with LinkedIn using OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2).
[^li-dma]: LinkedIn Help, [Member portability APIs](https://www.linkedin.com/help/linkedin/answer/a6214075).
[^solana-nontransferable]: Solana, [Token-2022 non-transferable tokens](https://solana.com/docs/tokens/extensions/non-transferrable-tokens).
[^sec-regcf]: U.S. Securities and Exchange Commission, [Regulation Crowdfunding Compliance and Disclosure Interpretations](https://www.sec.gov/files/divisions/corpfin/guidance/reg-crowdfunding-interps.htm).
[^sec-intermediary]: U.S. Securities and Exchange Commission, [JOBS Act FAQs About Crowdfunding Intermediaries](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/jumpstart-our-business).
