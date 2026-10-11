# Demo UI plan v3: real valuation, simulated market

**Status:** proposal, 2026-10-10. Nothing in this document is built yet. This version replaces v1 and v2.
**Scope:**
- `web/` changes for the hackathon demo;
- the backend additions those changes need, so the two sides stay aligned;
- a seeded market simulator;
- a press/feedback system for every button.

**Policy:** this plan relies on the demo market-simulator exception approved on 2026-10-10 (AGENTS.md, scope discipline; MARKET §1; LEGAL_POSTURE §1).

**Reads with:** [MARKET ARCHITECTURE.md](MARKET%20ARCHITECTURE.md) (M), [BACKEND_STACK.md](BACKEND_STACK.md) (B), [NESSIE_PURCHASE_FLOW.md](NESSIE_PURCHASE_FLOW.md) (N), [EVIDENCE_RESEARCH.md](EVIDENCE_RESEARCH.md) (E), [LEGAL_POSTURE.md](LEGAL_POSTURE.md).

**The goal:** judges should feel they are watching a new financial market come alive. The look is Bloomberg terminal × NYSE opening bell × block explorer, printed in Prospecto's existing evening-paper style.

**The thesis on stage:** *facts set the value, attention moves the market.* The facts are real. The attention is a simulated trading session, and it is labeled.

---

## 0. Two layers, one screen

| | **Real layer** | **Simulated layer** |
|---|---|---|
| What | One demo company: evidence → deterministic valuation → round terms locked on Devnet → real commitments in mock USDC → non-transferable receipts at close | A trading session in the same company: bonding curve, buys and sells, simulated traders, order book, candles, a whale, P&L |
| Where it runs | Backend + Tiger + Solana Devnet (existing and planned endpoints) | `web/lib/sim/`: a pure, seeded engine in the browser. It never writes to the backend or the chain. |
| Currency | Mock USDC, shown as `$`, with a violet on-chain tick linking to Devnet | Play credits, shown as `◇` (never `$`), and **sim units** (`SIM-LUMA`) |
| Labels | Its normal state, plus `LIVE`, `REPLAY` or `OFF_CHAIN` badges (§6) | A permanent "SIMULATED SESSION · play credits" stamp on every sim panel |
| Authority | Server-computed, auditable, hashed | Deterministic from `seed + presenter input log`; replays exactly |

The currency glyph tells the viewer which layer a number belongs to: `$` with a violet tick is real, `◇` is simulated.

### 0.1 How the layers couple

1. **Real → sim (one way, read-only):**
   - The curve's starting price is the real round's `unitPriceMicroUsd`.
   - The sim's fundamental anchor is the real `modelReference / REFERENCE_UNITS`.
   - Real events (round opened, evidence verified, a new valuation snapshot, real commitments) are injected into the sim as news, and the simulated traders react to them.
2. **Sim → real (what-if only):**
   - The sim's attention statistics (net demand against target, unique traders, holder concentration) are sent to `POST /api/valuation/demand-what-if` (B10).
   - That endpoint runs the real M§4.9 formula with the real bounds against the real model value and prior round.
   - The answer is displayed as *"If this attention were real, the next round would price at ×1.14 → $…"*, and it is never stored.
3. **Never:** the sim calls a mutating endpoint, touches mock USDC, receipts or vaults, or writes snapshots, rounds or subscriptions. This is enforced in code by an ESLint `no-restricted-imports` rule: `lib/sim/**` may import only `lib/api/read.ts`.

---

## 1. What stays: the inventory to retain

| Existing piece | File | v3 role |
|---|---|---|
| Halftone Fifth Avenue hero, live dateline, masthead, side column | `components/landing/*`, `styles/landing.css` | Unchanged. The landing page stays the front page of the paper. |
| Top ticker tape (`.tape`) | `LandingFX.tsx` | Unchanged look. On `/live/` it carries the merged tape (§3.4). |
| Split-flap board (`.flap`, `flapGroup`) | `LandingFX.tsx` | **Becomes the shared digit roller**, extracted to `components/fx/Flaps.tsx`. It drives every rolling number. |
| B1 scroll choreography (`t-chrome`, `t-in` wake-up) | `LandingFX.tsx` | Reused as the "panels wake up" step of the opening bell. |
| Round terminal (three columns: fills, chart, buy panel) | `RoundTerminal.tsx` | **The trading floor.** Same grid and ids, upgraded panel by panel (F6). Fixture mode stays exactly as the landing page uses it today. |
| Launch interview | `LaunchInterview.tsx` | Gains the evidence chamber as its "Web" step. |
| Estimate Desk | `EstimateDesk.tsx` | Becomes the reactor's what-if mode on the real model. |
| Founder cards, Protocol dialog, PageTurn, HeroText, ScrollReveal | as named | Unchanged. |

