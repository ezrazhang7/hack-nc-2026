# Public information architecture

**Status:** implemented 2026-10-11  
**Scope:** browser routes and ownership of frontend workflows. This document does not change the primary-issuance, valuation, settlement, or legal rules in [MARKET ARCHITECTURE.md](MARKET%20ARCHITECTURE.md).

## Principle

The public application is organized by user intent, not by backend resources:

- an investor explores a permanent company listing and its price at **Invest**;
- a founder creates a listing at **List** and operates it at **Manage**;
- a round remains an internal issuance and settlement record, not a destination in the public navigation.

The simulated market and real primary issuance remain separate. `/invest/` may show play-credit buys, sells, quotes and P&L. `/wallet/` is the only investor workspace that prepares real-layer mock-USDC commitments. `/manage/` is the only founder workspace that prepares project, tokenization and issuance transactions.

## Canonical routes

| Route | Persona | Owns |
|---|---|---|
| `/` | everyone | landing page |
| `/invest/` | investor | company discovery and ticker view |
| `/invest/?ticker=MOTH` | investor | one company's simulated market, profile, evidence, valuation explanation and primary-issuance CTA |
| `/portfolio/` | investor | browser-local play-credit positions and activity |
| `/wallet/` | investor | identity, Phantom proof, mock funding, primary commitments and real receipts |
| `/list/` | founder | company intake, evidence research, valuation preview and publication |
| `/manage/` | founder | the founder's listings, receipt setup and issuance controls |
| `/desk/` | everyone | valuation sandbox |
| `/how/` | everyone | product explanation |
| `/news/` | everyone | editorial content |

### Why the company uses a query parameter

The frontend is a Next.js static export. Companies can be created after a deployment, so their tickers are not available to `generateStaticParams()` at build time. Export mode also does not support runtime rewrites or redirects. The canonical deployable company URL is therefore `/invest/?ticker=MOTH`.

`/invest/MOTH/` is deferred until the hosting layer provides an SPA fallback/rewrite or the frontend gains a request-time server. Tickers must remain unique and stable after publication before that path becomes canonical.

## Data and action boundaries

```text
/list ───────────────→ projects + research + valuation APIs
                          │
                          ▼
/manage ─────────────→ project / receipt / round preparation
                          │ signed wallet transaction
                          ▼
                    Solana real layer

/invest ──read only──→ published projects + valuation anchors
   │
   └── play-credit orders ──→ browser-local portfolio only

/wallet ─────────────→ Nessie mock funding + real primary commitment
```

- A simulated order never calls a mutating API and never changes a valuation, round, mock-USDC balance or receipt.
- A real commitment continues to use the backend's round ID, frozen price, eligibility checks, idempotency key and signed transaction.
- Founder controls require the existing authenticated identity and resource authorization. Moving them to `/manage/` does not relax a server check.
- No database, chain, valuation formula or money representation changes as part of this IA migration.

## Compatibility routes

Previously shared URLs remain as static client redirects:

| Old route | Destination |
|---|---|
| `/launch/` | `/list/` |
| `/rounds/` | `/invest/` |
| `/project/?slug=x` | `/invest/?slug=x`, then canonicalized to its ticker |
| `/round/?slug=x` | `/invest/?slug=x`, then canonicalized to its ticker |
| `/participate/?round=id` | `/wallet/?round=id` |
| `/participate/?project=id` | `/manage/?project=id` |

The aliases are compatibility shells only and are not linked from live navigation.

## Failure states

- An unknown ticker leaves the market index visible rather than guessing a company.
- A legacy slug is resolved only against the published-project response; an unknown slug is not rewritten to another company.
- If JavaScript is unavailable on an old route, a visible fallback link remains.
- Backend, wallet, Nessie and Solana errors continue to render in the workspace that initiated the action.

## Verification and rollback

Acceptance criteria:

1. No live UI link targets `/launch`, `/rounds`, `/round`, `/project` or `/participate`.
2. Company profile and valuation evidence render inside the ticker view.
3. Investor funding/commitment controls render only at `/wallet/`; founder controls render only at `/manage/`.
4. Old query-string URLs land in the equivalent canonical workspace.
5. Frontend lint and static export pass.

Rollback is frontend-only: restore the prior route pages and links. There is no data migration to reverse and no finalized provider or chain operation is changed by the route migration.
