// Simulated demand for open issuances (AGENTS.md demo market-simulator exception).
//
// Display-only: it is added to the real committed total and backer count when a round is shown,
// and is never sent to the API, written to rounds, or used for allocation, fees or refunds — the
// server and the chain only ever see real commitments. Each browser session draws a new seed, so
// every run looks different; `?demand=<seed>` replays a run exactly (the seed is logged).
import type { RoundSummary } from "@/lib/api";

const KEY = "prospecto:demand-seed";
let cached: number | null = null;

function sessionSeed(): number | null {
  if (typeof window === "undefined") return null;
  if (cached !== null) return cached;
  const forced = new URLSearchParams(window.location.search).get("demand");
  let seed = forced && /^\d{1,10}$/.test(forced) ? Number(forced) >>> 0 : NaN;
  if (Number.isNaN(seed)) {
    try { const saved = sessionStorage.getItem(KEY); if (saved) seed = Number(saved) >>> 0; } catch { /* storage blocked */ }
  }
  if (Number.isNaN(seed)) seed = crypto.getRandomValues(new Uint32Array(1))[0];
  try { sessionStorage.setItem(KEY, String(seed)); } catch { /* storage blocked */ }
  console.info(`[Prospecto] demand seed ${seed} (replay with ?demand=${seed})`);
  return (cached = seed);
}

/** mulberry32: small, fast, deterministic PRNG. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * The round with simulated commitments and backers added. Per round and seed it draws a share of
 * target (15–85%), grown by how far the round is through its window, and an average ticket of
 * $40–$160 for the backer count. It never fills a round: the total stays below 97% of target.
 */
export function withDemand<T extends RoundSummary | null | undefined>(round: T, now = Date.now()): T {
  const seed = sessionSeed();
  if (!round || seed === null || (round.status !== "OPEN" && round.status !== "SCHEDULED")) return round;
  const next = rng(hash(`${seed}:${round.id}`));
  const share = 0.15 + next() * 0.7, ticketUsd = 40 + next() * 120;
  const opens = Date.parse(round.opens_at), closes = Date.parse(round.closes_at);
  const elapsed = closes > opens ? Math.min(1, Math.max(0, (now - opens) / (closes - opens))) : 1;
  const target = BigInt(round.target_amount_micro_usd), real = BigInt(round.total_committed_micro_usd);
  const ceiling = (target * BigInt(97)) / BigInt(100);
  const wantedBps = BigInt(Math.round(share * (0.6 + 0.4 * elapsed) * 10_000));
  let simulated = (target * wantedBps) / BigInt(10_000);
  if (real + simulated > ceiling) simulated = ceiling > real ? ceiling - real : BigInt(0);
  const backers = Math.round(Number(simulated / BigInt(1_000_000)) / ticketUsd);
  return { ...round, total_committed_micro_usd: (real + simulated).toString(), backers: round.backers + backers };
}
