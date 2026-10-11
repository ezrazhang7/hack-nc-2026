# Demo company catalog

**Status:** implemented 2026-10-11  
**Purpose:** source list and intake notes for the public companies seeded by `backend/scripts/demo-seed.ts`.

Gemini researches these sources, but does not set a score or price. The deterministic valuation model owns scoring and valuation. YC membership, investor names, schools and employer prestige are deliberately not model inputs.

| Ticker | Company | Declared stage | Primary sources | Public facts used by the seed |
|---|---|---|---|---|
| `QPY` | Quippy | Launched | [YC](https://www.ycombinator.com/companies/quippy) · [company](https://quippyapp.com) · [Jonathan Li](https://www.linkedin.com/in/12lijonathan) | iOS/Android availability; adaptive daily conversation practice; Jonathan Li's prior shipped products (Duolingo). His Luvu ARR and Duolingo DAU figures are employment outcomes, so they appear only as narrative context and are not scored as prior-venture traction (verifier rule `EMPLOYMENT_NOT_VENTURE`) |
| `HEART` | Heart Aerospace | Prototype | [YC](https://www.ycombinator.com/companies/heart-aerospace) · [company](https://www.heartaerospace.com) · [funding/product release](https://www.heartaerospace.com/newsroom/heart-aerospace-raises-107-million-in-series-b-funding) · [Anders Forslund](https://www.linkedin.com/in/anders-forslund) | full-scale aircraft development and public prototype evidence; team coverage. Funding is context only and is not converted into traction or revenue |
| `ELMT` | Elimentary | Launched | [YC](https://www.ycombinator.com/companies/elimentary) · [company](https://www.elimentary.com) · [Yogesh Gorjilla](https://www.linkedin.com/in/yogeshgorjilla) · [Manoj Sarda](https://www.linkedin.com/in/manojsarda) | live private-capital operations product; prior shipped credit products and their publicly stated user scale; three-founder functional coverage |
| `SNTR` | Sinter | Prototype | [YC](https://www.ycombinator.com/companies/sinter-systems) · [company](https://www.sinter.systems) · [Justin Kwon](https://www.linkedin.com/in/jkwonn) | live quoting/dashboard and in-house prototype workflow; production tooling is explicitly described as coming soon, so the seed does not claim launch-stage production |
| `PAPY` | Papaya | Launched | [YC](https://www.ycombinator.com/companies/papaya) · [company](https://papaya.fyi) · [Macy Mody](https://www.linkedin.com/in/macy-berg) · [Niyaz Puzhikkunnath](https://www.linkedin.com/in/niyazpk) · [Faiz Vadakkumpadath](https://www.linkedin.com/in/vpfaiz) | production-trace product; 200+ analyses; founders' publicly stated prior product outcomes. Traffic counters are not mislabeled as users or revenue |
| `VYRA` | Vyra | Launched | [YC](https://www.ycombinator.com/companies/vyra) · [company](https://www.usevyra.com) · [Caleb Pong](https://www.linkedin.com/in/cjpong) · [Sulan Zhang](https://www.linkedin.com/in/sulan-zhang) | live web/iOS editor, public pricing and 76,438-creator claim; founder's public 60K+ creator audience is kept as prior-venture context |
| `MEMO` | Memorable | Launched | [YC](https://www.ycombinator.com/companies/memorable) · [company](https://www.memorable.sh) · [Nikhil Krishnaswamy](https://www.linkedin.com/in/nikhil-krishnaswamy) · [QM integration](https://github.com/yc-software/qm) · [Gbrain integration](https://github.com/garrytan/gbrain) | live CLI/integrations and prior shipped work; benchmark percentages remain descriptive because the current metric catalog has no safe field for latency/tool-call reduction |
| `LINK` | LinkLane | Launched | [YC](https://www.ycombinator.com/companies/linklane) · [company](https://linklane.ai) · [company profile](https://www.linkedin.com/company/linklane-logistics) | live quote/book/track workflow, public market-size statement and two-founder functional coverage |
| `TRSY` | Treasury | Launched | [company](https://treasury.sh) · [about](https://treasury.sh/about) · [App Store](https://apps.apple.com/us/app/treasury-ai-money-manager/id6756083347) · [Show HN](https://news.ycombinator.com/item?id=46425301) · [Junead Khan](https://www.linkedin.com/in/junead-khan/) | live iOS app (v1.0 on 2025-12-16, 17 releases) and web app with a paid membership; single founder. No user or revenue figures are public, so none are seeded. Gemini research is cached with `scripts/research-seed.ts treasury` (left unconfirmed) |

## Quippy presenter preset

`/list/demo/` loads a filled intake and redirects to `/invest/?ticker=QPY` after the final answer. It is intentionally non-mutating: Quippy is already seeded, so the presenter shortcut cannot create a duplicate project or collide on the `QPY` ticker.

The preset supplies:

- name: Quippy
- one-line pitch: “Daily, adaptive practice for the conversations that matter most.”
- stage: Launched
- entity: Incorporated; legal name `Quippy App, Inc.`; formation state left unknown
- website: `https://quippyapp.com`
- founder: Jonathan Li, Founder/CEO
- evidence narrative and the three Quippy links above

No email field is part of the intake. New projects keep the account email private unless a future explicit opt-in is added.

## On-chain issuances (Devnet)

Approved 2026-10-11 as a one-time demo operation: `QPY`, `TRSY` and `HEART` are on Solana Devnet via `backend/scripts/open-seed-rounds.ts`, so the wallet's **Commit** flow works for them. The other seeded companies stay off-chain (their Commit stays disabled).

- **Founder custody is a demo shortcut.** Seeded founders never signed in, so each company's founder signature comes from an operator-held Devnet key in `chain/.keys/seed-founder-<slug>.json` (gitignored, mode 600). Keep these files: founder-only actions such as settlement need them. Production replaces this with the real founder's wallet.
- **Round windows were refreshed once.** Opening on chain needs a DRAFT round that closes in the future, so each of the three rounds (no subscriptions) went back to DRAFT and got a new 14-day window before opening. Price, units, caps, fees and the valuation snapshot did not change; the projector re-checked every term against the chain.
- **Demand shown on rounds is simulated per browser session** (`web/lib/demand.ts`, replay with `?demand=<seed>`); stored totals hold only real commitments.