No file is deleted, and no existing design token changes meaning.

---

## 2. Visual direction: "the evening edition goes live"

The world stays a newspaper on black: Newsreader, JetBrains Mono with tabular figures, a Fraktur masthead, cream ink `#ECE5D3` on `#0A0A09`, and hairline rules. The terminal is that paper set in type for the trading floor: dense grids, thin rules and tabular numbers. It is never neon SaaS.

### 2.1 Tokens

Each color has exactly one meaning.

| Token | Value | Meaning |
|---|---|---|
| `--green` (existing) | `#5BD06A` | Up-ticks, buys, commitments |
| `--red` (existing) | `#EF5A43` | Down-ticks, sells, rejections, refunds |
| `--chain` | `#9C8CF2` | Solana settlement only (real layer) |
| `--sys` | `#7FA7C9` | System and news events |
| `--gold` | `#D9B45A` | Records and milestones: session high, target crossed, finalized |
| `--heat` | `#E39A4B` | Speculation: sim price far above the real model value |
| `--ground-3` | `#151412` | Raised panels |

- **Texture:** the hero's halftone dot screen at 6% on panels, and a 1px scan-line overlay at 2% inside the terminal.
- **Bloom:** one soft bloom per event, only on `Finalized` and session highs.
- **Sim stamp:** a rotated mono `SIMULATED SESSION` in `--carbon`, like a newspaper "SPECIMEN" overprint. It is honest without being loud.

### 2.2 Motion grammar

Motion is short and sharp; nothing floaty.

| Kind | Duration | Use |
|---|---|---|
| Tick | 120–180 ms, `cubic-bezier(.2,.9,.1,1)` | Digit flaps, flashes, row inserts |
| Move | 240–420 ms, `cubic-bezier(.16,1,.3,1)` | Order packets, cards flying, bars resizing |
| Ceremony | 0.8–3 s, GSAP timelines | Opening bell, round lock, evidence shock, whale, closing bell. Each is skippable with Esc. |

- **Up-ticks and down-ticks:** a 250 ms green or red flash behind the *changed digits only*.
- **Large moves:** scale to 108%, then settle.
- **Session high:** a gold ring expands and fades.
- **Trailing figures:** the percentage change trails the price by 150 ms.

### 2.3 Always alive, always caused

- **Ambient motion** comes only from causes on screen:
  - the sim's low-intensity trader flow (every print lands on the tape);
  - the real Devnet slot heartbeat (B14);
  - the market clock.
- **Every big move** has a visible cause: a tape row, a news event or a presenter action.
- **Reduced motion:** every component defines a finished rest frame. The sim then advances in visible steps once per second, with no tweening.

---

## 3. The simulated market engine (`web/lib/sim/`)

The engine is pure TypeScript with no DOM, unit-tested with Vitest (added to `web/` devDependencies at the version the backend pins, 5.0.2).

### 3.1 Determinism

- **PRNG:** `mulberry32(seed)`. All randomness flows from it, in a fixed call order.
- **Time:** a fixed tick of 100 ms of sim time. The render loop runs whole ticks off a time accumulator, so results never depend on frame rate.
- **Inputs:** presenter actions (buy, sell, whale cue, pause) and real-layer news are appended to an **input log** of `{tick, kind, payload}`. `seed + input log` reproduces a session exactly, which is used for rehearsal, `REPLAY`, and tests.
- **Ledger maths:** integer arithmetic in micro-credits (safe integers below 2^53). Floats are allowed only for agent decisions, never for balances or reserve.

### 3.2 Bonding curve

