"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { formatUnitPrice, listProjects, STAGE_LABEL, toRound } from "@/lib/api";
import type { Round } from "@/lib/fixtures";
import { investHref } from "@/lib/routes";

const FILTERS = ["All", "Idea", "Prototype", "Launched", "Revenue", "Growth", "Closing soon"] as const;
type Filter = (typeof FILTERS)[number];

const matches = (c: Round, f: Filter) =>
  f === "All" ? true : f === "Closing soon" ? c.d > 0 && c.d <= 9 : STAGE_LABEL[c.s] === f;

export default function RoundsFeed() {
  const [active, setActive] = useState<Filter>("All");
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listProjects().then((projects) => setRounds(projects.map(toRound)), (e: Error) => setError(e.message));
  }, []);
  const list = (rounds ?? []).filter((c) => matches(c, active));
  return (
    <>
      <div className="filters">
        <div className="chips" role="group" aria-label="Filter rounds">
          {FILTERS.map((f) => (
            <button key={f} className="chip" aria-pressed={f === active} onClick={() => setActive(f)}>{f}</button>
          ))}
        </div>
        <span className="kicker">Fixed prices · bought from the startup</span>
      </div>
      {/* key forces a remount so cards replay their entrance on every filter change */}
      <section className="grid" aria-live="polite" key={active}>
        {list.length ? list.map((c, i) => {
          const full = c.sub >= 100, lead = i === 0 && list.length > 2;
          return (
            <article key={c.slug ?? c.t} className={`card enter${lead ? " lead" : ""}`} style={{ "--n": i } as CSSProperties}>
              <Link className="cover" href={investHref(c.t)} aria-label={`${c.n}: company and price`} />
              <span className="k"><b>{STAGE_LABEL[c.s]}</b> · {c.e}</span>
              {lead && <div className="plate"><div className="ridge" /><div className="sun" /></div>}
              <h2>{c.h}</h2>
              <p>{c.dek}</p>
              <span className="sp" />
              <div className={`bar${full ? " full" : ""}`}><i style={{ width: `${Math.min(c.sub, 100)}%` }} /></div>
              <div className="ft">
                <span>
                  <b>{c.pMicro ? formatUnitPrice(c.pMicro) : "—"}</b> · {full ? <span className="dn">Full</span> : `${c.sub}%`}
                  {c.d > 0 && <> · <span className={c.d <= 3 ? "dn" : ""}>{c.d}d left</span></>}
                </span>
                <span className="go">{full ? "Watch" : "Back them"} <span>→</span></span>
              </div>
            </article>
          );
        }) : <p className="empty">{error ?? (rounds ? "No open rounds here yet." : "Loading rounds…")}</p>}
      </section>
    </>
  );
}
