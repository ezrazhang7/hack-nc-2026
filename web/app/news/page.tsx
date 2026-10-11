import type { Metadata } from "next";
import Link from "next/link";
import HeroText from "@/components/HeroText";
import NewsIndex from "@/components/NewsIndex";
import SubHeader from "@/components/SubHeader";
import "@/styles/sub.css";
import "@/styles/news.css";
import { routes } from "@/lib/routes";
import { POSTS } from "@/lib/fixtures";

export const metadata: Metadata = { title: "News · Prospecto" };

export default function NewsPage() {
  return (
    <div className="S S-news">
      <SubHeader current="/news/" />
      <main className="page">
        <div className="head">
          <div className="edition"><span>Prospecto / The news desk</span><span>Latest edition · {POSTS[0].date}</span></div>
          <HeroText text="The" em="news." />
          <p className="news-tagline">Ideas, people &amp; the capital behind them.</p>
        </div>
        <NewsIndex />
        <div className="foot"><Link href={routes.invest}>← Explore companies</Link><Link href={routes.list}>List your company →</Link></div>
      </main>
    </div>
  );
}