```text
price(s)        = p0 + k·s                        p0 = real unit price (micro-USD → micro-credits 1:1)
cost(s0 → s1)   = p0·(s1 − s0) + k·(s1² − s0²)/2  integer, rounded up for buys, down for sells
reserve         = cost(0 → supply)                exact
fee             = 1% of each trade (play credits; shown in the tape for realism)
```

`k` is chosen so a full session moves the price by a believable ±30–80% around the anchor. It is a sim parameter in `lib/sim/params.ts`, not a model parameter.

**Invariants, asserted every tick in development and in tests:**
- `reserve = cost(0 → supply)`;
- no negative balances;
- the conservation of play credits: Σ agent credits + reserve + fees stays constant;
- `price` is monotonic in supply;
- every sell can be paid out of the reserve.

### 3.3 Agents

There are about 120 simulated traders with fictional handles, plus the presenter.

| Type | Share | Behavior |
|---|---|---|
| Fundamentalists | 30% | Buy below the anchor `F` and sell above it, with size proportional to the gap. They pull the price back toward the real model value. |
| Momentum | 25% | Chase the last N candles' direction |
| Attention-driven | 25% | Trade more often as the attention index `A` rises |
| Noise | 20% | Small random orders, which keep the tape moving |
| Whale (scripted) | 1 | A $25k-equivalent buy at a cued tick, or when the presenter presses **W** |
| Presenter | 1 | Buy and sell buttons in the trade panel |

- **Arrivals:** Poisson with intensity `λ(t) = λ0·(1 + 3A)`.
- **Attention index `A` (0–1):** jumps on news (round open +0.4, verified evidence +0.3, whale +0.25, session high +0.1) and decays with a 20 s half-life. It is plotted under the chart, so the cause of a burst is visible.
- **Anchor `F`:** set from the real model value. When real evidence is verified and the real valuation preview rises, `F` moves to the new real value, and the fundamentalists drag the market after it. This is the "fundamentals move the model, people move the market" story, with real fundamentals.

### 3.4 Derived views (all pure functions of engine state)

- **Price ticker:** the last sim price, with digits rolling on flaps.
- **Candles:** OHLC in 2.5 s buckets, with volume bars. The latest candle glows; wicks extend live.
- **Order book:** **depth implied by the curve.** Ask levels are `price(s + Δi)` and bid levels `price(s − Δi)`, with sizes from pending agent intents. Labeled "curve depth". A large order visibly consumes levels because it walks the curve.
- **Tape:** sim prints (green buys, red sells) merged with real-layer events (`--sys` news, violet chain rows with a crystalline tick on finality). The two are distinguishable by glyph: `◇` versus `$`.
- **Attention statistics for B10:**
  - net sim demand against the real round target, as a fill rate;
  - unique sim traders, as breadth;
  - the holder HHI, as concentration.
- **Presenter portfolio:** sim units, cost basis and P&L in `◇`, with a sparkline. It is labeled "play-credit P&L". The real receipt balance sits beside it in its own row, non-transferable and never marked to the sim price.

### 3.5 Session script (`lib/sim/script.ts`)

A timeline of cues keyed to beats rather than wall-clock time, so the presenter controls pacing:
- `open` (triggered by the real round reaching `OPEN`, or in `OFF_CHAIN`/`REPLAY`);
- `warmup`;
- `shock` (on the real evidence event);
- `frenzy`;
- `whale`;
- `sell-demo`;
- `last-10s`;
- `close`.

A cue only changes agent intensities and parameters; prices always emerge from orders.

---

## 4. The set pieces

