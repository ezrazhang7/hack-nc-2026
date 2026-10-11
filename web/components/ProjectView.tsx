"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import FounderCards from "@/components/FounderCards";
import HeroText from "@/components/HeroText";
import {
  committedPct, daysLeft, formatMicroUsd, formatUnitPrice, formatUsdCompact, getProject, STAGE_LABEL,
  type Explanation, type ProjectProfile,
} from "@/lib/api";

/*
 * Startup profile (MARKET ARCHITECTURE §1) with the price explanation §10.4 requires: stage and
 * baseline, factor scores with weights, verification confidence, scenario probabilities, the blend,
 * the demand adjustment, and the model version and timestamp. Every number is the backend's
 * stored snapshot; nothing is recomputed here.
 */

const words = (code: string) => code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const CATEGORY_ORDER = ["execution", "market", "product", "traction", "economics"] as const;
const STATUS_LABEL: Record<string, string> = {
  INDEPENDENTLY_VERIFIED: "Independently verified", REVIEWER_VERIFIED: "Reviewer verified", PUBLIC_WEAK: "Public source",
  FOUNDER_ATTESTED: "Founder stated", AI_ASSESSED: "AI assessed", MISSING_OR_CONTRADICTED: "Contradicted",
};

function PriceChain({ v, x }: { v: NonNullable<ProjectProfile["valuation"]>; x: Explanation }) {
  return (
    <ol className="chain">
      <li><span>Scenario value</span><b>{formatUsdCompact(v.scenario_value)}</b><em>Probability-weighted present value of four 5-year outcomes</em></li>
      <li><span>Current operating value</span><b>{formatUsdCompact(v.current_operating_value)}</b>
        <em>{x.operating.arr ? `Verified ARR ${formatUsdCompact(x.operating.arr)} × ${x.operating.revenue_multiple}` : "No verified revenue yet, so this is $0"}</em></li>
      <li><span>Blend</span><b>{pct(x.alpha)} / {pct(1 - x.alpha)}</b><em>{pct(x.alpha)} operating value, {pct(1 - x.alpha)} scenario value at this stage</em></li>
      <li><span>Model value</span><b>{formatUsdCompact(v.model_reference_value)}</b><em>The blend of the two values above</em></li>
      <li><span>Demand adjustment</span><b>× {x.demand.multiplier.toFixed(2)}</b>
        <em>{x.demand.score === null ? "No finished round yet, so demand is neutral" : `From the last round’s demand score ${x.demand.score.toFixed(2)}${x.demand.clamped ? ", capped" : ""}`}</em></li>
      <li className="tot"><span>Unit price</span><b>{formatMicroUsd(v.unit_price_micro_usd, 6)}</b>
        <em>{formatUsdCompact(v.round_implied_value)} ÷ {Number(v.reference_units).toLocaleString("en-US")} reference units, rounded down</em></li>
    </ol>
  );
}

