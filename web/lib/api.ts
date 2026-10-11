// Same-origin client for the Hono API (docs/BACKEND_STACK.md §7). Vercel and `next dev` both
// route /api/* to the backend, so there is no base URL and no CORS. Money arrives as integer
// micro-USD strings; it is converted to a number only for display.
import type { Round } from "@/lib/fixtures";

export const STAGES = ["IDEA", "PROTOTYPE", "LAUNCHED", "EARLY_REVENUE", "REPEATABLE_REVENUE"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  IDEA: "Idea", PROTOTYPE: "Prototype", LAUNCHED: "Launched", EARLY_REVENUE: "Revenue", REPEATABLE_REVENUE: "Growth",
};

export type Founder = { display_name: string; role_title: string | null; role: string };

export type RoundSummary = {
  id: string; round_number: number; status: string; opens_at: string; closes_at: string;
  unit_price_micro_usd: string; max_units: string; target_amount_micro_usd: string;
  max_subscription_micro_usd: string; protocol_fee_bps: number; total_committed_micro_usd: string; backers: number;
};

export type ProjectCard = {
  slug: string; name: string; tagline: string; description: string; stage: Stage;
  entity_type: "UNINCORPORATED" | "INCORPORATED"; founders: Founder[];
  valuation: { effective_stage: Stage; unit_price_micro_usd: string; model_version_id: string; calculated_at: string } | null;
  round: RoundSummary | null;
};

export type Subfactor = { subfactor: string; s: number | null; c: number; adjusted: number; status: string | null };
export type Category = { score: number; weight: number; contribution: number };
export type Scenario = { scenario: string; baseline_probability: number; probability: number; terminal_enterprise_value: number; present_value: number };

export type Explanation = {
  model_status: "DRAFT" | "ACTIVE" | "RETIRED";
  factor_weights: Record<string, Record<string, number>>;
  alpha: number;
  operating: { arr: string | null; revenue_multiple: number | null; net_cash: string };
  demand: { score: number | null; multiplier: number; clamped: boolean };
  notes: string[];
  scenarios: Scenario[];
  categories: Record<string, Category>;
  subfactors: Subfactor[];
};

