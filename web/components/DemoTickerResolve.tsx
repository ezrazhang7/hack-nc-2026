"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, post, type Me } from "@/lib/api";
import { investHref, routes } from "@/lib/routes";

/*
 * /list/demo after the last answer: asks the backend for the ticker Gemini would assign at creation
 * (POST /tickers/name, read-only) and opens the published listing that already holds it. Quippy is
 * seeded, so the presenter sees the real Gemini pick land on QPY without creating a duplicate.
 */

type Named = { ticker: string | null; picks: string[]; source: "gemini" | "fallback"; listed: { slug: string; name: string; ticker: string } | null };

export default function DemoTickerResolve({ name, tagline, onEdit }: { name: string; tagline: string; onEdit: () => void }) {
  const [named, setNamed] = useState<Named | null>(null);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await api<Me>("/me");
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) throw e;
        await post("/demo/sign-in", {});
      }
      setNamed(await post<Named>("/tickers/name", { name, tagline }));
    })().catch((e) => setError(e instanceof ApiError ? e.message : "Couldn’t name the ticker."));
  }, [name, tagline]);

  return (
    <section className="done on pipe" aria-live="polite">
      <div>
        <span className="kicker">{name} · Ticker</span>
        <p className="note">The same Gemini call a new listing makes at creation. The server checks the format and falls back to a deterministic symbol if Gemini is slow or wrong.</p>
      </div>
      <div>
        {!named && !error && <h2>Naming <i>…</i></h2>}
        {error && (
          <>
            <h2>Not <i>yet.</i></h2>
            <p className="msg" role="alert">{error}</p>
            <div className="row"><button className="btn ghost" type="button" onClick={onEdit}>← Edit answers</button></div>
          </>
        )}
        {named && (
          <>
            <h2>{named.ticker ? <>Ticker <i>{named.ticker}.</i></> : <>No <i>ticker.</i></>}</h2>
            <div className="stats">
              <div><span>Named by</span><b>{named.source === "gemini" ? "Gemini" : "Fallback"}</b></div>
              {named.picks.length > 1 && <div><span>Alternatives</span><b>{named.picks.slice(1, 4).join(" · ")}</b></div>}
            </div>
            {named.listed ? (
              <>
                <p className="note">{named.listed.ticker} is already listed as {named.listed.name}, so this opens that listing instead of creating a second one.</p>
                <div className="row">
                  <Link className="btn go" href={investHref(named.listed.ticker)}>Open {named.listed.ticker} →</Link>
                  <button className="btn ghost" type="button" onClick={onEdit}>← Edit answers</button>
                </div>
              </>
            ) : (
              <>
                <p className="msg">No published listing holds {named.ticker ?? "this symbol"} under the name {name}.</p>
                <div className="row"><Link className="btn" href={routes.list}>Blank intake →</Link><button className="btn ghost" type="button" onClick={onEdit}>← Edit answers</button></div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
