// Market engine for the markets screen. Pure and deterministic: a quote depends only on the ticker,
// the company's model price (the anchor) and the clock, so every viewer sees the same tape and a
// reload never jumps. Prices mean-revert around the real model price in 5-minute steps, quoted over
// a rolling 24 hours (no midnight reset) with a live 2 s tick.
// Never feeds back into the real layer (valuations, rounds, receipts, mock USDC).

export type Listing = { ticker: string; name: string; slug: string; anchor: number; stage: string; roundId?: string; roundOpen: boolean };

export type Quote = Listing & {
  price: number; prevClose: number; open: number; high: number; low: number;
  change: number; changePct: number; volume: number;
  /** 5-minute closes over the past 24 hours, ending at the live price. */
  series: number[];
  /** Time of series[0], ms since epoch; every quote at the same moment shares it. */
  t0: number;
};

const STEP_MS = 5 * 60_000;
const TICK_MS = 2_000;
const STEPS_PER_DAY = 288;
const TAU = STEPS_PER_DAY;          // mean reversion time: about one day
const PHI = Math.exp(-1 / TAU);
const KERNEL = STEPS_PER_DAY * 5;   // truncation: PHI^KERNEL ≈ e^-5
const PHI_N = Math.pow(PHI, KERNEL);
// Step noise so the 24h change has standard deviation `vol` (stationary OU: 2·var·(1 − PHI^288) = vol²).
const STEP_SCALE = Math.sqrt((1 - PHI * PHI) / (2 * (1 - Math.exp(-STEPS_PER_DAY / TAU))));

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Per-name character: 24h volatility 3–14% and typical daily volume. */
function profile(ticker: string) {
  const r = rng(hash(`profile:${ticker}`));
  return { vol: 0.03 + r() * 0.11, volume: 40_000 + r() * 400_000, seed: hash(`steps:${ticker}`) };
}

/** The shock for absolute 5-minute step k: depends only on (ticker, k), so every viewer agrees. */
function shock(seed: number, k: number, sigma: number): number {
  const r = rng(Math.imul(seed ^ k, 2654435761) ^ (k >>> 16));
  const jump = r() < 0.003 ? gauss(r) * 6 : 0; // occasional news gap
  return sigma * (gauss(r) + jump);
}

/**
 * Log distance from the anchor at step k: a truncated Ornstein–Uhlenbeck sum over the last KERNEL
 * shocks, x_k = Σ PHI^j ε_{k−j}. Stateless, so the path is continuous for everyone and never resets.
 */
function path(seed: number, sigma: number, from: number, to: number): number[] {
  let x = 0;
  for (let j = KERNEL - 1; j >= 0; j--) x = x * PHI + shock(seed, from - j, sigma);
  const out = [x];
  for (let k = from + 1; k <= to; k++) {
    x = PHI * x + shock(seed, k, sigma) - PHI_N * shock(seed, k - KERNEL, sigma);
    out.push(x);
  }
  return out;
}

export function quote(l: Listing, now = Date.now()): Quote {
  const p = profile(l.ticker);
  const sigma = p.vol * STEP_SCALE;
  const k = Math.floor(now / STEP_MS);
  const xs = path(p.seed, sigma, k - STEPS_PER_DAY, k);
  const series = xs.map((x) => l.anchor * Math.exp(x));
  // Live tick: a small shared wiggle inside the current 5-minute bar.
  const t = rng(hash(`tick:${l.ticker}:${Math.floor(now / TICK_MS)}`));
  const price = series[series.length - 1] * Math.exp(sigma * 0.4 * gauss(t));
  series[series.length - 1] = price;
  const prevClose = series[0];
  return {
    ...l, price, prevClose, open: prevClose,
    high: Math.max(...series), low: Math.min(...series),
    change: price - prevClose, changePct: (price / prevClose - 1) * 100,
    volume: Math.round(p.volume * (1 + Math.abs(price / prevClose - 1) * 8)),
    series, t0: (k - STEPS_PER_DAY) * STEP_MS,
  };
}

export const TICK_INTERVAL_MS = TICK_MS;

export const usd = (n: number, digits?: number) => {
  const d = digits ?? (Math.abs(n) < 10 ? 4 : 2);
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
export const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
export const signedUsd = (n: number, digits = 2) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n), digits)}`;
