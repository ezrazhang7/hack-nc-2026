"use client";

import { useEffect } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { committedPct, formatMicroUsd, formatUnitPrice, formatUsdCompact, STAGE_LABEL } from "@/lib/api";
import type { Round } from "@/lib/fixtures";

/*
 * One company's round terminal: commitments, history chart and the commit quote.
 * Landing page (B1): a labeled illustration from a fixture, with an invented history and live fills.
 * /round/?slug= (API round): only real numbers. Exact micro-USD amounts and the close time come from
 * the API; there is no per-commitment feed yet, so no history is drawn rather than inventing one.
 * 1,000,000 is the model's reference unit count. Ids are the contract with the landing page's B1
 * scroll timeline (#term, #fills, #chart .base …).
 */

const REFERENCE_UNITS = 1000000, CREDITS = 10000;
const fmt$ = (n: number, d = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtM = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`);
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

export default function RoundTerminal({ co, preview = false, live: simulate = true }: { co: Round; preview?: boolean; live?: boolean }) {
  const real = !!co.slug;
  const CAP = co.cap ?? 100000;
  // Exact unit price in micro-USD: the API's integer for real rounds, the fixture's display price otherwise.
  const priceMicro = BigInt(co.pMicro ?? String(Math.round(co.p * 1e6)));
  const realPct = real && co.committedMicro && co.targetMicro ? committedPct({ total_committed_micro_usd: co.committedMicro, target_amount_micro_usd: co.targetMicro }) : 0;
  const ISSUED = Math.round(Math.min(co.sub, 100) / 100 * CAP), full = real ? realPct >= 100 || co.d === 0 : ISSUED >= CAP;
  const raised = Math.round(ISSUED * co.p);
  // Real rounds cap a quote at the per-person limit; the fixture at its illustrated demo-credit balance.
  const max = real && co.maxPer ? Math.max(1, Math.floor(co.maxPer / co.p)) : Math.max(1, Math.min(CAP - ISSUED, Math.floor(CREDITS / co.p)));
  const qty = Math.min(1000, max);

  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const live = !full && !preview && simulate;
    const cleanups: (() => void)[] = [];
    const every = (fn: () => void, ms: number) => { const id = setInterval(fn, ms); cleanups.push(() => clearInterval(id)); };
    const later = (fn: () => void, ms: number) => { const id = setTimeout(fn, ms); cleanups.push(() => clearTimeout(id)); };
    // Own tag (not data-gen) so LandingFX's start-up sweep of data-gen nodes leaves these rows alone.
    document.querySelectorAll("#fills [data-term]").forEach((n) => n.remove());

    // Fixture only: an illustrated history and fill tape. Real rounds never draw invented activity.
    if (!real) {

      const fills = $("fills");
      const SEED_FILLS: [string, number][] = [["14:22:07", 1000], ["14:21:40", 250], ["14:19:12", 4000], ["14:18:55", 100], ["14:16:03", 1500], ["14:12:47", 500], ["14:11:30", 2000], ["14:09:02", 300], ["14:06:18", 750], ["14:02:44", 1000], ["13:58:09", 120], ["13:55:31", 2500], ["13:51:20", 600], ["13:47:58", 1000], ["13:44:13", 200]];
      // Seed the tape only with fills that fit inside what the round has issued so far.
      let seeded = 0;
      const seedFills = SEED_FILLS.filter(([, u]) => (seeded + u <= ISSUED ? (seeded += u, true) : false));
      const fillRow = (t: string, u: number, isNew = false) => {
        const r = document.createElement("div"); r.className = "fr" + (isNew ? " new" : ""); r.dataset.term = "";
        r.innerHTML = `<i style="width:${Math.max(4, u / 4000 * 100)}%"></i><span class="t">${t}</span><span class="u">${u.toLocaleString()}</span><span>${fmt$(u * co.p, 2)}</span>`;
        return r;
      };
      seedFills.forEach(([t, u]) => fills.appendChild(fillRow(t, u)));
      let onFill = (u: number) => void u; // replaced by the chart below so each fill also lands on it
      if (!reduce && live) every(() => {
        const t = new Date().toTimeString().slice(0, 8), u = [100, 250, 500, 1000, 1200, 2000][(Math.random() * 6) | 0];
        if (units.reduce((x, y) => x + y, 0) + u > CAP) return; // never issue past the cap
        fills.insertBefore(fillRow(t, u, true), fills.children[1]);
        if (fills.children.length > 16) fills.lastElementChild!.remove();
        onFill(u);
      }, 3400);

      /* Units-issued chart. Price is fixed in a primary round, so there are no candles: the
         hairline scrubs through issuance history, the strip reads out that moment, and
         everything after the cursor dims. `.base .ln/.area/.vb` are the B1 timeline targets. */
      const svg = $<SVGSVGElement>("chart"), strip = $("cstrip"), tools = $("ctools");
      const PRICE = co.p, HOURS = 17 * 24, START = Date.UTC(2026, 8, 22);
      const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const at = (h: number) => new Date(START + h * 3600e3);
      const dLabel = (h: number) => `${MON[at(h).getUTCMonth()]} ${at(h).getUTCDate()}`;
      const hh = (h: number) => String(at(h).getUTCHours()).padStart(2, "0") + ":00";
      const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(Math.round(n)));
      const MONO = 'font-family="var(--mono)"';
      // Fixture: hourly purchases with evening peaks, a launch-day burst and a few spikes, scaled to the units issued so far.
      let seed = [...co.t].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) % 2147483646 + 1; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const units: number[] = [], backers: number[] = [];
      for (let h = 0; h < HOURS; h++) {
        const hod = h % 24, diurnal = 0.25 + Math.max(0, Math.sin((hod - 9) / 24 * Math.PI * 2)) * 1.1 + (hod >= 20 ? 0.6 : 0);
        units.push(diurnal * (h < 24 ? 2.2 : 1) * (rand() < 0.03 ? 4 + rand() * 4 : 1) * (0.5 + rand()));
      }
      const kk = ISSUED / units.reduce((x, y) => x + y, 0);
      units.forEach((u, i) => { units[i] = Math.round(u * kk); backers[i] = Math.max(units[i] ? 1 : 0, Math.round(units[i] / 260)); });

      type View = "1D" | "1W" | "Round";
      type Bucket = { h: number; u: number; b: number; cum: number };
      const VIEWS: Record<View, { span: number; bin: number }> = { "1D": { span: 24, bin: 1 }, "1W": { span: 168, bin: 4 }, Round: { span: HOURS, bin: 6 } };
      const series = (v: View) => {
        const { span, bin } = VIEWS[v], from = units.length - span, out: Bucket[] = [];
        let cum = units.slice(0, from).reduce((x, y) => x + y, 0);
        for (let s0 = from; s0 < units.length; s0 += bin) {
          let u = 0, b = 0; for (let h = s0; h < Math.min(s0 + bin, units.length); h++) { u += units[h]; b += backers[h]; }
          cum += u; out.push({ h: s0, u, b, cum });
        }
        return out;
      };
      const C = { view: "Round" as View, data: series("Round"), hover: null as number | null, lastShown: 0, live: 0, reveal: 1 };
      C.lastShown = C.data[C.data.length - 1].cum;
      const geo = () => {
        const W = Math.max(280, svg.clientWidth), H = svg.clientHeight || 330, padR = 64, padB = 26, n = C.data.length, cw = (W - padR) / n;
        return { W, H, padR, padB, n, cw, x: (i: number) => (i + 0.5) * cw, y: (v: number) => (H - padB) - v / CAP * (H - padB - 16), bw: Math.max(1.5, cw * 0.56) };
      };
      const cumAt = (i: number) => (i === C.data.length - 1 ? C.lastShown : C.data[i].cum);
      const stepLine = (g: ReturnType<typeof geo>) => {
        let line = `M0 ${g.y(C.data[0].cum - C.data[0].u).toFixed(1)}`;
        C.data.forEach((_, i) => { line += ` H${(i * g.cw).toFixed(1)} V${g.y(cumAt(i)).toFixed(1)}`; });
        return line + ` H${(g.W - g.padR).toFixed(1)}`;
      };
      const layers = (g: ReturnType<typeof geo>, cls: boolean) => {
        const vmax = Math.max(...C.data.map((d) => d.u)) || 1, line = stepLine(g);
        let s = "";
        C.data.forEach((d, i) => {
          const h = d.u / vmax * g.H * 0.18, op = cls ? 0.28 : i === C.hover ? 1 : 0.34;
          s += `<rect ${cls ? 'class="vb" ' : ""}x="${(g.x(i) - g.bw / 2).toFixed(1)}" y="${(g.H - g.padB - h).toFixed(1)}" width="${g.bw.toFixed(1)}" height="${h.toFixed(1)}" fill="#5BD06A" opacity="${op}"/>`;
        });
        s += `<path ${cls ? 'class="area" ' : ""}d="${line} V${g.y(0)} H0 Z" fill="url(#gfill)"/>`;
        return s + `<path ${cls ? 'class="ln" ' : ""}d="${line}" fill="none" stroke="#5BD06A" stroke-width="1.6"/>`;
      };
      const tagAt = (g: ReturnType<typeof geo>, v: number, bg: string, ink: string) =>
        `<rect x="${g.W - g.padR + 2}" y="${g.y(v) - 10}" width="${g.padR - 4}" height="20" fill="${bg}"/><text x="${g.W - g.padR + 8}" y="${g.y(v) + 4}" fill="${ink}" font-size="11" font-weight="700" ${MONO}>${fmtK(v)}</text>`;
      const writeStrip = (i: number | null) => {
        const d = C.data[i ?? C.data.length - 1], v = i == null ? C.lastShown : d.cum;
        strip.innerHTML = `<span class="when">${i == null ? "Now" : `${dLabel(d.h)}, ${hh(d.h)}`}</span><span>Committed<b class="up">+${d.u.toLocaleString()}</b></span><span>Total<b>${Math.round(v).toLocaleString()}</b></span><span>Of cap<b>${(v / CAP * 100).toFixed(1)}%</b></span><span>Backers<b>+${d.b}</b></span><span>Raised<b>${fmt$(Math.round(v * PRICE))}</b></span>`;
      };
      // Base: grid + series (built on load/resize/range switch). Overlay: hairline, tags, scrubbed copy (every hover).
      const drawBase = () => {
        const g = geo(); svg.setAttribute("viewBox", `0 0 ${g.W} ${g.H}`);
        let s = `<defs><linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5BD06A" stop-opacity=".22"/><stop offset="1" stop-color="#5BD06A" stop-opacity="0"/></linearGradient><clipPath id="cpast"><rect id="cpast-r" x="0" y="0" width="0" height="${g.H}"/></clipPath><clipPath id="creveal"><rect id="creveal-r" x="0" y="0" width="${g.W}" height="${g.H}"/></clipPath></defs>`;
        [0, 0.25, 0.5, 0.75, 1].map((f) => f * CAP).forEach((v) => {
          s += `<line x1="0" x2="${g.W - g.padR}" y1="${g.y(v)}" y2="${g.y(v)}" stroke="${v === CAP ? "#5a2a22" : "#1d1c19"}" stroke-dasharray="${v === CAP ? "0" : "2 4"}"/>`;
          s += `<text x="${g.W - g.padR + 10}" y="${g.y(v) + 4}" fill="#8A857A" font-size="11" ${MONO}>${v ? v / 1000 + "K" : "0"}</text>`;
        });
        s += `<text x="6" y="${g.y(CAP) - 6}" fill="#EF5A43" font-size="10.5" ${MONO} letter-spacing="1">CAP · ${CAP.toLocaleString("en-US")} UNITS</text>`;
        s += `<g class="base" clip-path="url(#creveal)">${layers(g, true)}</g><g id="chart-ov"></g>`;
        svg.innerHTML = s;
        drawOverlay();
      };
      const drawOverlay = () => {
        const g = geo(), ov = svg.querySelector("#chart-ov"), base = svg.querySelector<SVGGElement>(".base");
        if (!ov || !base) return;
        const hi = C.hover, last = C.data.length - 1, lv = C.lastShown;
        base.style.opacity = hi == null ? "1" : "0.3";
        let s = `<line x1="0" x2="${g.W - g.padR}" y1="${g.y(lv)}" y2="${g.y(lv)}" stroke="#5BD06A" stroke-dasharray="2 3" opacity=".55"/>`;
        if (C.live) s += `<circle cx="${g.W - g.padR}" cy="${g.y(lv)}" r="${3 + C.live * 14}" fill="none" stroke="#5BD06A" opacity="${1 - C.live}"/>`;
        s += tagAt(g, lv, "#5BD06A", "#071208");
        if (hi != null) {
          const d = C.data[hi], X = g.x(hi), Y = g.y(d.cum);
          svg.querySelector("#cpast-r")?.setAttribute("width", String((hi + 1) * g.cw));
          s += `<g clip-path="url(#cpast)">${layers(g, false)}</g>`;
          s += `<line x1="${X}" x2="${X}" y1="8" y2="${g.H - g.padB}" stroke="#ECE5D3"/>`;
          s += `<rect x="${X - 4.5}" y="${Y - 4.5}" width="9" height="9" fill="#0A0A09" stroke="#ECE5D3" transform="rotate(45 ${X} ${Y})"/>`;
          if (hi !== last || Math.abs(g.y(d.cum) - g.y(lv)) > 20) s += tagAt(g, d.cum, "#ECE5D3", "#0A0A09");
          const lbl = C.view === "1D" ? hh(d.h) : `${dLabel(d.h)}, ${hh(d.h)}`, w = lbl.length * 7 + 16, lx = Math.max(0, Math.min(g.W - g.padR - w, X - w / 2));
          s += `<rect x="${lx}" y="${g.H - g.padB + 2}" width="${w}" height="22" fill="#ECE5D3"/><text x="${lx + 8}" y="${g.H - 8}" fill="#0A0A09" font-size="11" ${MONO}>${lbl}</text>`;
        } else {
          const want = g.W < 500 ? 3 : 5;
          for (let j = 0; j < want; j++) {
            const i = Math.round(j / (want - 1) * last), d = C.data[i];
            s += `<text x="${Math.min(g.W - g.padR - 44, Math.max(2, g.x(i) - 18))}" y="${g.H - 6}" fill="#8A857A" font-size="11" ${MONO}>${C.view === "1D" ? hh(d.h) : dLabel(d.h)}</text>`;
          }
        }
        ov.innerHTML = s;
        writeStrip(hi);
      };
      // One rAF channel per motion (wipe, replay, live) so they never cancel each other.
      const anims: Record<string, number> = {};
      const animate = (key: string, ms: number, fn: (p: number) => void, done?: () => void, linear = false) => {
        cancelAnimationFrame(anims[key]);
        if (reduce) { fn(1); done?.(); return; }
        const t0 = performance.now();
        const tick = (t: number) => { const p = Math.min(1, (t - t0) / ms); fn(linear ? p : 1 - Math.pow(1 - p, 3)); if (p < 1) anims[key] = requestAnimationFrame(tick); else done?.(); };
        anims[key] = requestAnimationFrame(tick);
      };
      cleanups.push(() => Object.values(anims).forEach(cancelAnimationFrame));
      let replaying = false, extraBackers = 0;
      const setHover = (i: number | null) => { if (!replaying && C.hover !== i) { C.hover = i; drawOverlay(); } };
      const pick = (clientX: number) => {
        const g = geo(), r = svg.getBoundingClientRect();
        return Math.max(0, Math.min(g.n - 1, Math.floor((clientX - r.left) / r.width * g.W / g.cw)));
      };
      const onMove = (e: PointerEvent) => setHover(pick(e.clientX));
      const onLeave = (e: PointerEvent) => { if (e.pointerType === "mouse") setHover(null); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const i = C.hover ?? C.data.length - 1;
        setHover(Math.max(0, Math.min(C.data.length - 1, i + (e.key === "ArrowLeft" ? -1 : 1))));
      };
      const onBlur = () => setHover(null);
      svg.addEventListener("pointermove", onMove); svg.addEventListener("pointerdown", onMove);
      svg.addEventListener("pointerleave", onLeave); svg.addEventListener("keydown", onKey); svg.addEventListener("blur", onBlur);
      // Range tabs redraw the series and wipe it in from the left; Replay sweeps the hairline across the round.
      const tabs = [...tools.querySelectorAll<HTMLButtonElement>("button[data-view]")], play = tools.querySelector<HTMLButtonElement>("button[data-replay]");
      const onTab = (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement, v = b.dataset.view as View;
        if (replaying || v === C.view) return;
        tabs.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        C.view = v; C.data = series(v); C.lastShown = C.data[C.data.length - 1].cum; C.hover = null; drawBase();
        const g = geo(); animate("wipe", 650, (p) => svg.querySelector("#creveal-r")?.setAttribute("width", String(p * g.W)));
      };
      const onPlay = () => {
        if (replaying || reduce) return;
        replaying = true; play?.setAttribute("aria-pressed", "true");
        animate("replay", 4000, (p) => { C.hover = Math.round(p * (C.data.length - 1)); drawOverlay(); }, () => {
          replaying = false; play?.setAttribute("aria-pressed", "false"); C.hover = null; drawOverlay();
        }, true);
      };
      tabs.forEach((b) => b.addEventListener("click", onTab));
      play?.addEventListener("click", onPlay);
      // Each fill from the ticker lands in the newest hour: the last step eases up and a ring ripples off it.
      onFill = (u) => {
        units[units.length - 1] += u; backers[backers.length - 1] += 1;
        const total = units.reduce((x, y) => x + y, 0);
        $("c-raised").textContent = fmt$(Math.round(total * PRICE));
        const cb = $("c-backers"); if (cb) cb.textContent = String(co.b + ++extraBackers);
        const from = C.lastShown; C.data = series(C.view); const to = C.data[C.data.length - 1].cum;
        if (replaying) { C.lastShown = to; return; }
        // Edit the existing paths in place so the B1 timeline keeps its tween targets.
        const g = geo(), ln = svg.querySelector(".base .ln"), area = svg.querySelector(".base .area");
        animate("live", 650, (p) => {
          C.live = p; C.lastShown = from + (to - from) * p;
          const line = stepLine(g); ln?.setAttribute("d", line); area?.setAttribute("d", `${line} V${g.y(0)} H0 Z`);
          drawOverlay();
        }, () => { C.live = 0; drawOverlay(); });
      };
      drawBase();
      let cw = svg.clientWidth;
      const onResizeChart = () => { if (Math.abs(svg.clientWidth - cw) > 2) { cw = svg.clientWidth; drawBase(); ScrollTrigger.refresh(); } };
      addEventListener("resize", onResizeChart);
      cleanups.push(() => {
        removeEventListener("resize", onResizeChart);
        svg.removeEventListener("pointermove", onMove); svg.removeEventListener("pointerdown", onMove);
        svg.removeEventListener("pointerleave", onLeave); svg.removeEventListener("keydown", onKey); svg.removeEventListener("blur", onBlur);
        tabs.forEach((b) => b.removeEventListener("click", onTab)); play?.removeEventListener("click", onPlay);
        svg.innerHTML = ""; strip.innerHTML = "";
      });

    }

      const qn = $("qn"), qt = $("qt"), buy = $("buy"), chips = $("chips");
      const label = (q: number) => `Commit · ${q.toLocaleString("en-US")} units`;
      const onChip = (e: Event) => {
        const b = (e.target as Element).closest("button") as HTMLButtonElement | null; if (!b) return;
        [...chips.children].forEach((x) => x.classList.toggle("on", x === b));
        const q = +b.dataset.q!;
        qn.textContent = q.toLocaleString("en-US"); qt.textContent = formatMicroUsd(String(BigInt(q) * BigInt(co.pMicro ?? String(Math.round(co.p * 1e6)))), 2);
        if (!real) buy.textContent = label(q);
      };
      chips.addEventListener("click", onChip);
      const onBuy = () => {
        if (full || preview || real) return;
        buy.textContent = "Illustration only"; later(() => (buy.textContent = label(+qn.textContent!.replace(/,/g, ""))), 1400);
      };
      buy.addEventListener("click", onBuy);
      cleanups.push(() => { chips.removeEventListener("click", onChip); buy.removeEventListener("click", onBuy); });
      // Real rounds count down to closes_at; the fixture keeps its illustrated clock.
      let left = real && co.closesAt ? Math.floor((Date.parse(co.closesAt) - Date.now()) / 1000) : co.d * 86400 + 4 * 3600 + 11 * 60 + 9;
      const cd = $("cd");
      const show = () => {
        if (left <= 0) { cd.textContent = "Closed"; return; }
        const d = Math.floor(left / 86400), h = Math.floor(left % 86400 / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
        cd.textContent = `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      };
      if (!full) { show(); if (left > 0) every(() => { left--; show(); }, 1000); }

    return () => {
      cleanups.reverse().forEach((fn) => fn());
      document.querySelectorAll("#fills [data-term]").forEach((n) => n.remove());
    };
  }, [co, preview, full, ISSUED, CAP, simulate, real]);

  const tag = preview ? "Preview" : real ? "Simulated funds" : "Illustration";
  return (
    <div className="term" id="term">
      <div className="tnav t-chrome">
        <span className="logo">P</span>
        <div className="bal">{real ? <>Mock USDC <b>Devnet</b></> : <>Demo credits <b>10,000.00</b></>}</div>
      </div>
      <div className="tgrid">
        <aside className="panel book">
          <div className="ptabs t-chrome"><span className="on">Commitments</span></div>
          {!real && (
            <div className="cap t-in">
              <div className="lbl"><span>Round capacity</span><span>{CAP.toLocaleString("en-US")} units</span></div>
              <div className="meter"><i style={{ width: `${ISSUED / CAP * 100}%` }}></i></div>
              <div className="nums"><span className="up">{ISSUED.toLocaleString("en-US")} committed</span><span>{(CAP - ISSUED).toLocaleString("en-US")} left</span></div>
            </div>
          )}
          {real ? (
            <p className="tempty t-in">Each commitment will list here once wallet checkout is live. Amounts are allocated pro rata when the round closes.</p>
          ) : (
            <div className="fills" id="fills">
              <div className="fh"><span>Time</span><span>Units</span><span>Total</span></div>
            </div>
          )}
        </aside>
        <div className="panel center">
          <div className="chead t-in">
            <div className="cname">
              <div className="k">{co.t} <em>{STAGE_LABEL[co.s]}</em> <em>{tag}</em></div>
              <h3>{co.n}</h3>
            </div>
            <div className="cprice">{real ? formatUnitPrice(co.pMicro!) : fmt$(co.p, 2)}<small>FIXED FOR THIS ROUND</small></div>
            <div className="cstats">
              <div><span>Model value</span><b>{real ? formatUsdCompact(co.pMicro!) : fmtM(co.p * REFERENCE_UNITS)}</b></div>
              <div><span>Committed</span><b className="up" id="c-raised">{real ? formatMicroUsd(co.committedMicro ?? "0", 0) : fmt$(raised)}</b></div>
              {co.b > 0 || co.maxPer == null
                ? <div><span>Backers</span><b id="c-backers">{co.b}</b></div>
                : <div><span>Max / person</span><b>{fmt$(co.maxPer)}</b></div>}
              <div><span>Entity</span><b>{co.e === "Incorporated" ? "Inc." : "Unincorp."}</b></div>
            </div>
          </div>
          {real ? (
            <div className="rgauge t-in" role="img" aria-label={`${realPct}% of the round target committed`}>
              <div className="rg-big"><b>{realPct}%</b><span>of target committed</span></div>
              <div className="rg-track"><i style={{ width: `${Math.min(realPct, 100)}%` }} /><em style={{ left: "100%" }} /></div>
              <div className="rg-scale"><span>$0</span><span>Target {formatMicroUsd(co.targetMicro ?? "0", 0)}</span></div>
              <p>Oversubscribed rounds scale every commitment down pro rata at close; the excess is refunded.</p>
            </div>
          ) : (
            <>
              <div className="ctools t-in" id="ctools">
                <button type="button" data-view="1D" aria-pressed="false">1D</button>
                <button type="button" data-view="1W" aria-pressed="false">1W</button>
                <button type="button" data-view="Round" aria-pressed="true">Round</button>
                <button type="button" className="play" data-replay="" aria-pressed="false">▶ Replay</button>
                <span className="r">Units committed · illustration</span>
              </div>
              <div className="cstrip t-in" id="cstrip" aria-live="off"></div>
              <div className="chart t-in"><svg id="chart" tabIndex={0} role="img" aria-label="Units committed over the round (illustration). Use left and right arrow keys to scrub."></svg></div>
            </>
          )}
          <div className="ctabs t-chrome"><span className="on">Story</span>{co.f?.length ? <a href="#founders">Founders ({co.f.length})</a> : null}</div>
          <div className="about t-in"><b>{co.n}</b>{co.city && ` · ${co.city}`}. {co.h.replace(/[.!?]$/, "")}. {co.dek}</div>
        </div>
        <aside className="panel bp">
          <div className="bpanel">
            <div className="ptabs t-chrome"><span className="on">Commit</span></div>
            <div className="qty t-in"><span className="n" id="qn">{qty.toLocaleString("en-US")}</span><span className="u">UNITS</span></div>
            <div className="chips t-in" id="chips">
              {[100, 500, 1000].filter((q) => q <= max).map((q) => <button type="button" key={q} data-q={q} className={q === qty ? "on" : ""}>{q === 1000 ? "1K" : q}</button>)}
              <button type="button" data-q={max} className={qty === max && max < 1000 ? "on" : ""}>Max</button>
            </div>
            <div className="quote t-in">
              <div><span>Unit price</span><b>{real ? formatUnitPrice(co.pMicro!) : fmt$(co.p, 2)}</b></div>
              <div><span>Fee</span><b>{co.feeBps != null ? `${co.feeBps / 100}% of accepted` : "1% of accepted"}</b></div>
              <div className="tot"><span>Total</span><b id="qt">{formatMicroUsd(String(BigInt(qty) * priceMicro), 2)}</b></div>
            </div>
            <button type="button" className="buy t-in" id="buy" disabled={full || preview || real}>
              {full ? (real && realPct < 100 ? "Round closed" : "Round full") : preview ? "Opens after publishing" : real ? "Checkout opens soon" : `Commit · ${qty.toLocaleString("en-US")} units`}
            </button>
            <p className="fine t-in">{real
              ? "Wallet checkout opens with the Devnet program. Units are participation receipts: not equity, never transferable."
              : `Illustration with demo credits. Units come straight from ${co.n} and can’t be resold.`}</p>
            <div className="closes t-in"><span>Round closes</span><b id="cd">{full ? "Closed" : real ? "—" : `${co.d}d 04:11:09`}</b></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
