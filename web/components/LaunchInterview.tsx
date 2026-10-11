"use client";

import { useEffect, useRef, useState } from "react";
import LaunchPipeline, { type LaunchDraft } from "@/components/LaunchPipeline";
import { STAGE_LABEL, STAGES } from "@/lib/api";

type Field = { k: string; l?: string; ph: string; type?: string; area?: boolean };
type Step = { k: string; sec: string; q: [string, string]; fields?: Field[]; opts?: string[]; hint?: string; req?: boolean; when?: (d: Data) => boolean };

// Answers map one-to-one onto POST /api/projects and the research run (docs/BACKEND_STACK.md §7).
const STEPS: Step[] = [
  { k: "name", sec: "Identity", q: ["What’s it", "called?"], fields: [{ k: "name", ph: "Mothlight" }], hint: "A working title is fine.", req: true },
  { k: "line", sec: "Identity", q: ["Say it in", "one line."], fields: [{ k: "line", ph: "Quiet study rooms at 2 a.m." }], req: true },
  { k: "stage", sec: "Stage", q: ["How far", "along is it?"], opts: STAGES.map((s) => STAGE_LABEL[s]), hint: "We price on the stage your evidence supports.", req: true },
  { k: "entity", sec: "Stage", q: ["Is it", "incorporated?"], opts: ["Unincorporated", "Incorporated"], hint: "Either is fine. We label it honestly.", req: true },
  { k: "legal", sec: "Stage", q: ["What’s the", "legal name?"], fields: [{ k: "legal", l: "Legal name", ph: "Mothlight, Inc." }, { k: "state", l: "State of formation", ph: "NC" }], when: (d) => d.entity === "Incorporated" },
  { k: "site", sec: "Web", q: ["Where can backers", "see it?"], fields: [{ k: "site", ph: "https://mothlight.app", type: "url" }], hint: "No site? A Notion, Figma or demo link works." },
  { k: "founder", sec: "Founders", q: ["Who’s", "building it?"], fields: [{ k: "fname", l: "Name", ph: "Ana Ruiz" }, { k: "role", l: "Role", ph: "CEO" }], req: true },
  { k: "proof", sec: "Evidence", q: ["What have you", "shown so far?"], fields: [{ k: "proof", l: "In your own words", ph: "40 student interviews, 120 on the waitlist, beta live since May…", area: true }, { k: "links", l: "Links · one per line", ph: "https://github.com/…", area: true }], hint: "Numbers help. We check what we can against public sources." },
  { k: "contact", sec: "Contact", q: ["Show your email", "on the profile?"], opts: ["Publish it", "Keep it private"], req: true },
];

type Data = Record<string, string>;
const ANSWERS = "prospecto:launch-answers";
const summary = (s: Step, d: Data) => (s.fields ? s.fields.map((f) => d[f.k]).filter(Boolean).join(" · ") : d[s.k] ?? "");
const visible = (d: Data) => STEPS.filter((s) => !s.when || s.when(d));
const toDraft = (d: Data): LaunchDraft => {
  const incorporated = d.entity === "Incorporated";
  const text = (v?: string) => v?.trim() || null;
  return {
    name: d.name.trim(), tagline: (d.line ?? "").trim().slice(0, 140),
    stage: STAGES.find((s) => STAGE_LABEL[s] === d.stage) ?? "IDEA",
    entityType: incorporated ? "INCORPORATED" : "UNINCORPORATED",
    legalName: incorporated ? text(d.legal) : null, formationState: incorporated ? text(d.state)?.toUpperCase() ?? null : null,
    website: text(d.site), founderName: d.fname.trim(), founderRole: text(d.role),
    founderText: text(d.proof), links: (d.links ?? "").split(/\s+/).filter(Boolean).slice(0, 10),
    publishContact: d.contact !== "Keep it private",
  };
};