| # | Set piece | Layer | What happens | Source |
|---|---|---|---|---|
| 1 | **Evidence chamber** | Real | Claims stream in and land as status chips with `c` (Verified 1.00, Reviewer-verified 0.85, Public source 0.65, Founder-attested 0.35, AI-assessed 0.35, Missing proof 0.00). Low-confidence cards go translucent and drift toward the neutral 0.50 line. | research runs, B1 |
| 2 | **Valuation reactor** | Real | The center value rolls up on flaps. Five weighted arcs fill (opacity is confidence), and the scenario wedges settle like liquid. A "because …" sentence comes from B2 attribution. A "Why?" drag handle opens the audit drawer (weights, `s/c/adjusted`, scenarios, `alpha`, hashes). A waterfall sums exactly to the headline. | valuation preview, B2 |
| 3 | **Round lock** | Real | The snapshot card compresses into `model_hash` and `evidence_root`, the block drops onto the chain lane, and "ROUND LOCKED · price and supply can't change this round" appears. | `POST /rounds`, `RoundOpened` (C1) |
| 4 | **Opening bell** | Both | The screen dims, then 3 · 2 · 1 in Fraktur. `LUMA` stamps in, then "MARKET OPEN" (sim) above "PRIMARY ROUND OPEN" (real). The model value spins up, the sim price resolves at `p0` (= the real unit price), and a beam drops onto the curve at supply 0. The first real block lands with a violet pulse, then all panels wake (B1 `t-in` timeline). | real round `OPEN` → `sim.open` |
| 5 | **Live ticker** | Sim | `LUMA ◇2.487 +3.63% ▲`: digits roll independently, with flashes, a 108% scale on large moves and a gold ring on a session high. The percentage trails by 150 ms. The real fixed round price sits beside it with a lock glyph: "ROUND PRICE $2.400 · fixed". | engine, `GET /rounds/:id` |
| 6 | **Orders move the curve** | Sim | Each buy launches a glowing packet from the trader's chip to the curve. The curve ripples, the position marker slides up the curve with a ghost of the old price, minted sim units burst toward the buyer, the reserve gauge fills, and the trade prints. A sell runs in reverse: units peel off, stream back, dissolve, ◇ flows back, red flash. | engine |
| 7 | **Market tape** | Both | Entries slide in from the right. Large prints enlarge with a brighter trail. Bursts accelerate the tape and quiet periods let it coast. News rows include: `ROUND OPENED`, `VERIFIED REVENUE SIGNAL`, `MODEL vX SNAPSHOT 3f9a…`, `SOLANA BLOCK FINALIZED`, `NEW SESSION HIGH`, `WHALE CONCENTRATION ↑`. | engine + B12 |
| 8 | **Terminal candles** | Sim with a real overlay | Dense dark candles, one per 2.5 s, growing from the open, with volume underneath. Behind the price sits a translucent **real model-value band**. When the price leaves the band, the chart background warms toward `--heat`. Real evidence events are vertical violet or `--sys` markers. | engine, valuation |
| 9 | **Curve-depth book** | Sim | Rows shift with the price, quantities count, depth bars breathe, and consumed levels collapse into the print. Large intents show as walls. The spread widens and recompresses. | engine |
| 10 | **Whale** | Sim, applause moment | The tape is moving when a ◇25,000 BUY appears. The packet hovers for 0.5 s while the book highlights the levels it will eat, then it crashes through, candles spike, volume explodes and the price rolls up. `NEW SESSION HIGH` prints in gold and the sim market value crosses a round number. Then the what-if panel shows the **real formula's answer**: concentration rose, so the deconcentration term drops and the next-round multiplier barely moves, then hits its ceiling. *"Hype moves the market; the model only gives it a bounded vote."* | engine → B10 |
| 11 | **Model vs market** | Both | `MODEL VALUE $2.64M` (real) and `MARKET-IMPLIED ◇2.91M` (sim), with `ATTENTION PREMIUM +10.2%`. The field between them is cool `--sys` near convergence and warms to `--heat` as the market runs ahead. When real evidence lifts the model, its line catches up and the field relaxes. A third line shows the **bounded what-if**: where the real next-round price would land, with the clamp drawn as a wall. | valuation, engine, B10 |
| 12 | **Evidence shock** | Real → sim | `REVENUE EVIDENCE VERIFIED` arrives and the market freezes for 300 ms. The card flies into the reactor, traction moves (real scores), the wedges redistribute and the model value rolls. Then `F` updates and the sim traders react with a burst of buys. The tape prints `FUNDAMENTAL EVENT · VERIFIED MRR`. The real round price stays locked, with a tiny lock-shake: "applies to the next round (M§10.3)". | research confirm or seeded verification, preview |
| 13 | **Portfolio** | Sim, with real beside it | Play-credit P&L rolls with a green glow in rallies and a redrawn sparkline. The presenter's position marker rides the curve. All visible holder cards ripple together on a sharp move. The real receipt row stays still: "non-transferable · not marked to market". | engine, real balance |
| 14 | **Settlement pulse** | Real | The presenter's **real** $100 commitment walks `SIGNED → SUBMITTED → CONFIRMED → FINALIZED` along a strip of blocks keyed by the real slot. Transactions in the same slot batch into one block. Confirmation gives one pulse; finalization a stronger, market-wide pulse plus the chime. Each brings a permanent tick on its tape row with the abbreviated signature and slot. | C2, B14 |
| 15 | **Constraint proofs** | Real | The founder tries to commit and the server returns `SELF_SUBSCRIPTION_FORBIDDEN`. The real receipt is dragged toward another wallet, stretches, snaps back and shows `NonTransferable` from a real simulation (B6). The line: *"the sim can trade; the real receipt can't."* | B3, B6 |
| 16 | **Closing bell** | Both | In the last 10 s, intensity rises, the tape accelerates and the final candle fights. At 00:00 a deep closing pulse freezes the price and the chart zooms out to the whole session. The **sim board** flaps in: `CLOSE ◇2.917 · SESSION +21.54% · VOLUME ◇84,720 · TRADERS 121`. Beside it, the **real board**: `COMMITTED $… · BACKERS n · TXS FINALIZED n/n · RECEIPTS MINTED`. Closing line: *"A real valuation, locked on-chain, and the market it could attract, in 90 seconds."* | engine, B8 / real round |
| 17 | **Round 2 reveal** (optional encore) | Real | A project whose real Round 1 finalized earlier today shows its waterfall: `+ verified progress`, `+ breadth`, `− concentration`, clamp, `= next round`. | B2 |

