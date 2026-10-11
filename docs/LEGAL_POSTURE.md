# Legal Posture

How Prospecto stays a simulation today, which words the product may use, and what a real-money version would require. It extends [MARKET ARCHITECTURE.md §13](<MARKET ARCHITECTURE.md#13-legal-and-product-boundary>), which remains authoritative where the two differ.

> Not legal advice. Written by the team from public SEC guidance (U.S. law assumed). Securities counsel must review the issuer, instrument, platform role and fees before any real money moves.

---

## 1. Where the demo stands

Prospecto at HackNC 2026 is a **simulation**:

| Property | Demo state | Why it matters |
| --- | --- | --- |
| Money | Faucet-issued mock USDC on Solana Devnet; Nessie mock balances | No investment of money, so no sale of a security |
| Instrument | Non-transferable Token-2022 participation receipts | No resale, no secondary market, no synthetic exposure |
| Rights | None: no ownership, cash value, redemption, dividends or conversion | Nothing for a buyer to profit from |
| Companies | Fictional fixtures in the public demo | No real issuer is marketing a real offering |
| Valuation | Transparent heuristic with invented stage anchors, labeled as such | Not an appraisal, not investment advice |
| Market simulator | Off-chain, seeded trading session in play credits, labeled "Simulated session"; it never touches receipts or mock USDC | Shows what attention could do without a real secondary market; P&L is play-credit only and never described as a return on the receipt |

The grey edges are **language** (copy that sounds like a real offering) and **real startups** embedding an “Invest in us” link and a published valuation on their live sites. §3 and §4 cover both.

---

## 2. What the law actually says (short version)

### 2.1 Accreditation depends on the offering route

Investors don't need to be accredited to buy stock that already trades on Nasdaq or NYSE. A private startup listed on a website is still a **private offering**, and who may buy depends on the exemption it uses:

| Route | Non-accredited buyers? | Key conditions |
| --- | --- | --- |
| Regulation Crowdfunding (Reg CF) | Yes, within annual investment limits | ≤ $5M per 12 months; must run through one SEC-registered broker-dealer or funding portal; Form C disclosures; resale restricted for 1 year |
| Regulation A, Tier 2 | Yes, generally within limits | ≤ $75M per 12 months; SEC qualification; audited financials; ongoing reporting |
| Rule 506(b) | Up to 35 sophisticated non-accredited buyers | **No general solicitation**; extra disclosure to non-accredited buyers |
| Rule 506(c) | No | General solicitation allowed; every buyer must be accredited and verified |

### 2.2 Publishing a valuation is the real issue, not a myth

You may have heard that publishing a startup's valuation makes its shares unsellable. That isn't true, but it points to a real rule. SEC staff treat valuation opinions as outside “ordinary factual business information.” A public page saying “Startup A is worth $8M, invest in its round” can therefore be **general solicitation** for that startup's offering, even without a buy button. Consequences:

- It can **disqualify Rule 506(b)** for that startup's real raise, even if every buyer is accredited.
- Under **Reg CF**, advertising off the intermediary's platform is limited to a short notice (Rule 204 “tombstone”) that directs people to the platform.
- Under **Rule 506(c)**, it is allowed, but only verified accredited investors may buy.

### 2.3 Tokenization is not a loophole

A token representing startup equity is still a security. The token, its sale and its transfer need registration or an exemption. Calling it a token, making it non-transferable or labeling it “educational” doesn't change the economic substance. Synthetic tokens that track a startup's value can also fall under security-based swap rules, which effectively bar retail buyers.

### 2.4 Two traps a real-money Prospecto would hit

1. **Funding portals may not give investment advice or recommendations.** A platform-computed “model-implied valuation” shown next to a buy action can read as a recommendation. This collides directly with Prospecto's core feature.
2. **Matching buyers to issuers for a fee** requires registration as a broker-dealer or funding portal. Partnering with one is the realistic path; becoming one is not a hackathon-scale task.

---

## 3. Language guide (applies to UI, pitch and docs)

The demo copy still uses some offering-style words (the homepage says “Invest in us”). These are **planned** changes, to land before any real company lists.

| Moving away from | Moving to |
| --- | --- |
| invest, investor, investment | back, backer, join the round, participate |
| shares, stock, equity, stake | participation receipts, units |
| valuation (next to a buy action) | model estimate, demo estimate |
| returns, upside, profit | (say nothing about financial outcome) |
| buy shares | reserve units, back the round |
| “Invest in us” link | “Back us” link, or the existing label plus a visible *Simulation* stamp |

Planned rules:

- Every screen with a buy or confirm action will show a **Simulation, no real money** stamp in the action area, not only in the footer.
- The tagline “invest in your friend's startup” is pitch language. Wherever it appears, “demo” sits next to it.
- Never imply that receipts will become equity, that Prospecto is a registered portal, or that a Nessie profile is KYC.

---

## 4. Public-company demo profiles

1. The demo uses public facts about real companies as **unaffiliated examples**. Those companies and founders did not create, approve or publish these profiles through Prospecto.
2. Every price, balance, commitment and market move is simulated. The profiles are not live offerings, and no company receives money or creates rights through the demo.
3. Before a real startup controls its own listing, the experience must remain clearly labeled as a simulation (“Back us · demo”) or wait for a regulated route. A founder-published estimate next to an invest link could count as solicitation for that startup's *future real* raise.
4. If a judge asks “isn't this illegal?”, the answer is: *“It's an unaffiliated product simulation using public company facts. No money moves, no issuer is raising here, and no participant receives ownership or financial rights.”*

---

## 5. Path to a real version (roadmap, not current behavior)

| Step | Decision | Notes |
| --- | --- | --- |
| 1 | **Issuer** | Only incorporated startups with standard instruments (e.g. a crowdfunding SAFE or common stock) may raise |
| 2 | **Route** | Reg CF first, via an existing registered funding portal or broker-dealer. Prospecto is the software and analytics layer, not the intermediary |
| 3 | **Valuation framing** | The **founder** sets and owns the price. Prospecto's model is a disclosed tool the founder used, with formula, inputs and version shown. No platform “buy” recommendation |
| 4 | **Off-platform communication** | “Back us” links and anything outside the portal follow Reg CF advertising limits (tombstone-style notices pointing to the portal) |
| 5 | **Investor limits & identity** | Enforced by the intermediary (annual limits, KYC/AML). Nessie stays a demo tool and is never presented as identity verification |
| 6 | **Funds & custody** | Held by the intermediary's escrow or qualified third party; funding portals may not hold investor funds |
| 7 | **Tokenization's role** | Optional ownership record and transfer-lock tool for *legally issued* securities, keeping the 1-year resale restriction. Never a route around registration |
| 8 | **Still out of scope** | Secondary trading, order books, AMMs, leverage, synthetic exposure to private companies (AGENTS.md) |
| 9 | **Gate** | Securities counsel signs off on issuer, instrument, platform role, fees and all public copy before mainnet or real money |

Alternative non-securities routes (see MARKET §13.2): rewards or patronage with no financial return, donations, or analytics-and-simulation software only.

---

## 6. Open items

- Verify any 2026 SEC developments (e.g. tokenization or “innovation exemption” relief) against primary sources before citing them. As of this writing, nothing reviewed here creates a retail exemption for private startup fundraising.
- Apply the §3 language guide to the landing, rounds and launch copy as a separate `ui(copy)` change.

## Sources

- SEC, [Regulation Crowdfunding](https://www.sec.gov/resources-small-businesses/exempt-offerings/regulation-crowdfunding) and [Reg CF C&DIs](https://www.sec.gov/files/divisions/corpfin/guidance/reg-crowdfunding-interps.htm)
- SEC, [Regulation A](https://www.sec.gov/resources-small-businesses/exempt-offerings/regulation)
- SEC, [Rule 506(b)](https://www.sec.gov/resources-small-businesses/exempt-offerings/private-placements-rule-506b) and [Rule 506(c)](https://www.sec.gov/resources-small-businesses/exempt-offerings/general-solicitation-rule-506c)
- SEC, [Securities Act Rules C&DIs, general solicitation (Questions 256.23–256.25)](https://www.sec.gov/rules-regulations/staff-guidance/compliance-disclosure-interpretations/securities-act-rules)
- SEC, [JOBS Act FAQs About Crowdfunding Intermediaries](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/jumpstart-our-business)