export default function LaunchInterview() {
  const [data, setData] = useState<Data>({});
  const [cur, setCur] = useState(0);
  const [phase, setPhase] = useState<"" | "out" | "in">("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const firstInput = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const steps = visible(data);
  const step = steps[Math.min(cur, steps.length - 1)];

  useEffect(() => { firstInput.current?.focus({ preventScroll: true }); }, [cur, done]);
  // Keep answers for this tab so signing in elsewhere and coming back does not lose them.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(ANSWERS) ?? "null");
      if (saved && typeof saved.data === "object") { setData(saved.data); setDone(saved.done === true); }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { sessionStorage.setItem(ANSWERS, JSON.stringify({ data, done })); } catch { /* private mode */ } }, [data, done]);

  // Slide the question out, swap, slide the next one in.
  const go = (i: number) => {
    setErr("");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setCur(i); return; }
    setPhase("out");
    setTimeout(() => {
      setCur(i); setPhase("in");
      requestAnimationFrame(() => requestAnimationFrame(() => setPhase("")));
    }, 220);
  };
  const next = (d: Data = data, skip = false) => {
    if (!skip && step.req && !summary(step, d)) { setErr("Needed to publish."); return; }
    if (!skip && step.k === "founder" && !d.fname?.trim()) { setErr("Add the founder’s name."); return; }
    if (!skip && step.k === "legal" && d.state && !/^[A-Za-z]{2}$/.test(d.state.trim())) { setErr("Use the two-letter state code, like NC."); return; }
    if (!skip && step.k === "site" && d.site && !/^https?:\/\/\S+\.\S+/.test(d.site.trim())) { setErr("Use a full link starting with https://"); return; }
    const all = visible(d);
    if (cur < all.length - 1) go(cur + 1); else setDone(true);
  };
  const pick = (v: string) => { const d = { ...data, [step.k]: v }; setData(d); next(d); };

  if (done) return <LaunchPipeline key={attempt} draft={toDraft(data)} onEdit={() => { setDone(false); go(0); }} onRetry={() => setAttempt((a) => a + 1)} />;

  return (
    <section className="desk">
      <aside className="nb">
        <span className="kicker">Your answers</span>
        {steps.map((s, i) => {
          const v = summary(s, data);
          return (
            <button key={s.k} type="button" className={`${!v && i !== cur ? "todo" : ""} ${i === cur ? "cur" : ""}`} onClick={() => go(i)}>
              <span>{s.sec}</span><b>{v || "—"}</b>
            </button>
          );
        })}
      </aside>
      <div className="stage">
        <div className="folio"><span>Question {cur + 1} of {steps.length}</span><span>{step.sec}</span></div>
        <div className="dots">{steps.map((s, i) => <i key={s.k} className={i <= cur ? "on" : ""} />)}</div>
        <form className={`q ${phase}`} noValidate onSubmit={(e) => { e.preventDefault(); next(); }}>
          <h2>{step.q[0]} <i>{step.q[1]}</i></h2>
          {step.opts ? (
            <div className="opts">
              {step.opts.map((o) => <button key={o} type="button" aria-pressed={data[step.k] === o} onClick={() => pick(o)}>{o}</button>)}
            </div>
          ) : (
            step.fields!.map((f, fi) => (
              <div key={f.k}>
                {f.l && <label htmlFor={`f-${f.k}`}>{f.l}</label>}
                {f.area ? (
                  <textarea
                    id={`f-${f.k}`} ref={fi === 0 ? firstInput : undefined} name={f.k} placeholder={f.ph} rows={3} maxLength={f.k === "proof" ? 20000 : 4000}
                    aria-label={f.l ?? step.sec} value={data[f.k] ?? ""}
                    onChange={(e) => setData({ ...data, [f.k]: e.target.value })}
                  />
                ) : (
                  <input
                    id={`f-${f.k}`} ref={fi === 0 ? firstInput : undefined} name={f.k} type={f.type ?? "text"} placeholder={f.ph}
                    aria-label={f.l ?? step.sec} value={data[f.k] ?? ""}
                    onChange={(e) => setData({ ...data, [f.k]: e.target.value })}
                  />
                )}
              </div>
            ))
          )}
          {step.hint && <p className="hint">{step.hint}</p>}
          <p className="err" role="alert">{err}</p>
          <button type="submit" hidden />
        </form>
        <div className="acts">
          <button className="btn ghost" type="button" style={{ visibility: cur ? "visible" : "hidden" }} onClick={() => cur && go(cur - 1)}>← Back</button>
          <span className="enter">Press <kbd>Enter ↵</kbd></span>
          <span className="row">
            {!step.req && <button className="btn ghost" type="button" onClick={() => next(data, true)}>Skip</button>}
            <button className="btn go" type="button" onClick={() => next()}>Next →</button>
          </span>
        </div>
      </div>
    </section>
  );
}
