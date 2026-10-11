import type { Metadata } from "next";
import Markets from "@/components/markets/Markets";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/markets.css";

export const metadata: Metadata = { title: "Portfolio · Prospecto" };

export default function PortfolioPage() {
  return <div className="S S-markets"><SubHeader current={routes.portfolio} /><main className="page"><Markets view="portfolio" /></main></div>;
}
