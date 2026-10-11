"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  api, ApiError, formatUnitPrice, post, STAGE_LABEL,
  type Me, type ResearchProposal, type ResearchRun, type Stage, type ValuationPreview,
} from "@/lib/api";

/*
 * /launch after the interview: the founder flow against the API (M§7.2).
 *   session check → POST /projects → research run (poll) → founder review → confirm →
 *   valuation preview (backend prices it) → publish.
 * The browser never computes a price. Progress is kept in sessionStorage so a refresh resumes the
 * same project instead of creating a second one (POST /projects is also idempotent per key).
 */

export type LaunchDraft = {
  name: string; tagline: string; stage: Stage; entityType: "UNINCORPORATED" | "INCORPORATED";
  legalName: string | null; formationState: string | null; website: string | null;
  founderName: string; founderRole: string | null; founderText: string | null; links: string[]; publishContact: boolean;
};

type Phase = "session" | "create" | "research" | "review" | "pricing" | "priced" | "publishing" | "published" | "failed";
type Saved = { key: string; sig?: string; projectId?: string; slug?: string; runId?: string; confirmed?: boolean; published?: boolean };

const STORE = "prospecto:launch";
const POLL_MS = 3000, POLL_LIMIT = 120; // about 6 minutes; the backend fails stale runs after 5
const load = (): Saved | null => { try { return JSON.parse(sessionStorage.getItem(STORE) ?? "null"); } catch { return null; } };
const save = (s: Saved) => { try { sessionStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode: no resume */ } };
const words = (code: string) => code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const STATUS: Record<string, string> = {
  INDEPENDENTLY_VERIFIED: "Verified", REVIEWER_VERIFIED: "Reviewer verified", PUBLIC_WEAK: "Public source",
  FOUNDER_ATTESTED: "Your statement", AI_ASSESSED: "AI assessed", MISSING_OR_CONTRADICTED: "Contradicted",
};

