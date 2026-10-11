// Vercel entry (Hono zero-config): the backend service in the root vercel.json.
// Local development uses src/index.ts instead.
import { attachDatabasePool, waitUntil } from "@vercel/functions";

import { readiness, unconfiguredApi } from './src/readiness.js';

const initialized = readiness().backendConfigured ? await (await import("./src/bootstrap.js")).bootstrap({
  // Each Fluid compute instance holds its own small pool; idle clients close before suspension.
  poolOptions: { max: 5, idleTimeoutMillis: 5_000 },
  // Research runs continue after the 202 response, up to the function's max duration.
  runInBackground: (task) => waitUntil(task()),
}) : null;
if(initialized) {
  attachDatabasePool(initialized.pool);
  attachDatabasePool(initialized.authPool);
}

export default initialized?.app ?? unconfiguredApi();
