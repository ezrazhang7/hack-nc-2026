import type { Metadata } from "next";
import Markets from "@/components/markets/Markets";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/markets.css";
import "@/styles/founders.css";
import "@/styles/project.css";

export const metadata: Metadata = { title: "Invest · Prospecto" };

export default function InvestPage() {
  return <div className="S S-markets"><SubHeader current={routes.invest} /><main className="page"><Markets view="markets" /></main></div>;
}
