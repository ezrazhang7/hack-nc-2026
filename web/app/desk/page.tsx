import type { Metadata } from "next";
import Link from "next/link";
import EstimateDesk from "@/components/EstimateDesk";
import HeroText from "@/components/HeroText";
import SubHeader from "@/components/SubHeader";
import "@/styles/sub.css";
import "@/styles/desk.css";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { title: "Estimate Desk · Prospecto" };

export default function DeskPage() {
  return (
    <div className="S S-desk">
      <SubHeader current="/desk/" />
      <main className="page">
        <div className="head">
          <HeroText text="The Estimate" em="Desk." />
          <span className="kicker">Try it with your own idea</span>
        </div>
        <EstimateDesk />
        <div className="foot"><Link href={routes.how}>← How it works</Link><Link href={routes.list}>List your company →</Link></div>
      </main>
    </div>
  );
}
