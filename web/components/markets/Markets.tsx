"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompanyProfile } from "@/components/ProjectView";
import { api, STAGE_LABEL, type ProjectCard, type Stage } from "@/lib/api";
import { credits, pct, quote, signedCredits, TICK_INTERVAL_MS, type Listing, type Quote } from "@/lib/market";
import { loadBook, saveBook, STARTING_CASH, type Book } from "@/lib/portfolio";
import { investHref, routes, walletHref } from "@/lib/routes";
import Chart, { timeAt } from "./Chart";
import OrderTicket from "./OrderTicket";

type View = "markets" | "portfolio";
const REFERENCE_UNITS = 1_000_000; // valuation model's fixed reference-unit denominator
const qtyFmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));

function toListing(p: ProjectCard): Listing | null {
  const micro = p.round?.unit_price_micro_usd ?? p.valuation?.unit_price_micro_usd;
  if (!micro || !p.ticker) return null;
  return {
    ticker: p.ticker, name: p.name, slug: p.slug, anchor: Number(micro) / 1e6,
    stage: STAGE_LABEL[(p.valuation?.effective_stage ?? p.stage) as Stage] ?? p.stage,
    roundId: p.round?.id, roundOpen: p.round?.status === "OPEN",
  };
}

/** A number that flashes green or red when it changes. */
function Live({ value, text, className = "" }: { value: number; text: string; className?: string }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (value === prev.current) return;
    setFlash(value > prev.current ? "fl-up" : "fl-dn");
    prev.current = value;
    const t = setTimeout(() => setFlash(""), 700);
    return () => clearTimeout(t);
  }, [value]);
  return <span className={`${className} ${flash}`}>{text}</span>;
}

const Chip = ({ q }: { q: Quote }) => <span className={`chip ${q.changePct >= 0 ? "up" : "dn"}`}>{pct(q.changePct)}</span>;

