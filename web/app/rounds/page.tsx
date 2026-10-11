import type { Metadata } from "next";
import Link from "next/link";
import HeroText from "@/components/HeroText";
import RoundsFeed from "@/components/RoundsFeed";
import SubHeader from "@/components/SubHeader";
import "@/styles/sub.css";
import "@/styles/rounds.css";

export const metadata: Metadata = { title: "Back a startup · Prospecto" };

export default function RoundsPage() {
  return (
    <div className="S S-rounds">
      <SubHeader current="/rounds/" />
      <main className="page">
        <div className="head">
          <HeroText text="Back them" em="early." />
          <Link className="bal" href="/participate/">Open your account →</Link>
        </div>
        <RoundsFeed />
        <div className="foot"><Link href="/">← Front page</Link><Link href="/news/">Read the news →</Link></div>
      </main>
    </div>
  );
}
