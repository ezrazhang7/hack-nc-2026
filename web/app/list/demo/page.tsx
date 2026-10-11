import type { Metadata } from "next";
import Link from "next/link";
import HeroText from "@/components/HeroText";
import LaunchInterview from "@/components/LaunchInterview";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/launch.css";

export const metadata: Metadata = { title: "Quippy Demo Listing · Prospecto" };

export default function DemoListPage() {
  return (
    <div className="S S-launch">
      <SubHeader current={routes.list} />
      <main className="page">
        <div className="head"><HeroText text="List" em="Quippy." /><span className="kicker">Demo preset · answers filled</span></div>
        <LaunchInterview demo />
        <div className="foot"><Link href={routes.list}>← Blank intake</Link><Link href={routes.invest}>Explore companies →</Link></div>
      </main>
    </div>
  );
}
