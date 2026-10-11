"use client";

import { useState } from "react";
import { usd, type Quote } from "@/lib/market";
import { fill, OrderError, type Book } from "@/lib/portfolio";

const qtyFmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Market order ticket: buy or sell by dollars or shares, filled at the live quote. */
export default function OrderTicket({ q, book, onBook }: { q: Quote; book: Book; onBook: (b: Book) => void }) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [mode, setMode] = useState<"USD" | "QTY">("USD");
  const [raw, setRaw] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const held = book.positions[q.ticker]?.qty ?? 0;
  const amount = Number(raw.replace(/[$,\s]/g, ""));
  const qty = !raw || !Number.isFinite(amount) ? 0 : mode === "USD" ? amount / q.price : amount;
  const notional = qty * q.price;

  const submit = () => {
    setErr(""); setDone("");
    try {
      const next = fill(book, q.ticker, side, qty, q.price);
      onBook(next);
      setDone(`${side === "BUY" ? "Bought" : "Sold"} ${qtyFmt(qty)} ${q.ticker} at ${usd(q.price)}`);
      setRaw("");
    } catch (e) {
      setErr(e instanceof OrderError ? e.message : "Order failed. Try again.");
    }
  };
  const max = () => {
    setMode(side === "BUY" ? "USD" : "QTY");
    setRaw(side === "BUY" ? book.cash.toFixed(2) : String(Math.floor(held * 1e4) / 1e4));
  };

  return (
    <form className="ticket" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="seg" role="tablist" aria-label="Order side">
        {(["BUY", "SELL"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={side === s} className={`${s.toLowerCase()} ${side === s ? "on" : ""}`}
            onClick={() => { setSide(s); setErr(""); setDone(""); }}>
            {s === "BUY" ? "Buy" : "Sell"} {q.ticker}
          </button>
        ))}
      </div>
      <div className="row"><span>Order type</span><b>Market</b></div>
      <div className="row">
        <span>{side === "BUY" ? "Buy in" : "Sell in"}</span>
        <span className="toggle">
          <button type="button" className={mode === "USD" ? "on" : ""} onClick={() => setMode("USD")}>Dollars</button>
          <button type="button" className={mode === "QTY" ? "on" : ""} onClick={() => setMode("QTY")}>Shares</button>
        </span>
      </div>
      <label className="amt">
        <span>{mode === "USD" ? "Amount" : "Shares"}</span>
        <input inputMode="decimal" placeholder={mode === "USD" ? "$0.00" : "0"} value={raw}
          onChange={(e) => { setRaw(e.target.value.replace(/[^0-9.$,]/g, "")); setErr(""); setDone(""); }} aria-label={mode === "USD" ? "Amount in dollars" : "Number of shares"} />
      </label>
      <div className="row"><span>Market price</span><b className="mono">{usd(q.price)}</b></div>
      <div className="row est"><span>{mode === "USD" ? "Est. shares" : side === "BUY" ? "Est. cost" : "Est. credit"}</span>
        <b className="mono">{mode === "USD" ? qtyFmt(qty) : usd(notional, 2)}</b></div>
      <button className={`go ${side.toLowerCase()}`} type="submit" disabled={!(qty > 0)}>
        {side === "BUY" ? "Buy" : "Sell"} {q.ticker}
      </button>
      <p className="err" role="alert">{err}</p>
      {done && <p className="ok" role="status">{done}</p>}
      <div className="foot">
        <span>{side === "BUY" ? `${usd(book.cash, 2)} buying power` : `${qtyFmt(held)} shares available`}</span>
        <button type="button" className="max" onClick={max} disabled={side === "SELL" && !held}>Max</button>
      </div>
    </form>
  );
}
