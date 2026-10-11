"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { investSlugHref, manageHref, routes, walletHref } from "@/lib/routes";

type LegacyRoute = "launch" | "rounds" | "project" | "round" | "participate" | "manage";

function destination(kind: LegacyRoute, search: string) {
  const query = new URLSearchParams(search);
  if (kind === "launch") return routes.list;
  if (kind === "rounds") return routes.invest;
  if (kind === "project" || kind === "round") return investSlugHref(query.get("slug"));
  if (query.get("project")) return manageHref(query.get("project"));
  return walletHref(query.get("round"));
}

const fallback = (kind: LegacyRoute) =>
  kind === "launch" ? routes.list : kind === "rounds" || kind === "project" || kind === "round" ? routes.invest : routes.wallet;

/** Static-export-safe compatibility redirect for links shared before the IA cleanup. */
export default function LegacyRouteRedirect({ kind }: { kind: LegacyRoute }) {
  const [to, setTo] = useState<string>(() => fallback(kind));
  useEffect(() => {
    const next = destination(kind, window.location.search);
    setTo(next);
    window.location.replace(next);
  }, [kind]);
  return <main className="page"><p>That page moved. <Link href={to}>Continue to Prospecto →</Link></p></main>;
}