function Scores({ v, x }: { v: NonNullable<ProjectProfile["valuation"]>; x: Explanation }) {
  return (
    <table className="scores">
      <thead><tr><th>Factor</th><th>Weight</th><th>Score</th><th>Evidence</th></tr></thead>
      <tbody>
        {CATEGORY_ORDER.map((cat) => {
          const c = x.categories[cat];
          if (!c) return null;
          const subs = x.subfactors.filter((s) => x.factor_weights[cat]?.[s.subfactor] !== undefined);
          return (
            <Fragment key={cat}>
              <tr className="cat"><td>{words(cat)}</td><td>{pct(c.weight)}</td><td>{c.score.toFixed(2)}</td><td>adds {c.contribution.toFixed(3)} to Q</td></tr>
              {subs.map((s) => (
                <tr key={s.subfactor} className={s.s === null ? "sub none" : "sub"}>
                  <td>{words(s.subfactor)}</td>
                  <td>{pct(x.factor_weights[cat][s.subfactor])}</td>
                  <td>{s.adjusted.toFixed(2)}</td>
                  <td>{s.status ? `${STATUS_LABEL[s.status] ?? words(s.status)} · ${pct(s.c)} confidence` : s.subfactor === "evidence_quality" && s.s !== null ? "Computed from all evidence" : "No evidence · neutral 0.50"}</td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot><tr><td>Quality score Q</td><td>100%</td><td>{v.scores.composite.toFixed(3)}</td><td>Shifts the scenario odds below</td></tr></tfoot>
    </table>
  );
}

function Scenarios({ x }: { x: Explanation }) {
  return (
    <table className="scen">
      <thead><tr><th>Outcome in 5 years</th><th>Stage baseline</th><th>After Q</th><th>Company value</th><th>Value today</th></tr></thead>
      <tbody>
        {x.scenarios.map((s) => (
          <tr key={s.scenario}>
            <td>{words(s.scenario)}</td><td>{pct(s.baseline_probability)}</td><td>{pct(s.probability, 1)}</td>
            <td>{s.terminal_enterprise_value ? formatUsdCompact(s.terminal_enterprise_value) : "$0"}</td>
            <td>{s.present_value ? formatUsdCompact(s.present_value) : "$0"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ProjectView() {
  const slug = useSearchParams().get("slug") ?? "";
  const [p, setP] = useState<ProjectProfile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setP(undefined); setError(null);
    if (!slug) { setP(null); return; }
    getProject(slug).then(setP, (e: { status?: number; message: string }) => { if (e.status !== 404) setError(e.message); setP(null); });
  }, [slug]);

  if (p === undefined) return <div className="head"><span className="kicker">Loading…</span></div>;
  if (!p) {
    return (
      <div className="head">
        <HeroText text="No company" em="here." />
        {error && <span className="kicker">{error}</span>}
        <Link className="btn" href="/rounds/">Back a startup →</Link>
      </div>
    );
  }

  const v = p.valuation, x = v?.explanation ?? null, r = p.round;
  const priced = v && v.effective_stage !== v.declared_stage;
  const open = r && (r.status === "OPEN" || r.status === "SCHEDULED");
  const sub = r ? committedPct(r) : 0, left = r ? daysLeft(r) : 0;
  return (
    <>
      <div className="head">
        <HeroText key={p.slug} text={p.name} />
        <span className="kicker">{STAGE_LABEL[p.stage]} · {p.entity_type === "INCORPORATED" ? "Incorporated" : "Unincorporated"}</span>
      </div>

      <section className="lede">
        <div>
          <h2>{p.tagline || p.name}</h2>
          {p.description && <p>{p.description}</p>}
          <dl className="facts">
            {p.legal_name && <div><dt>Legal name</dt><dd>{p.legal_name}{p.formation_state ? ` · ${p.formation_state}` : ""}</dd></div>}
            {p.website_url && <div><dt>Website</dt><dd><a href={p.website_url} target="_blank" rel="noopener noreferrer">{p.website_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a></dd></div>}
            {p.contact_email && <div><dt>Contact</dt><dd><a href={`mailto:${p.contact_email}`}>{p.contact_email}</a></dd></div>}
            <div><dt>Stage</dt><dd>{STAGE_LABEL[p.stage]}{priced ? ` · priced as ${STAGE_LABEL[v.effective_stage]}` : ""}</dd></div>
          </dl>
        </div>
        <aside className="ticket">
          <span className="kicker">Unit price</span>
          <b className="px">{v ? formatUnitPrice(v.unit_price_micro_usd) : "—"}</b>
          {v && <span className="mv">Model value {formatUsdCompact(v.round_implied_value)}</span>}
          {r ? (
            <>
              <div className={`bar${sub >= 100 ? " full" : ""}`}><i style={{ width: `${Math.min(sub, 100)}%` }} /></div>
              <div className="rt">
                <span>{formatMicroUsd(r.total_committed_micro_usd, 0)} of {formatMicroUsd(r.target_amount_micro_usd, 0)}</span>
                <span>{sub >= 100 ? <b className="dn">Full</b> : `${sub}%`}{left > 0 && ` · ${left}d left`}</span>
              </div>
              <Link className="btn go" href={`/round/?slug=${p.slug}`}>{open && sub < 100 ? `Back ${p.name}` : "See the round"} →</Link>
            </>
          ) : <p className="none">No round open yet.</p>}
        </aside>
      </section>

      {v && x && (
        <section className="why" aria-labelledby="why">
          <div className="sec-head"><h2 id="why">Why this price?</h2><span className="kicker">{v.model_version_id} · {new Date(v.calculated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div>
          <PriceChain v={v} x={x} />
          <h3>Scenarios</h3>
          <p className="cap">The stage sets baseline odds for each outcome. The quality score Q moves them.</p>
          <Scenarios x={x} />
          <h3>Quality score</h3>
          <p className="cap">Weights for the {STAGE_LABEL[v.effective_stage].toLowerCase()} stage. Each score blends the evidence with a neutral 0.50, by how well it is verified.</p>
          <Scores v={v} x={x} />
          <p className="audit mono">model {v.model_hash.slice(0, 12)}… · evidence {v.evidence_root.slice(0, 12)}…</p>
        </section>
      )}

      {p.founders.length > 0 && (
        <FounderCards company={p.name} founders={p.founders.map((f) => ({ n: f.display_name, r: f.role_title ?? "Founder" }))} demo={false} />
      )}
      <div className="foot"><Link href="/rounds/">← Back a startup</Link><Link href="/how/">How pricing works →</Link></div>
    </>
  );
}
