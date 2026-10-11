# Prospecto — Project Instructions

## Project context

Prospecto is **“the only platform where you can invest in your friend's startup.”** For this hackathon, it is a demo of a campus-startup primary market: founders publish evidence-backed startup profiles, receive a transparent model-implied valuation, and open simulated issuance rounds for other students.

The demo is not a stock exchange or a real securities offering. It uses simulated funds and non-transferable participation receipts on Solana Devnet. Never describe demo assets as equity, shares, guaranteed returns, or legally enforceable investments.

The canonical product and architecture specification is [`MARKET_ARCHITECTURE.md`](./MARKET_ARCHITECTURE.md). Treat files under `sources/` as read-only reference material; never edit, rename, move, or delete them.

## Intended stack

- Frontend: Next.js 15, React 19, TypeScript in `web/`, static export only (`output: "export"`), hosted on Vercel, which proxies `/api/*` to the backend
- Styling: hand-written CSS in `web/styles/` (no Tailwind)
- Backend: Node.js and TypeScript in a modular monolith
- Validation: shared Zod schemas
- Database: Tiger Cloud PostgreSQL with TimescaleDB
- Database access: parameterized SQL via `pg` (no ORM; see `docs/BACKEND_STACK.md`)
- Chain: Solana Devnet
- On-chain program: Rust and Anchor
- Asset standard: Token-2022 non-transferable receipts
- Payment: mock USDC-style Devnet token only
- Demo banking: Capital One Nessie mock banking REST API
- AI: Gemini Flash-class model with structured JSON output
- Charts: Lightweight Charts, Recharts, or an existing equivalent
- Hosting: one Vercel project with two Services (static frontend and the Hono API as Vercel Functions); no persistent worker, so reconciliation runs on demand

Prefer the tools and libraries already present in the repository. Do not add infrastructure such as Kafka, Kubernetes, Redis, new services, or real-money payment rails unless a documented requirement and demonstrated need justify it.

## Sources of truth

Use this order when resolving uncertainty:

1. The user's current request and explicitly approved decisions.
2. Repository product and architecture docs, especially the most recent applicable version.
3. Current official documentation for the exact framework, provider, protocol, or API version in use.
4. Primary standards, papers, and official industry references.
5. Secondary sources only when primary material is unavailable; label assumptions clearly.

Do not guess APIs, schemas, financial formulas, weights, legal claims, or protocol behavior. Record meaningful assumptions and cite sources in plans or implementation notes. If docs conflict, stop and surface the conflict before encoding either interpretation.

Gemini output is advisory only. Deterministic application code owns validation, scoring, valuation, allocation, fees, minting, and refunds.

Nessie is a demo banking adapter, not a bank connection or settlement authority. Use it only for mock customers, accounts, balances, and bank-side transfers such as funding a demo wallet. Solana remains authoritative for mock USDC balances, subscriptions, allocations, fees, refunds, and receipts. Tiger stores the cross-system intent and reconciliation trail.

## Change style

Make the smallest coherent change that solves the problem.

- Prefer modular, localized edits with clear interfaces.
- Extend or edit an existing file when practical; never replace or remove a file when a focused line-level change will do.
- Preserve unrelated code and user changes.
- Avoid broad rewrites, premature abstractions, speculative infrastructure, and new dependencies without a clear payoff.
- Keep financial logic, chain logic, AI extraction, persistence, and UI concerns separated.
- Keep Nessie behind a server-side adapter so its API contract and credentials never leak into client code or core valuation logic.
- Keep generated files and formatting-only changes out of behavioral changes when possible.
- Add comments for non-obvious intent, invariants, and risk—not for syntax the code already explains.

Label change summaries and, when commits are requested, commit messages using:

```text
<type>(<scope>): <concise imperative description>
```

Approved types:

- `feat`: new user-visible behavior
- `fix`: bug correction
- `ui`: visual or interaction-only work
- `data`: schema, migration, query, seed, or model-data work
- `security`: authentication, authorization, privacy, or hardening
- `refactor`: structural change with no intended behavior change
- `perf`: performance improvement
- `test`: test-only work
- `docs`: documentation-only work
- `build`: build or dependency work
- `ci`: automation pipeline work
- `chore`: maintenance that fits none of the above

Examples:

```text
feat(rounds): add founder round creation flow
fix(valuation): preserve neutral prior for missing evidence
ui(project-card): clarify simulated investment status
data(scores): version factor-weight snapshots
```

Keep each change focused on one purpose. In the final work report, group completed work under the same labels and explain what changed and why.

## Verification loop for major work

A major change includes a new feature, schema or migration, valuation/formula change, on-chain instruction, authentication or authorization flow, external integration, or architectural change.

Before implementing a major change:

