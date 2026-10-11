// Fictional companies for the landing page's illustrated story, and the news desk. Live pages
// (/rounds, /round, /project) read the API instead (lib/api.ts).
import type { Stage } from "@/lib/api";

export type { Stage };

/** A founder as shown on the founder cards. `li` is a founder-entered LinkedIn profile URL (fixtures have none). */
export type Founder = { n: string; r: string; s?: string; asks?: string[]; li?: string };

/** What the round terminal and feed cards render, built from a fixture or from API data (lib/api.ts toRound). */
export type Round = {
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
  { t: "MOTH", n: "Mothlight", s: "IDEA", e: "Unincorporated", city: "Chapel Hill", p: 0.1, sub: 38, d: 9, h: "Mothlight wants to find you a quiet room at 2 a.m.", dek: "Two sophomores, a napkin sketch and a waitlist of 40. No code yet.", b: 132 },
  { t: "FERN", n: "Fernhill Robotics", s: "EARLY_REVENUE", e: "Incorporated", city: "Raleigh", p: 2.36, sub: 61, d: 12, h: "The $900 robot weeding 31 small farms", dek: "Started as an NC State senior design project.", b: 214 },
  { t: "QUIL", n: "Quillnote", s: "LAUNCHED", e: "Incorporated", city: "Durham", p: 1.13, sub: 91, d: 2, h: "Quillnote’s notes app reaches four campuses", dek: "1,200 weekly users. Closing Friday.", b: 317 },
  { t: "TIDE", n: "Tidewater Sensors", s: "PROTOTYPE", e: "Unincorporated", city: "Pittsboro", p: 0.56, sub: 54, d: 15, h: "Soil sensors, tested on three farms", dek: "A working prototype and an honest label.", b: 188 },
  { t: "DORM", n: "Dormfold", s: "IDEA", e: "Unincorporated", city: "Chapel Hill", p: 0.09, sub: 12, d: 20, h: "Your laundry, folded by Tuesday", dek: "Just opened. Looking for its first 50 backers.", b: 42 },
  { t: "BRKT", n: "Bracket Bio", s: "PROTOTYPE", e: "Incorporated", city: "Durham", p: 0.47, sub: 27, d: 18, h: "A $40 test strip for lab benches", dek: "Two grad students, one bench prototype.", b: 94 },
  { t: "ORCH", n: "Orchard OS", s: "LAUNCHED", e: "Incorporated", city: "Greensboro", p: 0.97, sub: 66, d: 7, h: "Scheduling software for small orchards", dek: "Live with nine growers this season.", b: 230 },
  { t: "KILN", n: "Kiln Labs", s: "REPEATABLE_REVENUE", e: "Incorporated", city: "Charlotte", p: 5.25, sub: 100, d: 0, h: "Kiln Labs’ round is full", dek: "Follow for the next one.", b: 348 },
];

