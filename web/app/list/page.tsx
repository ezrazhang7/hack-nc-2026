import type { Metadata } from "next";
import Link from "next/link";
import HeroText from "@/components/HeroText";
import LaunchInterview from "@/components/LaunchInterview";
import SubHeader from "@/components/SubHeader";
import { routes } from "@/lib/routes";
import "@/styles/sub.css";
import "@/styles/launch.css";

export const metadata: Metadata = { title: "List Your Company · Prospecto" };

export default function ListPage() {
  return (
    <div className="S S-launch">
      <SubHeader current={routes.list} />
      <main className="page">
        <div className="head"><HeroText text="List your" em="company." /><span className="kicker">A few questions · about 3 minutes</span></div>
        <LaunchInterview />
        <div className="foot"><Link href={routes.home}>← Front page</Link><Link href={routes.invest}>Explore companies →</Link></div>
      </main>
    </div>
  );
}
