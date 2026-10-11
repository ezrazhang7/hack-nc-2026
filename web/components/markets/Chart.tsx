"use client";

import { useId, useRef } from "react";

const DAY_SLOTS = 289;

/** Intraday line: green above the previous close, red below, dashed baseline, hover crosshair. */
export default function Chart({ series, base, height = 260, onHover, compact = false }: {
  series: number[]; base: number; height?: number; compact?: boolean;
  onHover?: (i: number | null) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cross = useRef<HTMLSpanElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  if (series.length < 2) return <div className="chart" style={{ height }} />;

  const W = 1000, H = 1000, slots = compact ? series.length : Math.max(series.length, DAY_SLOTS);
  const lo = Math.min(base, ...series), hi = Math.max(base, ...series);
  const pad = (hi - lo) * 0.12 || hi * 0.01;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => (i / (slots - 1)) * W;
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = series.length - 1;
  const up = series[last] >= base;

  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.max(0, Math.min(last, Math.round(((clientX - r.left) / r.width) * (slots - 1))));
    const left = `${(x(i) / W) * 100}%`;
    if (cross.current) cross.current.style.left = left;
    if (dot.current) { dot.current.style.left = left; dot.current.style.top = `${(y(series[i]) / H) * 100}%`; }
    box.current?.classList.add("hovering");
    onHover?.(i);
  };
  const leave = () => { box.current?.classList.remove("hovering"); onHover?.(null); };

  return (
    <div
      ref={box} className={`chart ${up ? "is-up" : "is-dn"}${compact ? " compact" : ""}`} style={{ height }}
      onPointerMove={compact ? undefined : (e) => move(e.clientX)} onPointerLeave={compact ? undefined : leave}
      role="img" aria-label={`Intraday price, ${up ? "up" : "down"} on the day`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="base" x1="0" x2={W} y1={y(base)} y2={y(base)} vectorEffect="non-scaling-stroke" />
        {!compact && <path d={`${line}L${x(last)},${H}L0,${H}Z`} fill={`url(#g${id})`} />}
        <path className="ln" d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      {!compact && <>
        <span ref={cross} className="cross" />
        <span ref={dot} className="dot" />
        <span className="live" style={{ left: `${(x(last) / W) * 100}%`, top: `${(y(series[last]) / H) * 100}%` }} />
      </>}
    </div>
  );
}

/** Label for point i of a series that starts at t0 (5-minute steps). */
export const timeAt = (t0: number, i: number) =>
  new Date(t0 + i * 5 * 60_000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
