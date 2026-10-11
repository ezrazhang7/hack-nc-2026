"use client";

import { useEffect, useRef, useState } from "react";
import type { Founder } from "@/lib/fixtures";

/*
 * "Meet the founders": one paper calling card per founder, fanned on the page.
 * Connect is networking, not investing: a plain link to the founder's own LinkedIn profile in a new tab.
 *  - founder-entered link (already normalized to linkedin.com/in/…): opens that profile;
 *  - demo founder without a public profile link: opens LinkedIn's home page, labeled as a demo;
 *  - real founder with no link yet: disabled.
 */

const LINKEDIN_HOME = "https://www.linkedin.com/";
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("") || "?";

const Arrow = () => <svg className="ar" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 11 11 3M5 3h6v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" /></svg>;
const Check = () => <svg className="ck" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /></svg>;
const Lock = () => <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="6.5" width="8" height="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 6.5V4.5a2 2 0 0 1 4 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;

function Connect({ f, demo, id }: { f: Founder; demo: boolean; id: string }) {
  const [sent, setSent] = useState(false);
  const [nope, setNope] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const href = f.li ?? (demo ? LINKEDIN_HOME : null);

  if (!href) {
    return (
      <>
        <button type="button" className={`cx off${nope ? " nope" : ""}`} key={nope} aria-disabled="true" aria-describedby={id}
          onClick={() => { setNope((n) => n + 1); clearTimeout(timer.current); timer.current = setTimeout(() => setNope(0), 2200); }}>
          <Lock /><span>Connect</span>
        </button>
        <span className={`cx-tip${nope ? " show" : ""}`} id={id}>No LinkedIn link added yet</span>
      </>
    );
  }
  return (
    <>
      <a className={`cx${sent ? " sent" : ""}`} href={href} target="_blank" rel="noopener noreferrer"
        aria-label={`Connect with ${f.n} on LinkedIn (opens in a new tab)`} aria-describedby={id}
        onClick={() => { setSent(true); clearTimeout(timer.current); timer.current = setTimeout(() => setSent(false), 2600); }}>
        <span>{sent ? "Opened in a new tab" : "Connect"}</span>{sent ? <Check /> : <Arrow />}
      </a>
      <span className={`cx-tip${demo && !f.li && !sent ? " demo" : ""}`} id={id} aria-live="polite">
        {sent ? "LinkedIn opened in a new tab." : demo && !f.li ? "Demo founder · opens LinkedIn’s home page" : ""}
      </span>
    </>
  );
}