export default function LaunchPipeline({ draft, onEdit, onRetry }: { draft: LaunchDraft; onEdit: () => void; onRetry: () => void }) {
  const [phase, setPhase] = useState<Phase>("session");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [price, setPrice] = useState<ValuationPreview | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  // Resume only the same answers; a different company in this tab starts a new project.
  const sig = JSON.stringify(draft);
  const saved = useRef<Saved>({ key: crypto.randomUUID(), sig });
  const alive = useRef(true);
  const started = useRef(false);

  const fail = (e: unknown) => {
    if (!alive.current) return;
    setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    setPhase("failed");
  };
  const remember = (patch: Partial<Saved>) => { saved.current = { ...saved.current, ...patch }; save(saved.current); };

  async function poll(projectId: string, runId: string): Promise<ResearchRun> {
    for (let i = 0; i < POLL_LIMIT && alive.current; i++) {
      const { run } = await api<{ run: ResearchRun }>(`/projects/${projectId}/research-runs/${runId}`);
      if (alive.current) setRun(run);
      if (run.status !== "QUEUED" && run.status !== "RUNNING") return run;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new ApiError(0, "TIMEOUT", "Research is taking too long. Try again in a minute.");
  }

  async function priceIt(projectId: string) {
    setPhase("pricing");
    const preview = await post<ValuationPreview>(`/projects/${projectId}/valuation/preview`);
    if (!alive.current) return;
    setPrice(preview); setPhase("priced");
  }

  // Runs once per mount: resumes a saved project for this draft, or starts a new one. React's dev
  // StrictMode replays effects; the ref keeps the flow from starting twice.
  useEffect(() => {
    alive.current = true;
    if (started.current) return () => { alive.current = false; };
    started.current = true;
    (async () => {
      try {
        await api<Me>("/me");
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setError("Sign in with your campus email to publish."); setPhase("failed"); return;
        }
        throw e;
      }
      const prior = load();
      if (prior?.projectId && prior.sig === sig) saved.current = prior;
      else save(saved.current);

      let { projectId, slug: s } = saved.current;
      if (!projectId) {
        setPhase("create");
        const { project } = await post<{ project: { id: string; slug: string } }>("/projects", {
          name: draft.name, tagline: draft.tagline, stage: draft.stage, entity_type: draft.entityType,
          legal_name: draft.legalName, formation_state: draft.formationState, website_url: draft.website,
          publish_contact_email: draft.publishContact,
          founder: { display_name: draft.founderName, role_title: draft.founderRole },
        }, saved.current.key);
        projectId = project.id; s = project.slug;
        remember({ projectId, slug: s });
      }
      setSlug(s ?? null);
      if (saved.current.published) { setPhase("published"); return; }
      if (saved.current.confirmed) { await priceIt(projectId); return; }

      setPhase("research");
      let runId = saved.current.runId;
      if (!runId) {
        // Cached server-side for 24 h per identical input, so a retry does not pay for a second run.
        const started = await post<{ runId: string }>(`/projects/${projectId}/research-runs`, {
          website_url: draft.website, urls: draft.links, founder_text: draft.founderText,
        });
        runId = started.runId;
        remember({ runId });
      }
      const done = await poll(projectId, runId);
      if (!alive.current) return;
      if (done.confirmed_at) { remember({ confirmed: true }); await priceIt(projectId); return; }
      setKeep(new Set((done.result?.proposals ?? []).filter((p) => p.droppable).map((p) => p.id)));
      setPhase("review");
    })().catch(fail);
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    const { projectId, runId } = saved.current;
    if (!projectId || !runId) return;
    try {
      setPhase("pricing");
      if (run?.result) await post(`/projects/${projectId}/research-runs/${runId}/confirm`, { accept: [...keep], dispute: [] });
      remember({ confirmed: true });
      await priceIt(projectId);
    } catch (e) {
      // Already confirmed (e.g. a double click): carry on to pricing.
      if (e instanceof ApiError && e.code === "ALREADY_CONFIRMED") { remember({ confirmed: true }); await priceIt(projectId).catch(fail); return; }
      fail(e);
    }
  }

  async function publish() {
    const { projectId } = saved.current;
    if (!projectId) return;
    try {
      setPhase("publishing");
      await post(`/projects/${projectId}/publish`);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "NOT_DRAFT")) { fail(e); return; }
    }
    remember({ published: true });
    if (alive.current) setPhase("published");
  }

  const startOver = () => { try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } onEdit(); };
  const proposals = run?.result?.proposals ?? [];

  return (
    <section className="done on pipe" aria-live="polite">
      <div>
        <span className="kicker">{draft.name} · {STAGE_LABEL[draft.stage]}</span>
        <ol className="steps">
          {(["create", "research", "review", "pricing", "published"] as const).map((p, i) => {
            const order = ["session", "create", "research", "review", "pricing", "priced", "publishing", "published"];
            const at = order.indexOf(phase === "failed" ? "session" : phase), mine = order.indexOf(p);
            return <li key={p} className={at > mine || phase === "published" ? "ok" : at === mine || (p === "pricing" && phase === "priced") ? "cur" : ""}>
              <span>{i + 1}</span>{["Create the profile", "Research the evidence", "Review what we found", "Price it", "Publish"][i]}
            </li>;
          })}
        </ol>
        {phase === "research" && (
          <p className="note">Reading your site and searching for independent coverage. This takes up to a minute{run?.status ? ` · ${words(run.status.toLowerCase())}` : ""}.</p>
        )}
      </div>

      <div>
        {phase === "failed" && (
          <>
            <h2>Not <i>yet.</i></h2>
            <p className="msg" role="alert">{error}</p>
            <div className="row">
              <button className="btn ghost" type="button" onClick={startOver}>← Edit answers</button>
              <button className="btn" type="button" onClick={onRetry}>Try again</button>
            </div>
          </>
        )}
        {(phase === "session" || phase === "create" || phase === "research" || phase === "pricing" || phase === "publishing") && (
          <h2>{phase === "pricing" ? "Pricing" : phase === "publishing" ? "Publishing" : phase === "research" ? "Researching" : "Saving"} <i>…</i></h2>
        )}
        {phase === "review" && (
          <>
            <h2>What we <i>found.</i></h2>
            {run?.status === "FAILED" ? <p className="msg">Research couldn’t finish ({run.error_code ?? "error"}). You can still price on what you told us.</p>
              : proposals.length === 0 ? <p className="msg">No evidence found yet. Missing factors count as neutral, not as failure.</p> : null}
            <ul className="found">
              {proposals.map((p: ResearchProposal) => (
                <li key={p.id}>
                  <label>
                    {p.droppable
                      ? <input type="checkbox" checked={keep.has(p.id)} onChange={(e) => { const k = new Set(keep); if (e.target.checked) k.add(p.id); else k.delete(p.id); setKeep(k); }} />
                      : <input type="checkbox" checked disabled aria-label="Independent evidence is always kept" />}
                    <b>{words(p.metric_code)}{p.subject ? ` (${p.subject})` : ""}: {p.value_text ?? Number(p.value_numeric).toLocaleString("en-US")}</b>
                  </label>
                  <span>{STATUS[p.status] ?? words(p.status)}{p.source_url && p.source_url !== "founder_text" ? ` · ${p.source_url.replace(/^https?:\/\//, "").slice(0, 60)}` : ""}</span>
                </li>
              ))}
            </ul>
            {proposals.some((p) => p.droppable) && <p className="note">Uncheck any statement of yours you’d rather leave out. Independent findings stay.</p>}
            <div className="row"><button className="btn go" type="button" onClick={confirm}>Confirm and price →</button></div>
          </>
        )}
        {(phase === "priced" || phase === "published") && price && (
          <>
            <h2>{phase === "published" ? <>You’re <i>live.</i></> : <>Your <i>price.</i></>}</h2>
            <div className="stats">
              <div><span>Unit price</span><b className="up">{formatUnitPrice(price.values.unitPriceMicroUsd)}</b></div>
              <div><span>Model value</span><b>${Math.round(Number(price.values.roundImplied)).toLocaleString("en-US")}</b></div>
              <div><span>Priced as</span><b>{STAGE_LABEL[price.stage.effective]}</b></div>
            </div>
            <p className="note">
              Quality score {price.scores.composite.toFixed(2)} from {price.explanationInputs.claimCount} piece{price.explanationInputs.claimCount === 1 ? "" : "s"} of evidence
              {price.stage.effective !== price.stage.declared ? `. Priced as ${STAGE_LABEL[price.stage.effective]} until evidence supports ${STAGE_LABEL[price.stage.declared]}` : ""}.
            </p>
            <div className="row">
              {phase === "priced"
                ? <button className="btn go" type="button" onClick={publish}>Publish →</button>
                : <>{slug && <Link className="btn go" href={`/project/?slug=${slug}`}>See your profile →</Link>}<button className="btn ghost" type="button" onClick={startOver}>List another</button></>}
            </div>
          </>
        )}
        {phase === "published" && !price && slug && (
          <>
            <h2>You’re <i>live.</i></h2>
            <div className="row"><Link className="btn go" href={`/project/?slug=${slug}`}>See your profile →</Link><button className="btn ghost" type="button" onClick={startOver}>List another</button></div>
          </>
        )}
        {phase === "published" && <p className="note"><Link href={`/participate/?project=${saved.current.projectId}`}>Connect your wallet, create receipts, and open your round →</Link></p>}
      </div>
    </section>
  );
}