---

## 5. Stage choreography (≈115 s)

| Time | Beat |
|---|---|
| 0–12 s | Evidence chamber → reactor builds (real) |
| 12–20 s | Round lock: hashes seal and the block lands (real) |
| 20–28 s | Opening bell; the terminal wakes (both) |
| 28–40 s | Warm-up flow; the first candles draw (sim) |
| 40–52 s | The presenter buys in the sim, then makes a **real** $100 commitment in Phantom; the settlement strip runs to finalized |
| 52–64 s | Evidence shock: the real model rises and the sim market follows |
| 64–76 s | Frenzy, then the whale tears through the depth, prints a session high, and the bounded what-if answers |
| 76–84 s | The presenter sells: two-sided liquidity (sim) |
| 84–92 s | Proofs: founder rejected, receipt won't transfer (real) |
| 92–108 s | Closing bell, then the two boards side by side |
| 108–115 s | Zoom out; closing line |

**Controls:**
- **Presenter route:** `/live/?project=<slug>`.
- **Keys:** → and ← for beats, `B` / `S` for sim buy and sell, `W` for the whale, `Space` to pause, `R` to replay a beat, Esc to skip a ceremony.
- **Modes:** `?replay=1` (real layer from the recorded fixture) and `?offchain=1`.
- **Rehearsal:** `?seed=<n>`.
- **Personas:** a hidden `?demo=1` persona switcher, DEMO_MODE only, with a red banner.

---

## 6. Alignment rules (real layer)

1. **The server owns every real number.** The UI formats micro-USD strings with BigInt (`lib/money.ts`) and tweens between server values; it never computes real prices, fees, units, scores or what-ifs.
2. **Shared contract.** `lib/api/types.ts` mirrors response shapes. The recorded run `docs/fixtures/demo-run.json` is the frontend's `REPLAY` data **and** a backend contract test (`backend/tests/contract/demo-fixture.test.ts`), so shape drift fails on the backend side first.
3. **Real-layer badges:**
   - `LIVE` has no badge.
   - `REPLAY` reads "Replay of a recorded run · time".
   - `OFF_CHAIN` reads "Off-chain simulation · Devnet program not connected".
   - Fabricated real data is never a mode. The sim layer always carries its own stamp.
4. **Backend vocabulary:**
   - stages `IDEA … REPEATABLE_REVENUE`;
   - the six evidence statuses (E§4), with `PUBLIC_WEAK` never shown as "Verified";
   - transaction states per M§11.1, with `Confirmed` never shown as finalized.