// Fictional founders for the fixture companies. Their Connect buttons open LinkedIn's home page, not a person.
const FOUNDERS: Record<string, Founder[]> = {
  MOTH: [
    { n: "Jonah Mercer", r: "Co-founder · product", s: "UNC Chapel Hill · Computer Science ’28", asks: ["Dorm RAs who’ll pilot a room finder", "A designer for the first app screens"] },
    { n: "Tess Okafor", r: "Co-founder · research", s: "UNC Chapel Hill · Information Science ’28", asks: ["Students who study after midnight, for interviews", "Facilities staff who know which rooms sit empty"] },
  ],
  FERN: [
    { n: "Priya Raman", r: "Chief executive", s: "NC State · Mechanical Engineering ’26", asks: ["Two vegetable farms for a spring pilot", "Intros to NC ag-equipment dealers"] },
    { n: "Marcus Odom", r: "Hardware & firmware", s: "NC State · Electrical Engineering ’25", asks: ["A battery supplier who sells small batches", "Embedded engineers for a summer sprint"] },
    { n: "Lena Hartwell", r: "Field operations", s: "Grew up on a sweet-potato farm in Johnston County", asks: ["Grant writers who know USDA SBIR", "Farmers willing to be brutally honest"] },
  ],
  QUIL: [
    { n: "Dev Kapoor", r: "Chief executive", s: "Duke · Computer Science ’26", asks: ["Campus ambassadors at App State and UNC Charlotte", "A mentor who has sold to universities"] },
    { n: "Hana Liu", r: "Design & growth", s: "Duke · Visual Media Studies ’26", asks: ["Professors willing to share lecture notes", "Student-org leaders for a semester trial"] },
  ],
  TIDE: [
    { n: "Samuel Brooks", r: "Founder", s: "NC State · Biological & Agricultural Engineering ’27", asks: ["Farms willing to host a sensor for a season", "Someone who knows LoRa radios"] },
    { n: "Ivy Chen", r: "Hardware", s: "NC State · Electrical Engineering ’27", asks: ["An enclosure that survives a tractor", "PCB assembly in small runs"] },
  ],
  DORM: [
    { n: "Malik Grant", r: "Founder", s: "UNC Chapel Hill · Business ’27", asks: ["Dorms with a spare laundry room", "Your first fifty laundry bags"] },
  ],
  BRKT: [
    { n: "Nadia Petrova", r: "Co-founder · biology", s: "Duke · PhD candidate, Biomedical Engineering", asks: ["Lab managers to test a bench prototype", "Advice on research-use-only labeling"] },
    { n: "Owen Fisher", r: "Co-founder · chemistry", s: "Duke · PhD candidate, Chemistry", asks: ["Reagent suppliers with small minimums", "A first wet-lab customer"] },
  ],
  ORCH: [
    { n: "Rosa Delgado", r: "Chief executive", s: "UNC Greensboro · Computer Science ’25", asks: ["Blue Ridge orchards for next season", "Intros to NC apple-grower groups"] },
    { n: "Ben Whitaker", r: "Field lead", s: "Grew up on an apple orchard in Henderson County", asks: ["Growers tired of spreadsheets", "People who schedule seasonal crews"] },
  ],
  KILN: [
    { n: "Grace Adeyemi", r: "Chief executive", s: "Davidson College · Economics ’24", asks: ["Operators who have scaled past fifty people", "Charlotte-area hiring partners"] },
    { n: "Theo Lambert", r: "Chief technology officer", s: "UNC Charlotte · Computer Engineering ’24", asks: ["Senior engineers who want an early seat"] },
  ],
};
ROUNDS.forEach((r) => { r.f = FOUNDERS[r.t]; });

export type Post = { sec: "Explainer" | "Round report" | "Guide" | "Dispatch"; h: string; dek: string; date: string; min: number; body: string; co: [label: string, href: string] };

export const POSTS: Post[] = [
  { sec: "Explainer", h: "What you actually own when you back an idea", dek: "Participation receipts, mock USDC, and what they don’t give you.", date: "Oct 10, 2026", min: 6, body: "Committing $100 to Mothlight moves $100 of mock USDC into its round. Receipt units are minted once, when the round closes. A receipt records that you backed them early. It carries no ownership, cash value or dividends, and it can’t be transferred.", co: ["Mothlight", "/project/?slug=mothlight"] },
  { sec: "Round report", h: "Fernhill Robotics passes 60% with 12 days to go", dek: "214 backers, $144,904 in demo credits, and the price hasn’t moved a cent.", date: "Oct 9, 2026", min: 3, body: "The weeding-robot company opened at a fixed, model-set price. 61% of the round is committed. The price stays fixed until the round closes.", co: ["Fernhill", "/round/?slug=fernhill-robotics"] },
  { sec: "Guide", h: "How to price a company that’s still a napkin sketch", dek: "Walking through valuation-v0.1, one factor at a time.", date: "Oct 7, 2026", min: 9, body: "Five factors, weighted by stage, tilt the odds of four outcomes. Missing evidence starts at a neutral 0.50, never at zero.", co: ["the Estimate Desk", "/desk/"] },
  { sec: "Dispatch", h: "“We interviewed 40 students. Here’s what they said.”", dek: "Mothlight’s first founder update since opening its round.", date: "Oct 6, 2026", min: 4, body: "Thirty-one of forty said they’d leave the library before 2 a.m. if they could find an empty room. Next: a waitlist test at two dorms.", co: ["Mothlight", "/project/?slug=mothlight"] },
  { sec: "Round report", h: "Kiln Labs’ round fills in nine days", dek: "The first Growth-stage round on Prospecto is fully committed.", date: "Oct 6, 2026", min: 2, body: "Every unit on offer is committed. Existing holdings stay exactly as they are; the round simply stops accepting purchases.", co: ["Back a startup", "/rounds/"] },
  { sec: "Explainer", h: "Why a fixed price is a feature, not a bug", dek: "No order book, no resale: what primary issuance means for backers.", date: "Oct 4, 2026", min: 5, body: "Every unit comes straight from the startup at the price the founder published. Nobody can bid it up or sell it to you second-hand.", co: ["Back a startup", "/rounds/"] },
];
