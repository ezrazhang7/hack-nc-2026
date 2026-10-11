// Projects, valuation preview, and profile snapshots against the real 0001/0002 DDL (PGlite).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbProfileSnapshotLookup } from "../src/evidence/research/profile-snapshots.js";
import { createProfilesRouter } from "../src/routes/profiles.js";
import { createProjectsRouter, slugBase } from "../src/routes/projects.js";
import { modelHash } from "../src/valuation/model-value.js";
import { modelDocument } from "../src/valuation/service.js";
import { asPool, coreSchemaSql } from "./helpers/pglite-schema.js";

const ORIGIN = "http://localhost:8787";
let db: PGlite;
let pool: Pool;
let app: Hono;

const deny = (status: 401 | 404, code: string) => new HTTPException(status, { res: Response.json({ error: { code } }, { status }) });
// Stand-ins for Better Auth: the caller's identity comes from a test header. The editor check
// is the same query as auth/identity.ts requireProjectEditor.
const requireIdentity = async (context: Context) => {
  const identityId = context.req.header("x-test-identity");
  if (!identityId) throw deny(401, "UNAUTHENTICATED");
  return { identityId };
};
const requireProjectEditor = async (context: Context, projectId: string) => {
  const { identityId } = await requireIdentity(context);
  const { rowCount } = await pool.query(
    `select 1 from projects p where p.id = $1 and (p.founder_identity_id = $2
       or exists (select 1 from project_members m where m.project_id = p.id and m.identity_id = $2))`,
    [projectId, identityId],
  );
  if (!rowCount) throw deny(404, "PROJECT_NOT_FOUND");
  return { identityId };
};

async function newIdentity(email: string): Promise<string> {
  const user = await db.query<{ id: string }>(
    `insert into auth."user" (name, email, "emailVerified", "createdAt", "updatedAt") values ('', $1, true, now(), now()) returning id`,
    [email],
  );
  const identity = await db.query<{ id: string }>(
    `insert into identities (auth_user_id, campus_email_hash, verification_status, verified_at) values ($1, $2, 'VERIFIED', now()) returning id`,
    [user.rows[0].id, createHash("sha256").update(email).digest("hex")],
  );
  return identity.rows[0].id;
}

// Swappable Gemini stand-in for ticker naming; tests that care set it.
let namer: (p: { name: string; tagline: string }) => Promise<string[]> = async () => [];

