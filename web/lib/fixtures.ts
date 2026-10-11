// Source-backed demo companies for the landing page's illustrated story and news desk. Live pages
// read the API instead (lib/api.ts); source notes live in docs/DEMO_COMPANY_CATALOG.md.
import type { Stage } from "@/lib/api";

export type { Stage };

/** A founder as shown on the founder cards. `li` is a founder-entered LinkedIn profile URL (fixtures have none). */
export type Founder = { n: string; r: string; s?: string; asks?: string[]; li?: string };

/** What the round terminal and feed cards render, built from a fixture or from API data (lib/api.ts toRound). */
export type Round = {
  roundId?: string;
  t: string; n: string; s: Stage; e: "Unincorporated" | "Incorporated"; city?: string;
  /** Display price only. Real amounts arrive as integer micro-USD strings from the API. */
  p: number; sub: number; d: number; h: string; dek: string;
  /** Backers so far. */
  b: number;
  f?: Founder[];
  /** API rounds only: project slug, units on offer, protocol fee, per-person cap in USD (display). */
  slug?: string; cap?: number; feeBps?: number; maxPer?: number;
  /** API rounds only: exact amounts as integer micro-USD strings and the close time. */
  pMicro?: string; committedMicro?: string; targetMicro?: string; closesAt?: string;
};

export const ROUNDS: Round[] = [
  { t: "QPY", n: "Quippy", s: "LAUNCHED", e: "Incorporated", city: "San Francisco", p: 0.652658, sub: 72, d: 10, h: "Daily practice for the conversations that matter most", dek: "Adaptive voice and text practice with line-by-line feedback.", b: 238 },
  { t: "HEART", n: "Heart Aerospace", s: "PROTOTYPE", e: "Incorporated", city: "Los Angeles", p: 0.519676, sub: 96, d: 3, h: "Electrifying regional air travel", dek: "Hybrid-electric aircraft development backed by public prototype evidence.", b: 441 },
  { t: "ELMT", n: "Elimentary", s: "LAUNCHED", e: "Incorporated", city: "New York City", p: 0.670384, sub: 81, d: 8, h: "AI agents for private-capital operations", dek: "Loan tapes, covenants and waterfalls turned into decision-ready data.", b: 196 },
  { t: "SNTR", n: "Sinter", s: "PROTOTYPE", e: "Incorporated", city: "El Segundo", p: 0.559998, sub: 63, d: 9, h: "A faster plastics pipeline", dek: "Online quoting and an in-house path from prototype to production.", b: 154 },
  { t: "PAPY", n: "Papaya", s: "LAUNCHED", e: "Incorporated", city: "San Francisco", p: 0.670384, sub: 88, d: 6, h: "Continuous optimization for AI agents", dek: "Production traces become ranked quality, latency and cost fixes.", b: 287 },
  { t: "VYRA", n: "Vyra", s: "LAUNCHED", e: "Incorporated", city: "San Francisco", p: 0.692735, sub: 93, d: 4, h: "Autonomous video editing for non-editors", dek: "Upload footage, describe the edit and export a finished draft.", b: 364 },
  { t: "MEMO", n: "Memorable", s: "LAUNCHED", e: "Incorporated", city: "San Francisco", p: 0.658113, sub: 69, d: 11, h: "Procedural memory for AI agents", dek: "Successful traces become reusable graph-based workflows.", b: 173 },
  { t: "LINK", n: "LinkLane", s: "LAUNCHED", e: "Incorporated", city: "San Francisco", p: 0.702763, sub: 76, d: 7, h: "AI-powered freight brokerage in seconds", dek: "Quote, book and track loads through one automated workflow.", b: 219 },
];

