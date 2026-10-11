import type { Metadata } from "next";
import Link from "next/link";
import HeroText from "@/components/HeroText";
import SubHeader from "@/components/SubHeader";
import "@/styles/sub.css";
import "@/styles/how.css";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { title: "How it works · Prospecto" };

export default function HowPage() {
  return (
    <div className="S S-how">
      <SubHeader current="/how/" />
      <main className="page">
        <div className="head">
          <HeroText text="How a listing" em="goes live." />
          <span className="kicker">Five dispatches · about 15 minutes</span>
        </div>
        <div className="cols5" data-scroll-reveal="stagger">
          <div className="step"><span className="no">No. 1</span><h3>Profile</h3><p className="dropcap">Write the story, not a deck. Stage, sector, founders, website and LinkedIn links. You choose which numbers are public and which stay private.</p><span className="stamp">&rarr; Public with consent</span></div>
          <div className="step"><span className="no">No. 2</span><h3>Estimate</h3><p>An open, versioned formula scores product, traction, team and financial readiness against your stage, then shows every assumption and a sensitivity band.</p><span className="stamp">&rarr; valuation-model-v1</span></div>
          <div className="step"><span className="no">No. 3</span><h3>Price</h3><p>Accept the anchor or override it with a reason. Set a fixed unit price and a finite cap on new units. Published terms never quietly change.</p><span className="stamp">&rarr; Immutable terms</span></div>
          <div className="step"><span className="no">No. 4</span><h3>Link</h3><p>Paste one “Invest in us” link on your site, your bio, your demo-day slide. Anyone who believes early follows it straight to your company.</p><span className="stamp">&rarr; One URL</span></div>
          <div className="step"><span className="no">No. 5</span><h3>Settle</h3><p>A commitment moves payment atomically. Allocation is computed at close, receipts are minted exactly once, and excess is refunded.</p><span className="stamp">&rarr; Auditable settlement</span></div>
        </div>
        <section className="classifieds" aria-labelledby="who">
          <div className="sec-head"><h2 id="who">Classifieds <i>&mdash; who it’s for</i></h2><span className="kicker">Public-source demo profiles</span></div>
          <div className="ads" data-scroll-reveal="stagger">
            <div className="ad"><span className="what">Practice the hard conversation</span><p>Quippy turns the conversations people avoid into short, adaptive daily practice by voice or text.</p><span className="meta">QPY · LAUNCHED · $0.65 / unit</span></div>
            <div className="ad"><span className="what">Electrify regional flight</span><p>Heart Aerospace is developing hybrid-electric aircraft, with public evidence supporting a prototype-stage profile.</p><span className="meta">HEART · PROTOTYPE · $0.52 / unit</span></div>
            <div className="ad"><span className="what">Edit without the timeline</span><p>Vyra turns uploaded footage and a plain-language direction into a polished first cut.</p><span className="meta">VYRA · LAUNCHED · $0.69 / unit</span></div>
          </div>
        </section>
        <div className="foot"><Link href={routes.desk}>Try the Estimate Desk →</Link><Link href={routes.list}>List your company →</Link></div>
      </main>
    </div>
  );
}
