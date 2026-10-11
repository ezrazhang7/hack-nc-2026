"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, type CSSProperties } from "react";
import { POSTS, type Post } from "@/lib/fixtures";

const SECS: { key: "All" | Post["sec"]; label: string }[] = [
  { key: "All", label: "All" },
  { key: "Explainer", label: "Explainers" },
  { key: "Round report", label: "Round reports" },
  { key: "Guide", label: "Guides" },
  { key: "Dispatch", label: "Dispatches" },
];

function NewsPhoto({ photo, priority, lead }: { photo: Post["photo"]; priority: boolean; lead: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="news-photo">
      {failed ? <span className="photo-fallback">Prospecto<br />News desk</span> : (
        <Image src={photo.src} alt={photo.alt} width={960} height={640}
          sizes={lead ? "(max-width: 760px) calc(100vw - 32px), (max-width: 1000px) calc((100vw - 92px) / 2), 750px" : "(max-width: 760px) calc(100vw - 32px), (max-width: 1000px) calc((100vw - 92px) / 2), 380px"}
          priority={priority} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export default function NewsIndex() {
  const [active, setActive] = useState<(typeof SECS)[number]["key"]>("All");
  const [open, setOpen] = useState<string | null>(null);
  const list = POSTS.filter((p) => active === "All" || p.sec === active);
  return (
    <>
      <div className="tabs2" role="group" aria-label="Sections">
        {SECS.map((s) => (
          <button key={s.key} aria-pressed={s.key === active} onClick={() => { setActive(s.key); setOpen(null); }}>{s.label}<span className="section-count">{POSTS.filter((p) => s.key === "All" || p.sec === s.key).length}</span></button>
        ))}
      </div>
      <div className="desk-line"><span><i aria-hidden="true" />{active === "All" ? "The latest" : SECS.find((s) => s.key === active)?.label}</span><span>{String(list.length).padStart(2, "0")} stories / Prospecto</span></div>
      <section className={`news-grid${active === "All" ? " front-edition" : ""}`} aria-label="News stories" aria-live="polite" key={active}>
        {list.map((p, i) => (
          <article key={p.h} className={`row enter${open === p.h ? " open" : ""}${p.sec === "Guide" || p.sec === "Dispatch" ? " red-accent" : ""}${active === "All" && i === 0 ? " lead-story" : ""}`} style={{ "--n": i } as CSSProperties}>
            <button type="button" aria-expanded={open === p.h} aria-controls={`news-body-${POSTS.indexOf(p)}`} onClick={() => setOpen(open === p.h ? null : p.h)}>
              <NewsPhoto photo={p.photo} priority={active === "All" && i === 0} lead={active === "All" && i === 0} />
              <span className="story"><span className="sec">{active === "All" && i === 0 ? "The big picture" : p.sec}</span><span className="h2">{p.h}</span><span className="dek">{p.dek}</span></span>
              <span className="meta"><span>{p.date} · {p.min} min read</span><span className="read">{open === p.h ? "Close" : "Read story"} <span>↗</span></span></span>
            </button>
            <div className="photo-credit">
              {p.photo.illustrative ? "Illustrative photo · " : "Photo · "}
              <a href={p.photo.source} target="_blank" rel="noopener noreferrer">{p.photo.credit}</a>
            </div>
            <div className="body" id={`news-body-${POSTS.indexOf(p)}`} inert={open !== p.h}><div><div className="in">
              <p>{p.body}</p>
              <Link className="cta" href={p.co[1]}>{p.co[1] === "/invest/" ? p.co[0] : `See ${p.co[0]}`} →</Link>
            </div></div></div>
          </article>
        ))}
      </section>
    </>
  );
}
