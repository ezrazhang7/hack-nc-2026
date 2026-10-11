"use client";

import RoundTerminal from "@/components/RoundTerminal";
import FounderCards from "@/components/FounderCards";
import { ROUNDS } from "@/lib/fixtures";
import { pickTicker, usePickedTicker } from "@/lib/desk";

// The landing terminal and the founder cards both follow the company picked in the watchlist.
const find = (t: string) => ROUNDS.find((r) => r.t === t) ?? ROUNDS[0];

export function DeskTerminal() {
  const co = find(usePickedTicker());
  return <RoundTerminal co={co} watch={ROUNDS} onPick={pickTicker} />;
}

export function DeskFounders() {
  const co = find(usePickedTicker());
  return <FounderCards company={co.n} founders={co.f ?? []} demo />;
}