5. **Language:**
   - **Real layer:** "commitment", "participation receipt", "units". The atomicity line: *"payment and commitment are atomic; allocation is computed at close and minted exactly once."*
   - **Sim layer:** may say trade, buy, sell, P&L and market value, always next to the stamp and the `◇` glyph.
   - **Nowhere:** "security", "shares", "equity", "stake", or "return on your receipt".

---

## 7. The press system: every button responsive and satisfying (P0)

**Files:** `web/styles/press.css`, plus one delegated listener `components/fx/Press.tsx` mounted in `app/layout.tsx`. No per-button code is needed.

**Covers:**
- `.btn` and `.btn.go`;
- the terminal buy/sell/commit buttons and chips;
- interview options and desk stage buttons;
- `.deck-more`;
- the founder Connect buttons;
- the Protocol controls;
- the presenter keys.

| Moment | Feedback |
|---|---|
| Hover (fine pointers) | An ink fill wipes in from the pointer's side (`clip-path`, 160 ms); the arrow glyph nudges 3px |
| Press (`pointerdown` / Space / Enter) | Within one frame: `translateY(1px) scale(.98)`, a 1px inset rule, and a halftone dot burst from the pointer (`--px`, `--py`, 280 ms) |
| Release | A spring back with 2% overshoot (180 ms); `.go` buttons flash `#7ae387` for 120 ms |
| Pending (real API) | The label flaps to `SENDING`, a marching 1px border runs, the width is locked and there's no reflow |
| Success | A stamp: the label flaps to `COMMITTED` / `LOCKED` / `FILLED` / `COPIED` with a tick, then returns after 1.4 s |
| Error | A 6px shake (2 cycles, 160 ms), a red underline, and the server message in `.err`; focus stays put |
| Disabled | 40% ink, `not-allowed`, and the reason as visible caption text |
| Focus | A 2px green `:focus-visible` ring offset by 3px; the keyboard gets identical press feedback |
| Sim trade buttons | An extra instant **fill confirmation**: the trader's chip pulses and the packet launches on the same frame, so a trade feels immediate even though it settles in the engine on the next tick |
| Sound (muted by default, toggle in the dateline) | A 12 ms type-bar tick on press, a soft cash-register "tk" on sim fills, and a two-note chime only on real `Finalized` |

- **Touch:** feedback on `pointerdown`, with hit targets of at least 44px.
- **Reduced motion:** transforms and bursts are dropped, and the color feedback stays.

**Done when:**
- every listed control responds within one frame (checked with a performance trace);
- there is no layout shift;
- keyboard and touch match mouse.

---

## 8. Implementation steps

Sizes: S is up to 2 h, M is up to 5 h, L is more than 5 h. The AGENTS.md verification loop runs after every step.

### Track F: frontend (`web/`)

