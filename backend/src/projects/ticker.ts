// Market symbols for projects: 2–5 uppercase letters, unique (migration 0005).
import type { Pool, PoolClient } from "pg";

export const TICKER = /^[A-Z]{2,5}$/;
const VOWELS = new Set(["A", "E", "I", "O", "U"]);

const letters = (word: string) => word.normalize("NFKD").toUpperCase().replace(/[^A-Z]/g, "");
const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");

/**
 * Candidate symbols in preference order. One word: first letter plus the following consonants
 * (Quippy → QPY, Kiln Labs → KLN). Three or more words: initials first (Big Red Dog → BRD).
 * Longer and vowel-including variants follow as fallbacks.
 */
export function tickerCandidates(name: string): string[] {
  const words = name.split(/[^A-Za-z]+/).map(letters).filter(Boolean);
  if (!words.length) return ["CO", "COX", "COXY"];
  const [first] = words;
  const consonants = collapse(first[0] + [...first.slice(1)].filter((c) => !VOWELS.has(c)).join(""));
  const initials = words.slice(0, 4).map((w) => w[0]).join("");
  const out = new Set<string>();
  const add = (s: string) => { if (TICKER.test(s)) out.add(s); };
  if (words.length >= 3) add(initials);
  add(consonants.slice(0, 3));
  add(consonants.slice(0, 4));
  add(first.slice(0, 4));
  add(first.slice(0, 3));
  add(consonants.slice(0, 2) + (first.at(-1) ?? ""));
  add(first.slice(0, 5));
  if (!out.size) add((first + "XX").slice(0, 3));
  return [...out];
}

/** First candidate not already taken; falls back to the base plus a letter (QPYA, QPYB, …). */
export async function availableTicker(db: Pool | PoolClient, name: string): Promise<string> {
  const candidates = tickerCandidates(name);
  const taken = new Set(
    (await db.query<{ ticker: string }>(`select ticker from projects where ticker is not null`)).rows.map((r) => r.ticker),
  );
  for (const c of candidates) if (!taken.has(c)) return c;
  const base = candidates[0].slice(0, 4);
  for (const extra of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(base + extra)) return base + extra;
  throw new Error("no ticker available");
}