/** Dot-screen monogram on card stock: dots grow in when the card scrolls into view and follow the cursor's light. */
function Portrait({ name, accent }: { name: string; accent: [number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const serif = getComputedStyle(cv).getPropertyValue("--serif") || "Georgia, serif";
    const st = { prog: reduce ? 1 : 0, lx: 0.32, ly: 0.28, mask: null as Uint8ClampedArray | null, mw: 0, mh: 0 };
    let raf = 0, anim = 0;
    const buildMask = (w: number, h: number) => {
      const o = document.createElement("canvas"); o.width = w; o.height = h;
      const c = o.getContext("2d")!;
      c.fillStyle = "#000"; c.fillRect(0, 0, w, h);
      const g = c.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, Math.max(w, h) * 0.75);
      g.addColorStop(0, "rgba(255,255,255,.2)"); g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
      c.font = `600 ${Math.min(h * 0.74, w * 0.42)}px ${serif}`;
      c.fillText(initials(name), w / 2, h * 0.54);
      st.mask = c.getImageData(0, 0, w, h).data; st.mw = w; st.mh = h;
    };
    const draw = () => {
      const w = Math.round(cv.clientWidth), h = Math.round(cv.clientHeight);
      if (!w || !h) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      if (st.mw !== w || st.mh !== h) buildMask(w, h);
      const c = cv.getContext("2d")!, m = st.mask!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = "#ECE5D3"; c.fillRect(0, 0, w, h);
      const s = w / 46, a = (15 * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a), cx = w / 2, cy = h / 2;
      const n = Math.ceil(Math.hypot(w, h) / s / 2) + 1;
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const x = cx + (i * ca - j * sa) * s, y = cy + (i * sa + j * ca) * s;
        if (x < -s || y < -s || x > w + s || y > h + s) continue;
        const xi = Math.max(0, Math.min(w - 1, x | 0)), yi = Math.max(0, Math.min(h - 1, y | 0));
        let l = m[(yi * w + xi) * 4] / 255;
        const d = Math.hypot(x / w - st.lx, y / h - st.ly);
        l = Math.min(1, l * (1.25 - d * 0.7) + Math.max(0, 0.16 - d * 0.5));
        const dc = Math.hypot(x / w - 0.5, y / h - 0.5) / 0.71, t = Math.max(0, Math.min(1, st.prog * 1.7 - dc * 0.7)), e = 1 - Math.pow(1 - t, 3);
        const acc = Math.hypot(x / w - accent[0], ((y / h - accent[1]) * h) / w) < 0.07;
        let r = acc ? s * 0.42 * e : s * 0.54 * Math.sqrt(l) * e;
        if (r < s * 0.12) { c.fillStyle = "#d3cab4"; r = s * 0.08; } else c.fillStyle = acc ? "#2f9e44" : "#0A0A09";
        c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      }
    };
    const grow = () => {
      const t0 = performance.now();
      const tick = (t: number) => { st.prog = Math.min(1, (t - t0) / 1300); draw(); if (st.prog < 1) anim = requestAnimationFrame(tick); };
      anim = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); if (!reduce) grow(); } }, { threshold: 0.3 });
    io.observe(cv);
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    const move = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect(); st.lx = (e.clientX - r.left) / r.width; st.ly = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(draw);
    };
    const leave = () => { st.lx = 0.32; st.ly = 0.28; cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    cv.addEventListener("pointermove", move); cv.addEventListener("pointerleave", leave);
    draw();
    return () => {
      io.disconnect(); ro.disconnect(); cancelAnimationFrame(raf); cancelAnimationFrame(anim);
      cv.removeEventListener("pointermove", move); cv.removeEventListener("pointerleave", leave);
    };
  }, [name, accent]);
  return <canvas ref={ref} className="fp" aria-hidden="true" />;
}

const ACCENTS: [number, number][] = [[0.8, 0.22], [0.2, 0.76], [0.82, 0.74]];

export default function FounderCards({ company, founders, demo }: { company: string; founders: Founder[]; demo: boolean }) {
  if (!founders.length) return null;
  const many = founders.length === 1 ? "1 founder" : `${founders.length} founders`;
  return (
    <section className="founders" id="founders" aria-labelledby="founders-h">
      <div className="fhead">
        <h2 id="founders-h">Meet the founders <i>— then say hello.</i></h2>
        <span className="kicker">{company} · {many} · Connect opens their LinkedIn</span>
      </div>
      <div className="fdeck" data-n={founders.length}>
        {founders.map((f, k) => (
          <article className="card" key={f.n + k}>
            <Portrait name={f.n} accent={ACCENTS[k % ACCENTS.length]} />
            <h3>{f.n}</h3>
            <div className="role">{f.r}</div>
            {f.s && <div className="from">{f.s}</div>}
            {!!f.asks?.length && <ul className="asks">{f.asks.map((a) => <li key={a}><span>Wanted</span>{a}</li>)}</ul>}
            <Connect f={f} demo={demo} id={`cx-tip-${k}`} />
          </article>
        ))}
      </div>
      <div className="fnote">
        <span>Connecting is networking, not investing. Prospecto never messages anyone for you, and a LinkedIn link is not identity verification.</span>
        {demo && <span>Public-source demo profiles; the companies and founders are not affiliated with Prospecto.</span>}
      </div>
    </section>
  );
}
