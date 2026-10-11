// The trader's book for the markets screen: cash, positions and fills, kept in this browser.
// Market orders fill at the quote on screen. Never touches the real wallet, rounds or receipts.

export type Position = { qty: number; cost: number };
export type Fill = { id: string; at: number; ticker: string; side: "BUY" | "SELL"; qty: number; price: number };
export type Book = { cash: number; positions: Record<string, Position>; fills: Fill[] };

export const STARTING_CASH = 10_000;
const KEY = "prospecto:book:v1";
const fresh = (): Book => ({ cash: STARTING_CASH, positions: {}, fills: [] });

export function loadBook(): Book {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw.cash === "number" && raw.positions && Array.isArray(raw.fills)) return raw;
  } catch { /* storage blocked */ }
  return fresh();
}

export function saveBook(book: Book) {
  try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* storage blocked */ }
}

export class OrderError extends Error {}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Fills a market order at `price`. Quantities may be fractional (6 dp), like fractional shares. */
export function fill(book: Book, ticker: string, side: "BUY" | "SELL", qty: number, price: number, now = Date.now()): Book {
  qty = round6(qty);
  if (!(qty > 0) || !(price > 0)) throw new OrderError("Enter an amount.");
  const pos = book.positions[ticker] ?? { qty: 0, cost: 0 };
  const notional = round6(qty * price);
  const positions = { ...book.positions };
  let cash = book.cash;
  if (side === "BUY") {
    if (notional > cash + 1e-6) throw new OrderError("Not enough buying power.");
    cash = round6(cash - notional);
    positions[ticker] = { qty: round6(pos.qty + qty), cost: round6(pos.cost + notional) };
  } else {
    if (qty > pos.qty + 1e-6) throw new OrderError(`You own ${pos.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${ticker}.`);
    const left = round6(pos.qty - qty);
    cash = round6(cash + notional);
    if (left <= 1e-6) delete positions[ticker];
    else positions[ticker] = { qty: left, cost: round6(pos.cost * (left / pos.qty)) };
  }
  const f: Fill = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now, ticker, side, qty, price };
  return { cash, positions, fills: [f, ...book.fills].slice(0, 200) };
}

export const resetBook = () => { const b = fresh(); saveBook(b); return b; };