// Public founder names and profile links from the catalog sources.
const FOUNDERS: Record<string, Founder[]> = {
  QPY: [{ n: "Jonathan Li", r: "Founder/CEO", s: "Product leader behind Quippy", li: "https://www.linkedin.com/in/12lijonathan" }],
  HEART: [{ n: "Anders Forslund", r: "Founder/CEO", s: "Aerospace designer", li: "https://www.linkedin.com/in/anders-forslund" }],
  ELMT: [{ n: "Yogesh Gorjilla", r: "Founder/CEO", li: "https://www.linkedin.com/in/yogeshgorjilla" }, { n: "Mannat Saini", r: "Founder/CTO" }, { n: "Manoj Sarda", r: "Founder/COO", li: "https://www.linkedin.com/in/manojsarda" }],
  SNTR: [{ n: "Oliver Johnson", r: "Founder/CEO" }, { n: "Justin Kwon", r: "Founder/COO", li: "https://www.linkedin.com/in/jkwonn" }],
  PAPY: [{ n: "Macy Mody", r: "Founder/CEO", li: "https://www.linkedin.com/in/macy-berg" }, { n: "Niyaz Puzhikkunnath", r: "Founder/CPO", li: "https://www.linkedin.com/in/niyazpk" }, { n: "Faiz Vadakkumpadath", r: "Founder", li: "https://www.linkedin.com/in/vpfaiz" }],
  VYRA: [{ n: "Caleb Pong", r: "Founder", li: "https://www.linkedin.com/in/cjpong" }, { n: "Sulan Zhang", r: "Founder", li: "https://www.linkedin.com/in/sulan-zhang" }],
  MEMO: [{ n: "Nikhil Krishnaswamy", r: "Founder/CEO", li: "https://www.linkedin.com/in/nikhil-krishnaswamy" }, { n: "Advaiyt Sane", r: "Founder/CTO" }],
  LINK: [{ n: "Christopher Ruaño", r: "Founder/CEO" }, { n: "Patryk Wekwejt", r: "Founder/COO" }],
};
ROUNDS.forEach((r) => { r.f = FOUNDERS[r.t]; });

export type Post = { sec: "Explainer" | "Round report" | "Guide" | "Dispatch"; h: string; dek: string; date: string; min: number; body: string; co: [label: string, href: string] };

export const POSTS: Post[] = [
  { sec: "Explainer", h: "What you actually own when you back an idea", dek: "Participation receipts, mock USDC, and what they don’t give you.", date: "Oct 10, 2026", min: 6, body: "A primary commitment moves mock USDC into an issuance. Receipt units are minted once at settlement. They record participation but carry no ownership, cash value or dividends, and cannot be transferred.", co: ["Quippy", "/invest/?ticker=QPY"] },
  { sec: "Round report", h: "Heart Aerospace passes 95%", dek: "The fixed model price stays separate from the simulated market.", date: "Oct 9, 2026", min: 3, body: "Heart’s public prototype evidence supports its stage. Its published primary price remains fixed while simulated play-credit activity moves independently.", co: ["Heart Aerospace", "/invest/?ticker=HEART"] },
  { sec: "Guide", h: "How to price a company that’s still a napkin sketch", dek: "Walking through valuation-v0.1, one factor at a time.", date: "Oct 7, 2026", min: 9, body: "Five factors, weighted by stage, tilt the odds of four outcomes. Missing evidence starts at a neutral 0.50, never at zero.", co: ["the Estimate Desk", "/desk/"] },
  { sec: "Dispatch", h: "Quippy turns awkward conversations into daily practice", dek: "A source-backed walkthrough of the QPY demo listing.", date: "Oct 6, 2026", min: 4, body: "The product is live on iOS and Android, with adaptive practice by voice or text and line-by-line feedback. The public evidence is visible beside the model price.", co: ["Quippy", "/invest/?ticker=QPY"] },
  { sec: "Round report", h: "Vyra reaches 76,438 creators", dek: "Public usage evidence moves the score; YC membership does not.", date: "Oct 6, 2026", min: 2, body: "Vyra’s website publishes a creator count and a live product with public pricing. Those facts fit the model vocabulary; investor prestige does not.", co: ["Vyra", "/invest/?ticker=VYRA"] },
  { sec: "Explainer", h: "Why a fixed price is a feature, not a bug", dek: "No order book, no resale: what primary issuance means for backers.", date: "Oct 4, 2026", min: 5, body: "Every unit comes straight from the startup at the price the founder published. Nobody can bid it up or sell it to you second-hand.", co: ["Explore companies", "/invest/"] },
];
