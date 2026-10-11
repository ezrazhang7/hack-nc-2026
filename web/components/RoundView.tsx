"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import HeroText from "@/components/HeroText";
import RoundTerminal from "@/components/RoundTerminal";
import FounderCards from "@/components/FounderCards";
import { getProject, STAGE_LABEL, toRound } from "@/lib/api";
import type { Round } from "@/lib/fixtures";
import { investSlugHref, routes } from "@/lib/routes";

export default function RoundView() {
  const params = useSearchParams();
  const slug = params.get("slug") ?? "";
  // undefined while loading; null when there is nothing to show.
  const [co, setCo] = useState<Round | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCo(undefined); setError(null);
    if (!slug) { setCo(null); return; }
    getProject(slug).then(
      (p) => setCo(p.round ? toRound(p) : null),
      (e: { status?: number; message: string }) => { if (e.status !== 404) setError(e.message); setCo(null); },
    );
  }, [slug]);

  if (co === undefined) return null; // still loading
  if (!co) {
    return (
      <div className="head">
        <HeroText text="No round" em="here." />
        {error && <span className="kicker">{error}</span>}
        <Link className="btn" href={slug ? investSlugHref(slug) : routes.invest}>{slug ? "See the company →" : "Explore companies →"}</Link>
      </div>
    );
  }
  return (
    <>
      <div className="head">
        <HeroText key={co.t} text="Back" em={`${co.n}.`} />
        <span className="kicker">{`${STAGE_LABEL[co.s]} · ${co.e}`}</span>
      </div>
      <div className="L round-term">
        <RoundTerminal key={co.slug ?? co.t} co={co} live={false} />
      </div>
      <FounderCards company={co.n} founders={co.f ?? []} demo={false} />
      <div className="foot"><Link href={routes.invest}>← Explore companies</Link><Link href={investSlugHref(co.slug)}>Why this price? →</Link></div>
    </>
  );
}