1. Read the relevant repository docs completely.
2. Search current official docs and primary sources for the exact technologies and versions involved.
3. When useful, compare how established products or infrastructure providers solve the same problem. Identify which patterns Prospecto should adopt, simplify for the demo, or deliberately improve—and why.
4. Write an enumerated implementation plan with acceptance criteria, data flow, trust boundaries, failure states, test strategy, and any migration or rollback needs.
5. Call out conflicts, unknowns, and demo shortcuts. Do not hide a mock behind production-sounding language.

Then work one plan step at a time. After every step:

1. Inspect the diff for focus, clarity, and accidental changes.
2. Run the narrowest relevant formatting, type, lint, and test checks available.
3. Check the result against current official docs and repository requirements.
4. Review security at modified trust boundaries: input validation, authentication, authorization, secret handling, parameterized queries, sensitive logging, replay/idempotency, transaction atomicity, and dependency risk.
5. Check for scope drift, unnecessary complexity, duplicated logic, and opportunities to simplify.
6. Record any remaining limitation or intentionally deferred work.

Continue to the next step only after the current step passes. If a check fails, fix it or clearly report the blocker; never quietly waive it.

Routine, low-risk edits do not require a research ceremony. They still require proportional inspection and testing.

## Financial and data correctness

Valuations, allocations, fees, units, probabilities, and demand adjustments are high-risk code.

- Implement formulas exactly as specified in the current docs; never “improve” a coefficient or weighting without explicit approval and a versioned model change.
- Keep model inputs, outputs, evidence references, formulas, and model versions auditable.
- Use explicit decimal/fixed-point or integer units at financial boundaries; do not rely on binary floating point for money or token amounts.
- Define rounding direction and precision explicitly, especially for unit allocation, fees, and refunds.
- Add golden tests using documented examples, plus boundary, invalid-input, overflow, and invariant tests.
- Assert invariants such as probabilities summing to `1`, weights summing to `1`, allocations not exceeding supply, fees reconciling to gross amounts, and refunds never becoming negative.
- Treat schema migrations as forward-only, reviewable artifacts with compatibility and rollback considerations. Never silently rewrite historical valuation snapshots or canonical events.

## Security and privacy baseline

- Validate all untrusted input at the server or program boundary, even when the client validates it too.
- Enforce authorization per resource and per state-changing action; authentication alone is insufficient.
- Never commit secrets, private keys, tokens, personal data, or real financial information. Avoid logging them.
- Keep the Nessie API key server-side, never log authenticated request URLs, and store only the minimum mock customer/account identifiers needed for the demo.
- Use parameterized database access and maintained cryptographic libraries; do not invent cryptography.
- Make state transitions explicit and fail closed. Protect money-like actions with idempotency and replay resistance.
- Treat Nessie-to-Solana funding as a non-atomic saga: persist the intent first, retry safely, mint at most once, and reconcile both ledgers before reporting completion.
- Keep private evidence off-chain. Put only the minimum public parameters and tamper-evident hashes on-chain.
- Maintain the documented source-of-truth boundaries between Solana, Tiger/PostgreSQL, and cached Gemini interpretations.

## Testing and completion

Use the repository's existing scripts once they exist; inspect them before inventing new commands. Verification should be proportional to risk and should normally include:

- focused unit tests for changed logic;
- integration tests across changed boundaries;
- type checking, linting, and formatting;
- schema/migration validation for data changes;
- Anchor/program tests for on-chain changes;
- a manual happy path and at least one meaningful failure path for user-facing flows.

Do not claim success without running the relevant checks. Report exactly what passed, what was not run, and why. A demo shortcut is acceptable only when it is explicit, contained, safe, and documented with the production follow-up it replaces.

## Scope discipline

Optimize for a convincing, reliable hackathon demo—not imaginary production scale. Preserve the primary-issuance-only model: no secondary trading, order book, AMM, leverage, shorting, mainnet funds, or claims of legal equity. Keep the product explainable: a participant should always be able to answer, **“Why is this the price?”**

**Demo market-simulator exception (approved 2026-10-10).** The demo may include a clearly labeled, off-chain, seeded market simulator: a bonding curve, simulated traders, buys and sells, order book, candles, and play-credit P&L for the demo company (see [`docs/DEMO_UI_PLAN.md`](./docs/DEMO_UI_PLAN.md)). It must:

- never move, mint, burn, value, or redeem real-layer assets (mock USDC, round vaults, participation receipts) or write to valuation snapshots, rounds, or subscriptions;
- use its own play credits and sim units, labeled "Simulated session" wherever they appear;
- read real-layer values (unit price, model value, verified evidence) one way only; simulated activity may appear in real formulas only as a labeled what-if, never as a real input;
- be deterministic from a seed plus presenter inputs, so a session can be replayed exactly.

The real layer (evidence → valuation → round → settlement → receipts) keeps every rule above.

Nessie data and money are simulated. Never present a Nessie profile as identity verification, a real Capital One relationship, proof of funds, KYC/AML, or access to real banking rails.