export default function Markets({ view = "markets" }: { view?: View }) {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [book, setBookState] = useState<Book | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [requestedSlug, setRequestedSlug] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  // Static export cannot generate runtime ticker paths, so company pages use ?ticker=QPY.
  // The older ?t= and ?slug= forms remain readable for shared links.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const t = q.get("ticker") ?? q.get("t");
    if (t) setSel(t.toUpperCase());
    else setRequestedSlug(q.get("slug"));
    setBookState(loadBook());
  }, []);
  const nav = useCallback((ticker: string | null) => {
    setSel(ticker);
    setHover(null);
    const q = new URLSearchParams(location.search);
    q.delete("t"); q.delete("slug");
    if (ticker) q.set("ticker", ticker); else q.delete("ticker");
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    api<{ projects: ProjectCard[] }>("/projects")
      .then((r) => setListings(r.projects.map(toListing).filter((l): l is Listing => l !== null)))
      .catch(() => setLoadErr("Markets are unavailable right now. Refresh in a moment."));
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS); return () => clearInterval(id); }, []);

  const quotes = useMemo(() => (listings ?? []).map((l) => quote(l, now)), [listings, now]);
  const byTicker = useMemo(() => new Map(quotes.map((q) => [q.ticker, q])), [quotes]);
  useEffect(() => {
    if (!requestedSlug || sel || !listings) return;
    const match = listings.find((listing) => listing.slug === requestedSlug);
    if (match) nav(match.ticker);
  }, [listings, nav, requestedSlug, sel]);
  const setBook = (b: Book) => { setBookState(b); saveBook(b); };

  // Portfolio: cash plus positions marked at each 5-minute close.
  const pf = useMemo(() => {
    if (!book) return null;
    const held = Object.entries(book.positions).map(([t, p]) => ({ t, p, q: byTicker.get(t) })).filter((h) => h.q);
    const len = quotes[0]?.series.length ?? 1;
    const series = Array.from({ length: len }, (_, i) => book.cash + held.reduce((s, h) => s + h.p.qty * h.q!.series[Math.min(i, h.q!.series.length - 1)], 0));
    const value = series[series.length - 1] ?? book.cash;
    const prev = book.cash + held.reduce((s, h) => s + h.p.qty * h.q!.prevClose, 0);
    const invested = held.reduce((s, h) => s + h.p.qty * h.q!.price, 0);
    return { held, series, value, prev, invested };
  }, [book, byTicker, quotes]);

  // Equal-weight index of every listing, rebased to 100 24 hours ago: the header before the first buy.
  const index = useMemo(() => {
    if (!quotes.length) return null;
    const len = quotes[0].series.length;
    const series = Array.from({ length: len }, (_, i) => (100 * quotes.reduce((s, m) => s + m.series[i] / m.series[0], 0)) / quotes.length);
    return { series, value: series[len - 1], base: 100 };
  }, [quotes]);

  const q = sel ? byTicker.get(sel) : undefined;
  const movers = [...quotes].sort((a, b) => b.changePct - a.changePct);
  const gainers = movers.filter((m) => m.changePct >= 0).slice(0, 4);
  const losers = movers.filter((m) => m.changePct < 0).reverse().slice(0, 4);

  if (loadErr) return <p className="mk-empty">{loadErr}</p>;
  if (!listings || !book || !pf) return <div className="mk-loading"><span /><span /><span /></div>;

  // Header: a simulated company quote on its page, otherwise the simulated portfolio.
  const showIndex = view === "markets" && !q && index;
  const head = q
    ? { value: hover !== null ? q.series[hover] : q.price, base: q.prevClose, series: q.series, digits: undefined as number | undefined, money: true }
    : showIndex
      ? { value: hover !== null ? index.series[hover] : index.value, base: index.base, series: index.series, digits: 2, money: false }
      : { value: hover !== null ? pf.series[hover] : pf.value, base: pf.prev, series: pf.series, digits: 2, money: true };
  const dayChange = head.value - head.base;

  return (
    <div className="mk">
      <div className="mk-main">
        <p className="mk-sim">Simulated session · play credits · browser-local</p>
        {q && <button className="mk-back" type="button" onClick={() => nav(null)}>← All companies</button>}
        <header className="mk-head">
          <p className="kicker">{q ? <><b className="tk">{q.ticker}</b> · {q.stage}{q.roundOpen ? " · Primary issuance open" : ""}</> : showIndex ? <><b className="tk">PRSP</b> · All listings, equal weight</> : "Investing"}</p>
          <h1>{q ? q.name : showIndex ? "Prospecto Index" : "Your portfolio"}</h1>
          <Live className="big mono" value={head.value} text={head.money ? credits(head.value, head.digits) : head.value.toFixed(2)} />
          <p className={`delta mono ${dayChange >= 0 ? "up" : "dn"}`}>
            {head.money ? signedCredits(dayChange, q ? 4 : 2) : `${dayChange >= 0 ? "+" : "−"}${Math.abs(dayChange).toFixed(2)}`} ({pct((head.value / head.base - 1) * 100)}) <span>{hover !== null ? timeAt(quotes[0]?.t0 ?? Date.now(), hover) : "Past 24 hours"}</span>
          </p>
        </header>
        <Chart series={head.series} base={head.base} height={300} onHover={setHover} />
        <div className="mk-range mono"><span className="on">24H</span><span>Live</span></div>

        {q ? (
          <section className="mk-stock">
            <h2>Stats</h2>
            <dl className="stats mono">
              <div><dt>24h open</dt><dd>{credits(q.open)}</dd></div>
              <div><dt>24h high</dt><dd>{credits(q.high)}</dd></div>
              <div><dt>24h low</dt><dd>{credits(q.low)}</dd></div>
              <div><dt>24h volume</dt><dd>{compact(q.volume)}</dd></div>
              <div><dt>Sim-implied value</dt><dd>◇{compact(q.price * REFERENCE_UNITS)}</dd></div>
              <div><dt>Model anchor</dt><dd>{credits(q.anchor)}</dd></div>
              <div><dt>Stage</dt><dd>{q.stage}</dd></div>
            </dl>
            {book.positions[q.ticker] && (() => {
              const p = book.positions[q.ticker], mv = p.qty * q.price, gain = mv - p.cost;
              return (
                <div className="position">
                  <h2>Your position</h2>
                  <dl className="stats mono">
                    <div><dt>Sim units</dt><dd>{qtyFmt(p.qty)}</dd></div>
                    <div><dt>Sim value</dt><dd>{credits(mv, 2)}</dd></div>
                    <div><dt>Avg cost</dt><dd>{credits(p.cost / p.qty)}</dd></div>
                    <div><dt>Total return</dt><dd className={gain >= 0 ? "up" : "dn"}>{signedCredits(gain)} ({pct((mv / p.cost - 1) * 100)})</dd></div>
                  </dl>
                </div>
              );
            })()}
            <div className="links">
              <a href="#company">Company profile & why this price ↓</a>
              {q.roundOpen && <Link href={walletHref(q.roundId)}>Primary issuance is open · commit directly →</Link>}
            </div>
            <div id="company"><CompanyProfile slug={q.slug} embedded /></div>
          </section>
        ) : (
          <>
            <nav className="mk-tabs" aria-label="Sections">
              <Link href={routes.invest} aria-current={view === "markets" ? "page" : undefined}>Markets</Link>
              <Link href={routes.portfolio} aria-current={view === "portfolio" ? "page" : undefined}>Portfolio</Link>
              <Link href={routes.wallet}>Wallet</Link>
            </nav>

            {view === "markets" && (
              <>
                {[["Top gainers", gainers], ["Top losers", losers]].map(([title, list]) => (list as Quote[]).length > 0 && (
                  <section key={title as string} className="mk-movers">
                    <h2>{title as string} <span className="kicker">24h</span></h2>
                    <div className="cards">
                      {(list as Quote[]).map((m) => (
                        <button key={m.ticker} type="button" className="card" onClick={() => nav(m.ticker)}>
                          <span className="tk">{m.ticker}</span>
                          <span className="nm">{m.name}</span>
                          <Chart series={m.series} base={m.prevClose} height={48} compact />
                          <span className="px mono"><Live value={m.price} text={credits(m.price)} /></span>
                          <Chip q={m} />
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                <section className="mk-list">
                  <div className="lhead">
                    <h2>All companies</h2>
                    <input placeholder="Search ticker or name" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search companies" />
                  </div>
                  <div className="rows" role="table">
                    <div className="r hd mono" role="row"><span>Symbol</span><span>Name</span><span>24h</span><span>Price</span><span>Change</span></div>
                    {quotes
                      .filter((m) => !filter || `${m.ticker} ${m.name}`.toLowerCase().includes(filter.toLowerCase()))
                      .sort((a, b) => a.ticker.localeCompare(b.ticker))
                      .map((m) => (
                        <button key={m.ticker} type="button" className="r" role="row" onClick={() => nav(m.ticker)}>
                          <span className="tk">{m.ticker}</span>
                          <span className="nm">{m.name}<i>{m.stage}</i></span>
                          <Chart series={m.series} base={m.prevClose} height={30} compact />
                          <span className="px mono"><Live value={m.price} text={credits(m.price)} /></span>
                          <Chip q={m} />
                        </button>
                      ))}
                  </div>
                </section>
              </>
            )}

            {view === "portfolio" && (
              <section className="mk-pf">
                <dl className="totals mono">
                  <div><dt>Sim value</dt><dd>{credits(pf.invested, 2)}</dd></div>
                  <div><dt>Play credits</dt><dd>{credits(book.cash, 2)}</dd></div>
                  <div><dt>All-time return</dt><dd className={pf.value >= STARTING_CASH ? "up" : "dn"}>{signedCredits(pf.value - STARTING_CASH)} ({pct((pf.value / STARTING_CASH - 1) * 100)})</dd></div>
                </dl>
                {pf.held.length === 0 ? (
                  <p className="mk-empty">No positions yet. <Link href={routes.invest}>Find something to buy →</Link></p>
                ) : (
                  <>
                    <h2>Allocation</h2>
                    <div className="alloc" aria-label="Allocation">
                      {pf.held.map(({ t, p, q: hq }, i) => <span key={t} style={{ flexGrow: p.qty * hq!.price, ["--i" as string]: i }} title={`${t} ${((p.qty * hq!.price) / pf.value * 100).toFixed(1)}%`} />)}
                      <span className="cash" style={{ flexGrow: book.cash }} title={`Cash ${(book.cash / pf.value * 100).toFixed(1)}%`} />
                    </div>
                    <div className="legend mono">
                      {pf.held.map(({ t, p, q: hq }, i) => <span key={t} style={{ ["--i" as string]: i }}><i />{t} {((p.qty * hq!.price) / pf.value * 100).toFixed(1)}%</span>)}
                      <span className="cash"><i />Cash {(book.cash / pf.value * 100).toFixed(1)}%</span>
                    </div>
                    <h2>Holdings</h2>
                    <div className="rows holdings" role="table">
                      <div className="r hd mono" role="row"><span>Symbol</span><span>Sim units</span><span>Avg cost</span><span>Price</span><span>Value</span><span>Return</span></div>
                      {pf.held.map(({ t, p, q: hq }) => {
                        const mv = p.qty * hq!.price, gain = mv - p.cost;
                        return (
                          <Link key={t} href={investHref(t)} className="r" role="row">
                            <span className="tk">{t}</span>
                            <span className="mono">{qtyFmt(p.qty)}</span>
                            <span className="mono">{credits(p.cost / p.qty)}</span>
                            <span className="mono"><Live value={hq!.price} text={credits(hq!.price)} /></span>
                            <span className="mono">{credits(mv, 2)}</span>
                            <span className={`mono ${gain >= 0 ? "up" : "dn"}`}>{signedCredits(gain)}<i>{pct((mv / p.cost - 1) * 100)}</i></span>
                          </Link>
                        );
                      })}
                    </div>
                  </>
                )}
                {book.fills.length > 0 && (
                  <>
                    <h2>Activity</h2>
                    <ul className="activity mono">
                      {book.fills.slice(0, 12).map((f) => (
                        <li key={f.id}>
                          <span className={f.side === "BUY" ? "up" : "dn"}>{f.side === "BUY" ? "Bought" : "Sold"}</span>
                          <b>{qtyFmt(f.qty)} {f.ticker}</b>
                          <span>@ {credits(f.price)}</span>
                          <span>{credits(f.qty * f.price, 2)}</span>
                          <time>{new Date(f.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}

          </>
        )}
      </div>

      <aside className="mk-rail">
        {q ? (
          <OrderTicket key={q.ticker} q={q} book={book} onBook={setBook} />
        ) : (
          <div className="watch">
            <div className="bp mono"><span>Play credits</span><b>{credits(book.cash, 2)}</b></div>
            <h3>{pf.held.length ? "Your positions" : "Watchlist"}</h3>
            {(pf.held.length ? pf.held.map((h) => h.q!) : movers.slice(0, 6)).map((m) => (
              <button key={m.ticker} type="button" className="w" onClick={() => nav(m.ticker)}>
                <span><b className="tk">{m.ticker}</b>{book.positions[m.ticker] && <i className="mono">{qtyFmt(book.positions[m.ticker].qty)} units</i>}</span>
                <Chart series={m.series} base={m.prevClose} height={28} compact />
                <span className="px mono"><Live value={m.price} text={credits(m.price)} /><Chip q={m} /></span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
