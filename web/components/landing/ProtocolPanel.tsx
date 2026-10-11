"use client";

import { useEffect, useRef } from "react";

/**
 * "The Protocol": the legal-posture supplement (docs/LEGAL_POSTURE.md, condensed).
 * Any element with [data-protocol-open] opens it; /#protocol opens it on load so the team can share a direct link.
 * A native <dialog> gives Esc-to-close, focus handling and the top layer for free.
 */
export default function ProtocolPanel() {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const open = () => {
      if (!dialog.open) dialog.showModal();
      dialog.scrollTop = 0;
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-protocol-open]")) open();
    };
    const onHash = () => {
      if (window.location.hash === "#protocol") open();
    };
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  // Clicks on the backdrop land on the <dialog> itself; clicks on the sheet land on its children.
  const onBackdrop = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  };

  return (
    <dialog ref={ref} className="protocol" aria-label="The Protocol" onClick={onBackdrop}>
      <article className="protocol-sheet">
        <form method="dialog"><button className="protocol-x">Close ✕</button></form>
        <div className="kicker protocol-kicker">Supplement · Legal protocol · Filed by the Prospecto desk</div>
        <h2>The Protocol</h2>
        <p className="protocol-sub">What this paper is, what it isn’t, and what a real one would need.</p>
        <p className="protocol-warn"><b>Not legal advice</b>Written by the team from public SEC guidance, assuming U.S. law. Securities counsel must review the issuer, the instrument, the platform’s role and its fees before any real money moves.</p>

        <aside className="protocol-corrections" aria-labelledby="protocol-corrections">
          <h4 id="protocol-corrections">Corrections &amp; Clarifications</h4>
          <p className="protocol-lede">Most pitches overstate something on page one. Here’s what this one doesn’t claim.</p>
          <div className="protocol-corr-cols">
            <p>Units issued on Prospecto today are <b>simulated</b>. They’re bought with free demo credits and carry no legal ownership, cash value, redemption or dividends.</p>
            <p>The estimate is a transparent heuristic with invented stage anchors, not an appraisal or investment advice.</p>
            <p>Followers aren’t investors, and popularity isn’t value. Participation receipts are not equity or shares, and never convert into them.</p>
          </div>
        </aside>

        <h3>I. Where the demo stands</h3>
        <p>Prospecto at HackNC 2026 is a <b>simulation</b>. Nothing on these pages is an offer to sell, or a solicitation to buy, any security.</p>
        <table>
          <thead><tr><th>Property</th><th>Demo state</th><th>Why it matters</th></tr></thead>
          <tbody>
            <tr><td>Money</td><td>Faucet-issued mock USDC on Solana Devnet; Nessie mock balances</td><td>No investment of money, so no sale of a security</td></tr>
            <tr><td>Instrument</td><td>Non-transferable Token-2022 participation receipts</td><td>No resale, no secondary market, no synthetic exposure</td></tr>
            <tr><td>Rights</td><td>None: no ownership, cash value, redemption, dividends or conversion</td><td>Nothing for a buyer to profit from</td></tr>
            <tr><td>Companies</td><td>Fictional fixtures in the public demo</td><td>No real issuer is marketing a real offering</td></tr>
            <tr><td>Estimate</td><td>Transparent heuristic with invented stage anchors</td><td>Not an appraisal, not investment advice</td></tr>
          </tbody>
        </table>

        <h3>II. What U.S. law actually says</h3>
        <h4>Accreditation depends on the offering route</h4>
        <p>Investors don’t need to be accredited to buy stock that already trades on Nasdaq or NYSE. A private startup listed on a website is still a <b>private offering</b>, and who may buy depends on the exemption it uses.</p>
        <table>
          <thead><tr><th>Route</th><th>Non-accredited buyers?</th><th>Key conditions</th></tr></thead>
          <tbody>
            <tr><td>Reg CF</td><td className="protocol-yes">Yes, within annual limits</td><td>≤ $5M per 12 months · one SEC-registered broker-dealer or funding portal · Form C disclosures · 1-year resale restriction</td></tr>
            <tr><td>Reg A, Tier 2</td><td className="protocol-yes">Yes, generally within limits</td><td>≤ $75M per 12 months · SEC qualification · audited financials · ongoing reporting</td></tr>
            <tr><td>Rule 506(b)</td><td>Up to 35 sophisticated</td><td><b>No general solicitation</b> · extra disclosure to non-accredited buyers</td></tr>
            <tr><td>Rule 506(c)</td><td className="protocol-no">No</td><td>Public marketing allowed · every buyer accredited and verified</td></tr>
          </tbody>
        </table>
        <div className="protocol-cols">
          <div>
            <h4>Publishing a valuation: the real rule</h4>
            <p>It is a myth that a published valuation makes a startup’s shares unsellable. But SEC staff treat valuation opinions as outside “ordinary factual business information”. So a page saying <i>“Startup A is worth $8M, invest in its round”</i> can be <b>general solicitation</b>, with or without a buy button.</p>
            <ul>
              <li>It can disqualify Rule 506(b) for that startup’s real raise.</li>
              <li>Under Reg CF, off-platform ads are limited to a short notice that points to the portal.</li>
              <li>Under 506(c) it’s allowed, but only for verified accredited buyers.</li>
            </ul>
          </div>
          <div>
            <h4>Tokenization is not a loophole</h4>
            <p>A token representing startup equity is still a security, and its sale and transfer need registration or an exemption. Calling it a token, making it non-transferable or labeling it “educational” doesn’t change the economic substance. Synthetic tokens tracking a startup’s value can also fall under security-based swap rules, which effectively bar retail buyers.</p>
            <h4>Two traps for a real-money Prospecto</h4>
            <ol>
              <li><b>Funding portals may not give investment advice or recommendations.</b> A platform-computed estimate beside a buy action can read as one.</li>
              <li><b>Matching buyers to issuers for a fee</b> requires broker-dealer or funding-portal registration. Partner, don’t become one.</li>
            </ol>
          </div>
        </div>

        <h3>III. How we’ll talk about it <span>· planned, rolling out</span></h3>
        <p>The demo still uses some offering-style words. Before any real company lists, the copy moves to this vocabulary.</p>
        <table>
          <thead><tr><th>Moving away from</th><th>Moving to</th></tr></thead>
          <tbody>
            <tr><td className="protocol-no">invest, investor</td><td>back, backer, join the round</td></tr>
            <tr><td className="protocol-no">shares, stock, equity, stake</td><td>participation receipts, units</td></tr>
            <tr><td className="protocol-no">valuation (beside a buy action)</td><td>model estimate, demo estimate</td></tr>
            <tr><td className="protocol-no">returns, upside, profit</td><td>nothing about financial outcome</td></tr>
          </tbody>
        </table>
        <ul>
          <li><b>Planned:</b> every buy or confirm screen will carry a <b>Simulation, no real money</b> stamp beside the action, not only in the footer.</li>
          <li>Already true: receipts never convert into equity. Prospecto is not a registered portal. A Nessie profile is not KYC.</li>
        </ul>

        <h3>IV. Public-company demo profiles</h3>
        <ol>
          <li>The demo uses public facts about real companies as <b>unaffiliated examples</b>. The companies and founders did not create or approve these profiles through Prospecto.</li>
          <li>Every price, balance, commitment and market move is simulated. No issuer receives money or creates rights through this demo.</li>
          <li>Before a startup controls its own listing, the experience remains clearly labeled as a simulation or waits for a regulated route.</li>
        </ol>
        <blockquote className="protocol-quote">“It’s an unaffiliated product simulation using public company facts. No money moves, no issuer is raising here, and no participant receives ownership or financial rights.”</blockquote>

        <h3>V. Path to a real version <span>· roadmap, not current behavior</span></h3>
        <table>
          <thead><tr><th>Step</th><th>Decision</th></tr></thead>
          <tbody>
            <tr><td>1 · Issuer</td><td>Only incorporated startups with standard instruments (e.g. a crowdfunding SAFE or common stock)</td></tr>
            <tr><td>2 · Route</td><td>Reg CF via an existing registered funding portal or broker-dealer. Prospecto is the software and analytics layer</td></tr>
            <tr><td>3 · Estimate</td><td>The founder sets and owns the price. The model is a disclosed tool with formula, inputs and version shown</td></tr>
            <tr><td>4 · Off-platform</td><td>“Back us” links follow Reg CF advertising limits and point to the portal</td></tr>
            <tr><td>5 · Limits &amp; identity</td><td>Annual limits and KYC/AML enforced by the intermediary</td></tr>
            <tr><td>6 · Funds</td><td>Held in the intermediary’s escrow or by a qualified third party. Portals may not hold investor funds</td></tr>
            <tr><td>7 · Tokens</td><td>Optional ownership record and transfer lock for legally issued securities, never a route around registration</td></tr>
            <tr><td>8 · Out of scope</td><td>Secondary trading, order books, AMMs, leverage, synthetic exposure</td></tr>
            <tr><td>9 · Gate</td><td>Counsel signs off before mainnet or any real money</td></tr>
          </tbody>
        </table>

        <h3>VI. Sources</h3>
        <ul className="protocol-src">
          <li><a href="https://www.sec.gov/resources-small-businesses/exempt-offerings/regulation-crowdfunding" target="_blank" rel="noopener noreferrer">SEC · Regulation Crowdfunding</a> and <a href="https://www.sec.gov/files/divisions/corpfin/guidance/reg-crowdfunding-interps.htm" target="_blank" rel="noopener noreferrer">Reg CF interpretations</a></li>
          <li><a href="https://www.sec.gov/resources-small-businesses/exempt-offerings/regulation" target="_blank" rel="noopener noreferrer">SEC · Regulation A</a></li>
          <li><a href="https://www.sec.gov/resources-small-businesses/exempt-offerings/private-placements-rule-506b" target="_blank" rel="noopener noreferrer">SEC · Rule 506(b)</a> · <a href="https://www.sec.gov/resources-small-businesses/exempt-offerings/general-solicitation-rule-506c" target="_blank" rel="noopener noreferrer">Rule 506(c)</a></li>
          <li><a href="https://www.sec.gov/rules-regulations/staff-guidance/compliance-disclosure-interpretations/securities-act-rules" target="_blank" rel="noopener noreferrer">SEC · Securities Act Rules C&amp;DIs (general solicitation, 256.23–256.25)</a></li>
          <li><a href="https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/jumpstart-our-business" target="_blank" rel="noopener noreferrer">SEC · JOBS Act FAQs for crowdfunding intermediaries</a></li>
        </ul>
      </article>
    </dialog>
  );
}
