"use client";

import Link from "next/link";
import { investHref } from "@/lib/routes";
import { useEffect } from "react";

/*
 * The Estimate Desk (/desk/): stage buttons and score sliders drive an eased price readout.
 * Moved from the landing page. Generated nodes are tagged data-gen and removed on cleanup.
 */

// Demo anchors from MEGA_PLAN §10 — illustrative only; not the server valuation model.
const ANCHOR = { IDEA: 100000, PROTOTYPE: 500000, LAUNCHED: 1000000, REVENUE: 2000000, GROWTH: 5000000 } as const;
type Stage = keyof typeof ANCHOR;

const FORMULA = '<span class="c"># illustrative sketch · not the valuation-v0.1 model, not market data</span>\nscore      = <span class="k">0.30</span>·product + <span class="k">0.30</span>·traction\n           + <span class="k">0.25</span>·team    + <span class="k">0.15</span>·financial\nmultiplier = 0.50 + score / 100\nanchor     = stage_anchor × multiplier\nband       = [anchor × 0.60, anchor × 1.50]\nunit_price = anchor / founder_units';

const fmt$ = (n: number, d = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const $ = (id: string) => document.getElementById(id) as HTMLElement;

export default function EstimateDesk() {
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: (() => void)[] = [];
    document.querySelectorAll("[data-gen]").forEach((n) => n.remove());

    const STAGES = Object.keys(ANCHOR) as Stage[];
    const CATS = [
      { k: "product", l: "Product", w: 0.3, h: ["No milestone evidence", "Milestone described", "Working demo for your stage", "Demo tested with intended users", "Repeated milestones, with evidence"] },
      { k: "traction", l: "Traction", w: 0.3, h: ["No validation yet", "Informal conversations", "Documented interviews or pilot", "Repeat use or committed pilots", "Multiple corroborated sources"] },
      { k: "team", l: "Team", w: 0.25, h: ["No information", "Roles and availability described", "Relevant experience, named owners", "Prior relevant delivery", "Complementary and fully committed"] },
      { k: "financial", l: "Financial readiness", w: 0.15, h: ["No usable inputs", "Business model described", "Consistent assumptions supplied", "Dated budget and runway", "Documented, with scenarios"] },
    ] as const;
    // Sliders are continuous 0–100 scores; the hint shows the nearest rubric level.
    const state: { stage: Stage } & Record<(typeof CATS)[number]["k"], number> = { stage: "IDEA", product: 50, traction: 25, team: 50, financial: 25 };
    const stagesEl = $("stages"), slidersEl = $("sliders");
    STAGES.forEach((s) => {
      const b = document.createElement("button"); b.textContent = s; b.setAttribute("aria-pressed", String(s === state.stage)); b.dataset.gen = "";
      b.onclick = () => { state.stage = s; [...stagesEl.children].forEach((x) => x.setAttribute("aria-pressed", String(x === b))); calc(); };
      stagesEl.appendChild(b);
    });
    CATS.forEach((c) => {
      const d = document.createElement("div"); d.className = "sl"; d.dataset.gen = "";
      d.innerHTML = `<label for="r-${c.k}">${c.l} · ${Math.round(c.w * 100)}% <b id="v-${c.k}"></b></label><input type="range" id="r-${c.k}" min="0" max="100" step="0.5" value="${state[c.k]}"><div class="hint" id="h-${c.k}"></div>`;
      slidersEl.appendChild(d);
      d.querySelector("input")!.addEventListener("input", (e) => { state[c.k] = +(e.target as HTMLInputElement).value; calc(); });
    });

    // One eased loop drives the price, unit, raise, range band and marker together, so dragging
    // and stage switches glide instead of jumping. `max` (band scale) eases too.
    const tgt = { a: 0, max: 0 }, cur = { a: 0, max: 0 };
    let raf = 0, last = 0;
    const render = () => {
      const { a, max } = cur, lo = a * 0.6, hi = a * 1.5, pc = (v: number) => (v / max * 100) + "%";
      const unit = Math.round(a / 1e6 * 100) / 100;
      $("est").textContent = fmt$(Math.round(a / 100) * 100);
      $("unit").textContent = fmt$(unit, 2);
      $("raise").textContent = fmt$(Math.round(unit * 100000));
      $("lo").textContent = "Low " + fmt$(Math.round(lo / 100) * 100);
      $("hi").textContent = "High " + fmt$(Math.round(hi / 100) * 100);
      const rng = $("rng"); rng.style.left = pc(lo); rng.style.width = `calc(${pc(hi)} - ${pc(lo)})`;
      $("est-pin").style.left = pc(a);
    };
    const frame = (t: number) => {
      const k = 1 - Math.pow(0.8, Math.min(64, t - last) / 16.7); last = t; // ~20% per 60fps frame
      cur.a += (tgt.a - cur.a) * k; cur.max += (tgt.max - cur.max) * k;
      const settled = Math.abs(tgt.a - cur.a) < 1 && Math.abs(tgt.max - cur.max) < 1;
      if (settled) { cur.a = tgt.a; cur.max = tgt.max; }
      render();
      raf = settled ? 0 : requestAnimationFrame(frame);
    };
    cleanups.push(() => cancelAnimationFrame(raf));
    function calc() {
      let score = 0;
      CATS.forEach((c) => {
        const v = state[c.k]; score += c.w * v;
        $("v-" + c.k).textContent = String(Math.round(v));
        $("h-" + c.k).textContent = c.h[Math.min(4, Math.round(v / 25))];
      });
      $("score").textContent = score.toFixed(1);
      tgt.a = ANCHOR[state.stage] * (0.5 + score / 100);
      tgt.max = ANCHOR[state.stage] * 1.5 * 1.5;
      if (!cur.max) cur.max = tgt.max; // first paint: band scale in place, price counts up from 0
      if (reduce) { cur.a = tgt.a; cur.max = tgt.max; render(); return; }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }
    calc();

    return () => { cleanups.forEach((f) => f()); document.querySelectorAll("[data-gen]").forEach((n) => n.remove()); };
  }, []);

  return (
    <section className="desk">
      <div className="desk-l">
        <div className="stages" role="group" aria-label="Stage" id="stages"></div>
        <div className="sliders" id="sliders"></div>
        <div className="result" aria-live="polite">
          <div className="kicker">Suggested pre-money anchor</div>
          <div className="big" id="est">$1,000,000</div>
          <div className="band" aria-hidden="true"><div className="axis"></div><div className="rng" id="rng"></div><div className="est-pin" id="est-pin"></div></div>
          <div className="band-l"><span id="lo">Low $600,000</span><span id="hi">High $1,500,000</span></div>
          <div className="facts">
            <div><span>Score</span><b id="score">50.0</b></div>
            <div><span>Unit price</span><b id="unit">$1.00</b></div>
            <div><span>Raise at 10% cap</span><b id="raise">$100,000</b></div>
          </div>
        </div>
      </div>
      <div className="desk-r">
        <div className="kicker">Clipping · The formula, in full</div>
        <div className="clip"><pre dangerouslySetInnerHTML={{ __html: FORMULA }} /></div>
        <p className="note">This desk is a sketch to play with. The real model starts missing evidence at a neutral 0.50, so a new founder is never scored down for having no record; only verified proof moves it further.</p>
        <div className="advert">
          <span className="kicker">Advertisement · for your website</span>
          <h3>Paste one line.<br />Meet your first backers.</h3>
          <code>&lt;a href=<span className="t">&quot;https://prospecto.finance/invest/?ticker=QPY&quot;</span>&gt;Invest in us &rarr;&lt;/a&gt;</code>
          <Link className="invest-link" href={investHref("QPY")}>Invest in Quippy <b>&rarr;</b></Link>
        </div>
      </div>
    </section>
  );
}