| Step | Work | Retains | Done when |
|---|---|---|---|
| **F0** foundation (M) | `lib/api/client.ts` (same-origin, credentials, per-intent `Idempotency-Key` in sessionStorage, error shape); `lib/api/read.ts` (GET-only plus the what-if POST); `lib/api/types.ts`; `lib/money.ts`; `lib/source.ts` + `<SourceBadge>`; `lib/live/events.ts`; the ESLint boundary rule for `lib/sim/**` | — | tsc and lint pass; money round-trips `nessie-purchase-cases.json`; the lint rule rejects a test import |
| **F1** press system (S) | §7 | every existing button | §7 criteria |
| **F2** FX kit (M) | `fx/Flaps.tsx` (extracted from LandingFX `flapGroup`, which then imports it), `Flash`, `Packet`, `Ring`, `Pulse`, `SimStamp`, the tokens | split-flap board, GSAP | the landing board is identical before and after (screenshot diff) |
| **F3** sim engine (L) | `lib/sim/{rng,curve,ledger,agents,script,views,params}.ts` and Vitest specs | — | §9 sim tests pass; a 120-trader session runs at ≤ 1 ms per tick |
| **F4** evidence chamber (M) | `live/EvidenceChamber.tsx`; also mounted in LaunchInterview's "Web" step | LaunchInterview | a real run renders; PARTIAL and FAILED states are designed |
| **F5** valuation reactor (L) | `live/ValuationReactor.tsx`; also on `/round/` and `/desk/` | EstimateDesk layout | every number traces to a response field; the waterfall sums exactly |
| **F6** trading floor (L) | Upgrade `RoundTerminal.tsx` in place, keeping ids and the B1 scroll contract:<br>**left** — tabs for the curve-depth book and the tape;<br>**center** — ticker, canvas candles with the model band and markers, attention strip, model-vs-market field;<br>**right** — tabs for "Trade · simulated" (buy/sell in ◇, curve quote, slippage) and "Commit · real" (server `/quote`, fee/reward/proceeds split bar, pro-rata disclosure), plus the portfolio;<br>**top** — the real settlement strip and slot heartbeat.<br>Canvas for chart and book (capped at 60 fps, DPR ≤ 2); the DOM tape keeps at most 40 rows. | RoundTerminal, landing B1 | fixture mode on the landing page is unchanged; live mode runs a full session at 60 fps on a 2020 MacBook Air |
| **F7** ceremonies (M) | `OpeningBell`, `RoundLock`, `EvidenceShock`, `WhaleCue`, `ClosingBell`: GSAP timelines, skippable, with reduced-motion end frames | Fraktur type, B1 wake-up | each is ≤ 3 s, and real-layer ceremonies fire only on real state changes |
| **F8** proofs and Round 2 (M) | Founder rejection, receipt snap-back on a real B6 error, Round 2 waterfall | — | each proof shows a server-originated error |
| **F9** presenter route and rail (M) | `/live/`, `CapitalRail` with its tested `journey.ts` reducer, keyboard map, persona switcher, sound toggle | PageTurn, SubHeader | reducer tests pass, including `Failed`, `Expired` and `Unknown` |
| **F10** copy alignment (S) | Fixture stages switch to the backend enum and prices to micro-USD strings. Fix "all in one transaction" and "count as zero" / "score zero" (`fixtures.ts`, `EstimateDesk.tsx`). On real panels "Fills" becomes "Commitments". | all copy | grep for those phrases finds nothing in `web/` |

### Track B: backend additions

None of these changes a formula, weight or price. All are deterministic and tested with vitest + pglite. None accepts sim data as a stored input.

| # | Endpoint or change | Feeds | Size |
|---|---|---|---|
| B1 | `GET /api/models/current`: weights, confidence multipliers, demand bounds, hash, status | chips, gauges | S |
| B2 | `valuation/attribution.ts` (`explain-v1`): fixed-order category waterfall (exact sum), confidence cost, demand split in log space. `demandScore` also returns its components, and a test proves the score is unchanged. | reactor, Round 2 | M |
| B3 | `POST /api/rounds/:id/eligibility`: `SELF_SUBSCRIPTION_FORBIDDEN`, `OVER_IDENTITY_CAP`, `ROUND_NOT_OPEN` | founder proof | S |
| B4 | `subscriberCount` on rounds; `GET /api/projects` | real board, `/rounds/` | S |
| B5 | DEMO_MODE `OFF_CHAIN` real round: open, commit and settle in Tiger via the existing `settleRound()`, with `mode` in every response | fallback if the program is late | M |
| B6 | `POST /api/receipts/transfer-check`: simulates a Token-2022 transfer and returns the error and logs; nothing is signed | `NonTransferable` proof | S |
| B7 | `POST /api/valuation/what-if`: subfactor levels → value; never snapshotted | `/desk/` | S |
| B8 | `POST /api/rounds/:id/settle`: on-demand idempotent crank | real close | M (with C) |
| B9 | `round-policy-v0.1-demo`: `duration_minutes ≥ 3` in DEMO_MODE only. **Needs team approval.** | a real round closing on stage | S |
| B10 | `POST /api/valuation/demand-what-if` `{roundId, fillRate, uniqueBuyers, allocationShares[]}` → the real M§4.9 score, components, multiplier, clamped next-round value and unit price, using the round's frozen model and real prior value. The response always carries `whatIf: true`. Public, rate-limited (10/s per IP), input-validated (≤ 500 shares, each in [0,1], summing to 1 ± 1e-9), never stored. | the sim → real bridge | S |
| B11 | `GET /api/rounds/:id/events?after=<cursor>`: real events (chain events, commitments, snapshots, research confirms), read-only | tape news, shocks | M |
| B12 | `GET /api/chain/slot`: cached `getSlot` (≥ 300 ms TTL) | heartbeat, block strip | S |