const call = (identity: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(identity ? { "x-test-identity": identity } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const project = (overrides: Record<string, unknown> = {}) => ({
  name: "Mothlight",
  tagline: "Quiet study rooms at 2 a.m.",
  stage: "LAUNCHED",
  website_url: "https://mothlight.app/?utm_source=x",
  founder: { display_name: "Ana Ruiz", role_title: "CEO" },
  ...overrides,
});

async function addClaim(projectId: string, identityId: string, metric: string, value: { numeric?: string; text?: string }, status: string) {
  const claim = await db.query<{ id: string }>(
    `insert into evidence_claims (project_id, metric_code, value_numeric, value_text, source_type, content_hash, created_by_identity_id)
     values ($1, $2, $3, $4, 'FOUNDER_STATEMENT', $5, $6) returning id`,
    [projectId, metric, value.numeric ?? null, value.text ?? null, createHash("sha256").update(randomUUID()).digest("hex"), identityId],
  );
  await db.query(`insert into evidence_verifications (claim_id, status) values ($1, $2::evidence_status)`, [claim.rows[0].id, status]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(coreSchemaSql());
  pool = asPool(db);
  const seed = JSON.parse(readFileSync(new URL("../../db/seeds/valuation-v0.1.json", import.meta.url), "utf8"));
  const document = modelDocument(seed);
  await db.query(
    `insert into model_versions (id, effective_at, stage_weights, factor_weights, normalization_rules, scenario_parameters, demand_parameters, model_hash)
     values ($1, now(), $2, $3, $4, $5, $6, $7)`,
    [seed.id, ...["stage_weights", "factor_weights", "normalization_rules", "scenario_parameters", "demand_parameters"].map((k) => JSON.stringify(seed[k])), modelHash(document)],
  );
  const guards = { pool, publicOrigin: ORIGIN, requireIdentity };
  app = new Hono();
  app.route("/api", createProjectsRouter({ ...guards, requireProjectEditor, nameTicker: (p) => namer(p) }));
  app.route("/api", createProfilesRouter(guards));
  app.onError((error, context) => (error instanceof HTTPException ? error.getResponse() : context.json({ error: { code: "INTERNAL", message: String(error) } }, 500)));
});

afterAll(async () => {
  await db.close();
});

describe("POST /projects", () => {
  it("creates a draft with the founder as a member, canonical website, and a free slug", async () => {
    const ana = await newIdentity("ana@unc.edu");
    const first = await call(ana, "POST", "/projects", project(), { "idempotency-key": "create-0001" });
    expect(first.status).toBe(201);
    const { project: created } = await first.json();
    expect(created).toMatchObject({ slug: "mothlight", status: "DRAFT" });

    const row = await db.query(`select tagline, stage::text, entity_type::text, website_url, publish_contact_email from projects where id = $1`, [created.id]);
    expect(row.rows[0]).toEqual({ tagline: "Quiet study rooms at 2 a.m.", stage: "LAUNCHED", entity_type: "UNINCORPORATED", website_url: "https://mothlight.app/", publish_contact_email: true });
    const member = await db.query(`select role::text, display_name, role_title from project_members where project_id = $1`, [created.id]);
    expect(member.rows).toEqual([{ role: "FOUNDER", display_name: "Ana Ruiz", role_title: "CEO" }]);

    const second = await call(ana, "POST", "/projects", project(), { "idempotency-key": "create-0002" });
    expect((await second.json()).project.slug).toBe("mothlight-2");
  });

  it("replays the same Idempotency-Key and rejects it for a different body", async () => {
    const ben = await newIdentity("ben@unc.edu");
    const body = project({ name: "Dormfold" });
    const a = await call(ben, "POST", "/projects", body, { "idempotency-key": "same-key-01" });
    const b = await call(ben, "POST", "/projects", body, { "idempotency-key": "same-key-01" });
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect((await db.query(`select count(*)::int as n from projects where name = 'Dormfold'`)).rows[0]).toEqual({ n: 1 });
    const c = await call(ben, "POST", "/projects", project({ name: "Other" }), { "idempotency-key": "same-key-01" });
    expect(c.status).toBe(409);
    expect((await c.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects foreign origins, anonymous callers, missing keys, and invalid entity fields", async () => {
    const cy = await newIdentity("cy@unc.edu");
    expect((await call(cy, "POST", "/projects", project(), { "idempotency-key": "k-000001", origin: "https://evil.example" })).status).toBe(403);
    expect((await call(null, "POST", "/projects", project(), { "idempotency-key": "k-000002" })).status).toBe(401);
    expect((await call(cy, "POST", "/projects", project())).status).toBe(400);
    const legal = await call(cy, "POST", "/projects", project({ legal_name: "Mothlight LLC" }), { "idempotency-key": "k-000003" });
    expect(legal.status).toBe(400);
    const incorporated = await call(cy, "POST", "/projects", project({ entity_type: "INCORPORATED", legal_name: "Mothlight LLC", formation_state: "nc" }), {
      "idempotency-key": "k-000004",
    });
    expect(incorporated.status).toBe(201);
    const { project: created } = await incorporated.json();
    const row = await db.query(`select legal_name, formation_state from projects where id = $1`, [created.id]);
    expect(row.rows[0]).toEqual({ legal_name: "Mothlight LLC", formation_state: "NC" });
    expect((await call(cy, "POST", "/projects", project({ website_url: "ftp://x" }), { "idempotency-key": "k-000005" })).status).toBe(400);
  });

  it("never produces a uuid-shaped slug", () => {
    expect(slugBase("123e4567-e89b-12d3-a456-426614174000")).toBe("p-123e4567-e89b-12d3-a456-426614174000");
    expect(slugBase("Café  Δ!")).toBe("cafe");
    expect(slugBase("!!!")).toBe("project");
  });
});

describe("public profile and valuation preview", () => {
  it("hides drafts from the public, shows them to editors, and publishes contact + latest valuation", async () => {
    const dee = await newIdentity("dee@unc.edu");
    const created = await (await call(dee, "POST", "/projects", project({ name: "Tidewater", stage: "EARLY_REVENUE" }), { "idempotency-key": "tide-0001" })).json();
    const id = created.project.id;

    expect((await call(null, "GET", "/projects/tidewater")).status).toBe(404);
    expect((await call(dee, "GET", "/projects/tidewater")).status).toBe(200);
    expect((await call(await newIdentity("eve@unc.edu"), "GET", `/projects/${id}`)).status).toBe(404);

    // Declared EARLY_REVENUE, but only a launched product is evidenced: priced as LAUNCHED.
    await addClaim(id, dee, "product_status", { text: "launched" }, "FOUNDER_ATTESTED");
    const preview = await call(dee, "POST", `/projects/${id}/valuation/preview`);
    expect(preview.status).toBe(200);
    const valuation = await preview.json();
    expect(valuation.stage).toEqual({ declared: "EARLY_REVENUE", effective: "LAUNCHED", claim_ids: [expect.any(String)] });
    expect(valuation.modelVersion).toEqual({ id: "valuation-v0.1", status: "DRAFT" });
    expect(valuation.values.unitPrice).toMatch(/^\d+\.\d{6}$/);
    expect(BigInt(valuation.values.unitPriceMicroUsd)).toBe(BigInt(valuation.values.roundImplied.split(".")[0]));
    expect(valuation.snapshot.reused).toBe(false);

    // Same inputs: the latest snapshot is reused, not duplicated.
    const again = await (await call(dee, "POST", `/projects/${id}/valuation/preview`)).json();
    expect(again.snapshot).toMatchObject({ id: valuation.snapshot.id, reused: true });
    const counts = await db.query(`select (select count(*)::int from valuation_snapshots where project_id = $1) v, (select count(*)::int from score_snapshots where project_id = $1) s`, [id]);
    expect(counts.rows[0]).toEqual({ v: 1, s: 1 });
    const stored = await db.query(`select declared_stage::text, effective_stage::text, unit_price_micro_usd::text from valuation_snapshots where project_id = $1`, [id]);
    expect(stored.rows[0]).toEqual({ declared_stage: "EARLY_REVENUE", effective_stage: "LAUNCHED", unit_price_micro_usd: valuation.values.unitPriceMicroUsd });

    // New evidence → a new snapshot.
    await addClaim(id, dee, "active_users", { numeric: "800" }, "PUBLIC_WEAK");
    const third = await (await call(dee, "POST", `/projects/${id}/valuation/preview`)).json();
    expect(third.snapshot.reused).toBe(false);

    expect((await call(dee, "POST", `/projects/${id}/publish`)).status).toBe(200);
    const pub = await call(null, "GET", "/projects/tidewater");
    expect(pub.status).toBe(200);
    const { project: profile } = await pub.json();
    expect(profile.id).toBeUndefined();
    expect(profile).toMatchObject({
      name: "Tidewater",
      tagline: "Quiet study rooms at 2 a.m.",
      contact_email: "dee@unc.edu",
      founders: [{ display_name: "Ana Ruiz", role_title: "CEO", role: "FOUNDER" }],
      valuation: { effective_stage: "LAUNCHED", unit_price_micro_usd: third.values.unitPriceMicroUsd },
    });
    expect(JSON.stringify(profile)).not.toMatch(/active_users|source_quote|claim_id/);
    // M§10.4 explanation: weights, scores, confidence, scenarios, blend, and demand from the snapshot.
    const explanation = profile.valuation.explanation;
    expect(explanation).toMatchObject({ model_status: "DRAFT", demand: { multiplier: 1 }, alpha: expect.any(Number) });
    expect(explanation.scenarios).toHaveLength(4);
    expect(explanation.categories.traction).toEqual({ score: expect.any(Number), weight: expect.any(Number), contribution: expect.any(Number) });
    expect(explanation.subfactors.find((f: { subfactor: string }) => f.subfactor === "user_validation")).toMatchObject({ c: 0.65, status: "PUBLIC_WEAK" });
    expect(Object.keys(explanation.factor_weights).sort()).toEqual(["economics", "execution", "market", "product", "traction"]);
  });

  it("lists only published projects, with their latest price and current round", async () => {
    const lister = await newIdentity("lister@unc.edu");
    const draft = await (await call(lister, "POST", "/projects", project({ name: "Kiln Draft" }), { "idempotency-key": "kiln-0001" })).json();
    const res = await call(null, "GET", "/projects");
    expect(res.status).toBe(200);
    const { projects } = await res.json();
    const slugs = projects.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain("tidewater");
    expect(slugs).not.toContain(draft.project.slug);
    const tide = projects.find((p: { slug: string }) => p.slug === "tidewater");
    expect(tide).toMatchObject({ stage: "EARLY_REVENUE", valuation: { effective_stage: "LAUNCHED" }, round: null, founders: [{ display_name: "Ana Ruiz" }] });
    expect(tide.id).toBeUndefined();
    expect(JSON.stringify(projects)).not.toMatch(/@unc\.edu|founder_identity_id/);
  });

  it("omits the contact email when the founder opts out, and only editors may preview", async () => {
    const fay = await newIdentity("fay@unc.edu");
    const created = await (await call(fay, "POST", "/projects", project({ name: "Quillnote", publish_contact_email: false }), { "idempotency-key": "quil-0001" })).json();
    await call(fay, "POST", `/projects/${created.project.id}/publish`);
    expect((await (await call(null, "GET", "/projects/quillnote")).json()).project.contact_email).toBeNull();
    expect((await call(await newIdentity("gus@unc.edu"), "POST", `/projects/${created.project.id}/valuation/preview`)).status).toBe(404);
  });
});

describe("profile snapshots", () => {
  it("canonicalizes, replaces, erases on delete, and is only used for the founder's own projects", async () => {
    const hal = await newIdentity("hal@unc.edu");
    const saved = await call(hal, "POST", "/me/profile-snapshots", { profile_url: "linkedin.com/in/Hal-Kim/?trk=x", text: "Built Lanternly to 12,000 users." });
    expect(saved.status).toBe(400); // not an http(s) URL
    const ok = await call(hal, "POST", "/me/profile-snapshots", { profile_url: "https://linkedin.com/in/Hal-Kim/?trk=x", text: "Built Lanternly to 12,000 users." });
    expect(ok.status).toBe(201);
    expect((await ok.json()).snapshot.profile_url).toBe("https://www.linkedin.com/in/hal-kim");
    const replaced = await call(hal, "POST", "/me/profile-snapshots", { profile_url: "https://www.linkedin.com/in/hal-kim", text: "Built Lanternly to 15,000 users." });
    const { snapshot } = await replaced.json();
    const list = await (await call(hal, "GET", "/me/profile-snapshots")).json();
    expect(list.snapshots.map((s: { text: string }) => s.text)).toEqual(["Built Lanternly to 15,000 users."]);
    const erased = await db.query(`select count(*)::int as n from profile_snapshots where identity_id = $1 and deleted_at is not null and text is null`, [hal]);
    expect(erased.rows[0]).toEqual({ n: 1 });

    const own = await (await call(hal, "POST", "/projects", project({ name: "Lanternly Two" }), { "idempotency-key": "hal-00001" })).json();
    const other = await (await call(await newIdentity("ivy@unc.edu"), "POST", "/projects", project({ name: "Unrelated" }), { "idempotency-key": "ivy-00001" })).json();
    expect(await dbProfileSnapshotLookup(pool, own.project.id)("https://linkedin.com/in/HAL-KIM")).toMatchObject({ text: "Built Lanternly to 15,000 users." });
    expect(await dbProfileSnapshotLookup(pool, other.project.id)("https://linkedin.com/in/hal-kim")).toBeNull();

    expect((await call(await newIdentity("jo@unc.edu"), "DELETE", `/me/profile-snapshots/${snapshot.id}`)).status).toBe(404);
    expect((await call(hal, "DELETE", `/me/profile-snapshots/${snapshot.id}`)).status).toBe(204);
    expect(await dbProfileSnapshotLookup(pool, own.project.id)("https://linkedin.com/in/hal-kim")).toBeNull();
    const row = await db.query(`select text, content_hash from profile_snapshots where id = $1`, [snapshot.id]);
    expect(row.rows[0]).toEqual({ text: null, content_hash: null });
  });
});

describe("tickers", () => {
  it("suggests from the name, accepts a founder pick, rejects duplicates, and lists the caller's projects", async () => {
    const jo = await newIdentity("jo@gmail.com");
    const suggest = await (await call(null, "GET", "/tickers/suggest?name=Quippy&ticker=qpy")).json();
    expect(suggest).toMatchObject({ suggestion: "QPY", ticker: "QPY", available: true });

    const picked = await call(jo, "POST", "/projects", project({ name: "Quippy", ticker: "qpy" }), { "idempotency-key": "ticker-0001" });
    expect(picked.status).toBe(201);
    expect((await picked.json()).project.ticker).toBe("QPY");
    expect((await (await call(null, "GET", "/tickers/suggest?name=Quippy&ticker=QPY")).json())).toMatchObject({ available: false, suggestion: "QUIP" });

    const taken = await call(jo, "POST", "/projects", project({ name: "Quippy Two", ticker: "QPY" }), { "idempotency-key": "ticker-0002" });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error.code).toBe("TICKER_TAKEN");

    const auto = await call(jo, "POST", "/projects", project({ name: "Moonlight" }), { "idempotency-key": "ticker-0003" });
    expect((await auto.json()).project.ticker).toBe("MNL");
    expect((await call(jo, "POST", "/projects", project({ name: "x", ticker: "TOOLONG" }), { "idempotency-key": "ticker-0004" })).status).toBe(400);

    const mine = await (await call(jo, "GET", "/me/projects")).json();
    expect(mine.projects.map((p: { ticker: string }) => p.ticker).sort()).toEqual(["MNL", "QPY"]);
    expect((await call(null, "GET", "/me/projects")).status).toBe(401);
  });
});

describe("auto-assigned tickers (Gemini picks, stored once)", () => {
  it("uses the model's first free pick, skips taken ones, and falls back when the model fails", async () => {
    const mo = await newIdentity("mo@gmail.com");
    namer = async () => ["LUNA", "MOON"];
    const first = await (await call(mo, "POST", "/projects", project({ name: "Moonlight" }), { "idempotency-key": "auto-0001" })).json();
    expect(first.project.ticker).toBe("LUNA");
    const second = await (await call(mo, "POST", "/projects", project({ name: "Moonlight Two" }), { "idempotency-key": "auto-0002" })).json();
    expect(second.project.ticker).toBe("MOON");
    namer = async () => { throw new Error("timeout"); };
    const third = await (await call(mo, "POST", "/projects", project({ name: "Quibble" }), { "idempotency-key": "auto-0003" })).json();
    expect(third.project.ticker).toBe("QBL");
    namer = async () => [];
  });
});
