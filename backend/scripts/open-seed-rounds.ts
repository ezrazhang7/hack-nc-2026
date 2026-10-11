// Operator script: puts seeded demo companies on Solana Devnet so their primary issuance accepts real
// (mock-USDC) commitments. Approved 2026-10-11 as a one-time demo operation for quippy, treasury and
// heart-aerospace.
//
// Demo shortcuts, stated plainly:
// - Seeded founders are public people who never signed in, so the "founder" signature comes from an
//   operator-held Devnet key per company (chain/.keys/, gitignored). It replaces real founder custody.
// - Seeded rounds were inserted already OPEN with no on-chain round. Opening on chain needs a DRAFT
//   round with a future close, so each round (only if it has no subscriptions) goes back to DRAFT and
//   gets a fresh 14-day window. Price, units, caps, fees and the valuation snapshot are unchanged and
//   re-checked against the chain by the projector.
//
// Everything else is the app's real founder flow: prepare (relayer co-signs), founder signs, submit,
// wait for finalization, index the events. Deterministic request keys make reruns resume safely.
//
//   npx tsx --env-file-if-exists=../.env.local scripts/open-seed-rounds.ts quippy treasury heart-aerospace
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import pg from "pg";

import { loadConfig } from "../src/config.js";
import { hash } from "../src/purchase/banking/canonical.js";
import { loadPurchaseServices } from "../src/purchase/runtime.js";
import { SolanaChain } from "../src/purchase/solana/client.js";
import { TokenizationService } from "../src/purchase/tokenization/service.js";
import { loadRound } from "../src/rounds/service.js";
import { challengeMessage, verifyWalletSignature } from "../src/wallets/solana.js";

const ALLOWED = new Set(["quippy", "treasury", "heart-aerospace"]);
const slugs = process.argv.slice(2);
if (!slugs.length || slugs.some((s) => !ALLOWED.has(s))) throw new Error(`Usage: open-seed-rounds.ts <${[...ALLOWED].join("|")}>...`);

const KEY_DIR = new URL("../../chain/.keys/", import.meta.url);
async function founderKey(slug: string): Promise<Keypair> {
  const file = new URL(`seed-founder-${slug}.json`, KEY_DIR);
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(file, "utf8")))); } catch { /* create below */ }
  await mkdir(KEY_DIR, { recursive: true });
  const key = Keypair.generate();
  await writeFile(file, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 });
const services = await loadPurchaseServices(pool, config);
if (!services || !(services.chain instanceof SolanaChain) || !services.indexer) throw new Error("Purchases and the Solana chain must be configured.");
const { store, indexer } = services;
const chain = services.chain;
const tokenization = new TokenizationService(store, chain);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Founder-signs a prepared transaction, submits it through the app, waits for finalization, indexes it. */
async function signSubmitFinalize(identityId: string, founder: Keypair, prepared: { signature: string; transaction: string; status: string }, key: string) {
  if (prepared.status === "Prepared") {
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    tx.sign([founder]);
    await tokenization.submit(identityId, prepared.signature, Buffer.from(tx.serialize()).toString("base64"), `${key}:submit`);
  }
  for (let i = 0; i < 60; i++) {
    const { status } = await tokenization.transaction(identityId, prepared.signature);
    if (status === "Finalized") { await indexer.ingest(prepared.signature); return prepared.signature; }
    if (["Failed", "Expired"].includes(status)) throw new Error(`transaction ${prepared.signature} ${status}`);
    await sleep(3000);
  }
  throw new Error(`transaction ${prepared.signature} not finalized after 3 minutes; rerun to resume`);
}

try {
  for (const slug of slugs) {
    const project = (await pool.query<{ id: string; founder_identity_id: string; receipt_mint: string | null }>(
      `select id, founder_identity_id, receipt_mint from projects where slug = $1 and status = 'PUBLISHED'`, [slug])).rows[0];
    if (!project) throw new Error(`${slug}: no published project`);
    const identityId = project.founder_identity_id;
    const founder = await founderKey(slug);
    const address = founder.publicKey.toBase58();

    // 1. Bind the operator key to the seed founder with a real ownership signature (same message as users sign).
    const bound = (await pool.query<{ identity_id: string }>(`select identity_id from wallets where address = $1`, [address])).rows[0];
    if (bound && bound.identity_id !== identityId) throw new Error(`${slug}: key is bound to another identity`);
    if (!bound) {
      const now = new Date();
      const message = challengeMessage(address, randomBytes(24).toString("base64url"), now, new Date(now.getTime() + 300_000));
      // PKCS#8 wrapper for a raw 32-byte ed25519 seed (RFC 8410).
      const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(founder.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });
      const signature = bs58.encode(sign(null, Buffer.from(message, "utf8"), privateKey));
      if (!verifyWalletSignature(address, message, signature)) throw new Error(`${slug}: ownership signature did not verify`);
      await pool.query(`insert into wallets (address, identity_id, verified_signature, is_primary) values ($1, $2, $3, true)`, [address, identityId, signature]);
    }

    // 2. Tokenize: create_project with the receipt mint.
    if (!project.receipt_mint) {
      const key = `seed-open:${slug}:tokenize`;
      const prepared = await tokenization.prepare(identityId, project.id, key);
      console.log(`${slug}: create_project ${await signSubmitFinalize(identityId, founder, prepared, key)}`);
    }

    // 3. Open round 1 on chain.
    let round = (await pool.query<{ id: string; status: string; solana_round_pda: string | null }>(
      `select id, status, solana_round_pda from rounds where project_id = $1 and round_number = 1`, [project.id])).rows[0];
    if (!round) throw new Error(`${slug}: no round`);
    if (round.solana_round_pda) { console.log(`${slug}: round already on chain ${round.solana_round_pda}`); continue; }
    const key = `seed-open:${slug}:open`;
    let intent = await store.findByKey(identityId, key);
    if (!intent) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const subs = await client.query(`select 1 from subscriptions where round_id = $1 limit 1`, [round.id]);
        if (subs.rowCount) throw new Error(`${slug}: round has subscriptions; refusing to change its window`);
        if (round.status !== "DRAFT") await client.query(`update rounds set status = 'DRAFT' where id = $1 and status = $2`, [round.id, round.status]);
        await client.query(`update rounds set opens_at = date_trunc('second', now()) - interval '1 minute',
                                              closes_at = date_trunc('second', now()) + interval '14 days' where id = $1 and status = 'DRAFT'`, [round.id]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
      const row = (await loadRound(pool, round.id))!;
      const founderWallet = (await store.project(project.id))!.founderWallet;
      const prepared = await chain.prepareRound(row, founderWallet);
      const number = Buffer.alloc(2); number.writeUInt16LE(row.round_number);
      const roundPda = PublicKey.findProgramAddressSync([Buffer.from("round"), new PublicKey(prepared.projectPda).toBuffer(), number], new PublicKey(chain.programAddress()))[0].toBase58();
      intent = await store.reserve({ ...prepared, id: crypto.randomUUID(), identityId, projectId: project.id, requestKey: key,
        requestHash: hash({ operation: "open-round", roundId: round.id, wallet: founderWallet }), status: "Prepared", kind: "Open", roundPda, buyerWallet: founderWallet });
    }
    console.log(`${slug}: open_round ${await signSubmitFinalize(identityId, founder, intent, key)}`);
    round = (await pool.query(`select id, status, solana_round_pda from rounds where id = $1`, [round.id])).rows[0];
    console.log(`${slug}: round ${round!.status} at ${round!.solana_round_pda}`);
  }
} finally {
  await pool.end();
}