The v2 "seeded crowd" script is dropped: the sim engine supplies the crowd, and the real layer needs only the presenter's commitment plus optional pre-seeded backers from the recording script.

### Track C: chain (critical path, owner to be decided)

- **C1:** `initialize_protocol`, `create_project` (Token-2022 `NonTransferable` receipt mint), `open_round` and the `RoundOpened` hook (`recordRoundOpened` is already built).
- **C2:** `subscribe` with the relayer co-sign, `subscribe/prepare`, `POST` and `GET /transactions`.
- **C3:** `finalize_round`, `mint_final_allocation` and `refund_excess`, via B8.
- **C4:** the Nessie funding saga (N§6), or a visibly labeled faucet fallback.
- **C5:** a labeled "receipt-standard proof mint" fallback for the transfer proof only.

---

## 9. Tests

- **Sim engine (Vitest, `web/`):**
  - the same seed and input log gives an identical tape hash;
  - reserve equals the curve integral after every trade;
  - play credits are conserved;
  - no negative balances, and every sell can be paid;
  - candle OHLC is consistent (low ≤ open/close ≤ high);
  - the engine never imports outside `lib/sim` / `lib/api/read` (lint);
  - the whale cue under a fixed seed produces the scripted session high;
  - tick cost stays within budget.
- **Backend:**
  - B1–B12 unit tests: the attribution sum is exact, `demandScore` is unchanged, B10 matches `computeValuation`'s demand path for identical inputs and writes nothing, B10 rejects malformed shares, eligibility reasons are correct, the event cursor never repeats or skips;
  - the replay-fixture contract test.
- **Frontend:**
  - tsc, lint and `next build` (static export);
  - `journey.ts` tests;
  - a reactor fixture render test;
  - a landing screenshot diff before and after F2 and F6;
  - a press-latency trace;
  - a 60 fps trace of a full session;
  - a runbook at 1440 px and 390 px with reduced motion on and off.
- **Chain:** `anchor test`, including the transfer failure and the founder-wallet reject.
- **Rehearsal:** the §5 run with `?seed=` fixed, in LIVE, REPLAY and OFF_CHAIN, checking every stamp and badge.

---

## 10. Priorities and cut line

| Priority | Items | What the demo shows |
|---|---|---|
| **P0** | F0, F1, F2, F3, F6 (sim panels), F7 (opening bell, whale, closing bell), F10, replay fixture, B12 | The full trading spectacle on the sim, every button satisfying, the real layer from the replay fixture |
| **P1** | F4, F5, B1, B2, B3, B4, B10, B11, F7 (evidence shock), F9 | Real evidence → real valuation live; real news drives the sim; the bounded what-if at the whale; founder proof |
| **P2** | C1–C3, B5, B6, B8, B9, F8, real commit panel | Real Devnet lock and settlement strip, `NonTransferable` snap-back, real close; `OFF_CHAIN` if the program slips |
| **P3** | C4 Nessie, B7 + `/desk/`, Round 2 encore, sound, bloom tuning | Sponsor depth and polish |

P0 works without any new backend, so the spectacle can never be blocked by chain work. P1 and P2 make progressively more of it real.

---

## 11. Decisions for the team

1. **Demo company:** pick the ticker and fictional profile (the brief uses `LUMA`), and seed its real evidence.
2. **Demo-length rounds (B9),** or a real round seeded to close during the pitch.
3. **The program owner and deadline:** this decides P2 (Devnet) or `OFF_CHAIN`.
4. **Attribution method (B2):** fixed-order sequential (exact sum, order shown) versus Shapley.
5. **Verified revenue for the evidence shock:** build `POST /evidence/:id/verify`, or seed a reviewer-verified claim and say so.
6. **Magnitudes:** `valuation-v0.1` prices an IDEA-stage company near $416k. The sim's `◇` numbers scale from whatever the real model says. A bigger headline is a model-version decision, not a UI one.
