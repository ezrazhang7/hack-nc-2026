// Real DDL from the migrations for PGlite (WASM Postgres) integration tests. PGlite has no
// TimescaleDB, so the extension and hypertable options are stripped; everything else (types,
// constraints, triggers, the status view) is the migration text itself.
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

const read = (name: string) => readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8").split("-- migrate:down")[0];

/** 0001 through valuation snapshots, idempotency keys, rounds, subscriptions, then all of 0002. */
export function coreSchemaSql(): string {
  const m0001 = read("0001_market_schema.sql");
  const end = m0001.indexOf("-- Traction points");
  const core = m0001
    .slice(0, end)
    .replace("create extension if not exists timescaledb;", "")
    .replace(/\) with \(\s*tsdb\.[\s\S]*?\n\);/g, ");");
  const idempotency = /create table idempotency_keys \([\s\S]*?\n\);/.exec(m0001)?.[0];
  // Rounds with their terms guard and the snapshot back-reference, then the subscription mirror.
  const roundsStart = m0001.indexOf("create table rounds (");
  const roundsEnd = m0001.indexOf("-- Mirror of Subscription PDAs");
  const subscriptions = /create table subscriptions \([\s\S]*?\n\);/.exec(m0001)?.[0];
  if (!idempotency || !subscriptions || end < 0 || roundsStart < 0 || roundsEnd < roundsStart) {
    throw new Error("0001 layout changed; update tests/helpers/pglite-schema.ts");
  }
  const rounds = m0001.slice(roundsStart, roundsEnd);
  return `${core}\n${idempotency}\n${rounds}\n${subscriptions}\ncreate role prospecto_app;\n${read("0002_evidence_research.sql")}\n${read("0005_project_tickers.sql")}`;
}

/** A pg Pool look-alike over one PGlite connection (transactions run on that connection). */
export function asPool(pg: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params as never[]);
    // PGlite reports affectedRows = 0 for SELECT; pg's rowCount counts returned rows there.
    return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}