export type ProjectProfile = {
  slug: string; name: string; tagline: string; description: string; stage: Stage; status: string;
  entity_type: "UNINCORPORATED" | "INCORPORATED"; legal_name: string | null; formation_state: string | null;
  website_url: string | null; sector_code: string | null; contact_email: string | null; founders: Founder[];
  valuation: {
    calculated_at: string; model_version_id: string; model_hash: string; declared_stage: Stage; effective_stage: Stage;
    current_operating_value: string; scenario_value: string; model_reference_value: string; round_implied_value: string;
    unit_price_micro_usd: string; reference_units: string; evidence_root: string;
    scores: Record<"execution" | "market" | "product" | "traction" | "economics" | "composite", number>;
    explanation: Explanation | null;
  } | null;
  round: RoundSummary | null;
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Throws ApiError with the backend's `{error: {code, message}}`, or a generic one for non-JSON failures. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...init.headers } });
  } catch {
    throw new ApiError(0, "NETWORK", "Can’t reach Prospecto right now. Check your connection and try again.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body?.error ?? {};
    throw new ApiError(res.status, error.code ?? "HTTP_" + res.status, error.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export const listProjects = () => api<{ projects: ProjectCard[] }>("/projects").then((r) => r.projects);
export const getProject = (slug: string) => api<{ project: ProjectProfile }>(`/projects/${encodeURIComponent(slug)}`).then((r) => r.project);

/** "713239" → 0.713239. Display only; never feed the result back into money math. */
export const microToNumber = (micro: string) => Number(micro) / 1e6;

// tsconfig targets ES2017, which has no BigInt literal syntax.
const ZERO = BigInt(0), MICRO = BigInt(1_000_000), HUNDRED = BigInt(100);

/** Exact `$1,234.56` from integer micro-USD, truncated (not rounded) to `digits` decimals. */
export function formatMicroUsd(micro: string, digits = 2): string {
  const v = BigInt(micro), neg = v < ZERO, abs = neg ? -v : v;
  const whole = (abs / MICRO).toLocaleString("en-US");
  const frac = (abs % MICRO).toString().padStart(6, "0").slice(0, digits);
  return `${neg ? "-" : ""}$${whole}${digits ? "." + frac : ""}`;
}

/** Unit price from micro-USD: at least 2 decimals, up to 6, trailing zeros trimmed ("$0.416", "$2.36"). */
export function formatUnitPrice(micro: string): string {
  return formatMicroUsd(micro, 6).replace(/(\.\d{2}\d*?)0+$/, "$1");
}

/** "1234567.89" (decimal string in USD) → "$1.23M" / "$123K" / "$950". */
export function formatUsdCompact(usd: string | number): string {
  const n = typeof usd === "number" ? usd : Number(usd);
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** Whole percent of target committed (floor), from integer strings. */
export const committedPct = (r: Pick<RoundSummary, "total_committed_micro_usd" | "target_amount_micro_usd">) =>
  Number((BigInt(r.total_committed_micro_usd) * HUNDRED) / BigInt(r.target_amount_micro_usd));

/** Whole days until close (ceil), 0 once closed or filled. */
export function daysLeft(r: Pick<RoundSummary, "closes_at" | "status">, now = Date.now()): number {
  if (r.status !== "OPEN" && r.status !== "SCHEDULED") return 0;
  return Math.max(0, Math.ceil((Date.parse(r.closes_at) - now) / 86_400_000));
}

/** Four-letter display code for the terminal header, e.g. "Fernhill Robotics" → "FERN". */
export const tickerOf = (name: string) => (name.replace(/[^a-z]/gi, "").slice(0, 4) || "CO").toUpperCase();

/** Feed card or profile → the view model the round terminal and feed cards render. */
export function toRound(p: ProjectCard | ProjectProfile): Round {
  const r = p.round;
  const price = r?.unit_price_micro_usd ?? p.valuation?.unit_price_micro_usd ?? "0";
  return {
    t: tickerOf(p.name), n: p.name, slug: p.slug,
    s: p.valuation?.effective_stage ?? p.stage,
    e: p.entity_type === "INCORPORATED" ? "Incorporated" : "Unincorporated",
    p: microToNumber(price), pMicro: price, h: p.tagline || p.name, dek: p.description,
    committedMicro: r?.total_committed_micro_usd, targetMicro: r?.target_amount_micro_usd,
    closesAt: r?.closes_at,
    sub: r ? committedPct(r) : 0, d: r ? daysLeft(r) : 0, b: r?.backers ?? 0,
    cap: r ? Number(r.max_units) : undefined, feeBps: r?.protocol_fee_bps,
    maxPer: r ? microToNumber(r.max_subscription_micro_usd) : undefined,
    f: p.founders.map((f) => ({ n: f.display_name, r: f.role_title ?? (f.role === "FOUNDER" ? "Founder" : "Team") })),
  };
}

/** JSON POST. Pass `idempotencyKey` for routes that require one (BACKEND_STACK §7 conventions). */
export const post = <T>(path: string, body: unknown = {}, idempotencyKey?: string) =>
  api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });

export type Me = { identityId: string; verified: boolean; demoMode?: boolean };

export type ResearchProposal = {
  id: string; metric_code: string; subject: string | null; value_numeric: string | null; value_text: string | null;
  source_type: string; source_url: string | null; quote: string | null; status: string; droppable: boolean;
};

export type ResearchRun = {
  id: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED"; error_code: string | null;
  confirmed_at: string | null;
  result: { proposals: ResearchProposal[]; warnings: string[]; passes: Record<string, string> } | null;
};

export type ValuationPreview = {
  modelVersion: { id: string; status: string };
  stage: { declared: Stage; effective: Stage };
  scores: Record<"execution" | "market" | "product" | "traction" | "economics" | "composite", number>;
  values: { modelReference: string; roundImplied: string; unitPrice: string; unitPriceMicroUsd: string; demandMultiplier: number };
  explanationInputs: { claimCount: number };
};
