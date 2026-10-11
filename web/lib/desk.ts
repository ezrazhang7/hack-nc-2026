import { useSyncExternalStore } from "react";

// Landing page only: which fixture company the round terminal and the founder cards are showing.
// A tiny shared store so two separate client islands stay in step without lifting the static markup.
const DEFAULT = "QPY";
let picked = DEFAULT;
const subs = new Set<() => void>();

export function pickTicker(t: string) {
  if (t === picked) return;
  picked = t;
  subs.forEach((fn) => fn());
}

export function usePickedTicker() {
  return useSyncExternalStore(
    (fn) => (subs.add(fn), () => void subs.delete(fn)),
    () => picked,
    () => DEFAULT,
  );
}
