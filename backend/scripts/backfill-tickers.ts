// Gives every project without a market symbol its first free suggestion (migration 0005). Idempotent.
//   npm run db:backfill-tickers
import { Pool } from "pg";

import { availableTicker } from "../src/projects/ticker.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query<{ id: string; name: string }>(`select id, name from projects where ticker is null order by created_at`);
  for (const row of rows) {
    const ticker = await availableTicker(pool, row.name);
    await pool.query(`update projects set ticker = $2 where id = $1 and ticker is null`, [row.id, ticker]);
    console.log(`${ticker.padEnd(6)} ${row.name}`);
  }
  console.log(`${rows.length} project(s) backfilled.`);
} finally {
  await pool.end();
}
