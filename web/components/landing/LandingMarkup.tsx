import HeroText from "@/components/HeroText";
import FounderCards from "@/components/FounderCards";
import RoundTerminal from "@/components/RoundTerminal";
import LiveDateline from "@/components/landing/LiveDateline";
import DeckToggle from "@/components/landing/DeckToggle";
import { ROUNDS } from "@/lib/fixtures";

const FERN = ROUNDS.find((r) => r.t === "FERN")!;

// Static landing markup. Interactive parts (tape, board, WebGL plate)
// are filled in by LandingFX after mount; ids here are its contract.
export default function LandingMarkup() {
  return (
    <>

<div className="tape" aria-label="Open rounds ticker"><div className="tape-track" id="tape"></div></div>

{/* hero: the WebGL halftone (Fig. 1) is the full-bleed backdrop; text layers let the pointer through to it */}
<header className="page hero">
  <div className="hero-bg">
    <div className="plate">
      <canvas id="halftone" aria-hidden="true"></canvas>
      <span className="tag b">Stage: Idea &rarr; Growth</span>
    </div>
  </div>
  <div className="dateline">
    <LiveDateline />
  </div>
  <div className="masthead">
    <h1>The Prospecto</h1>
  </div>
  <div className="motto">All the companies too early to list.</div>
  <div className="btns hero-btns">
    <a className="btn go" href="/launch/">List your company &rarr;</a>
    <a className="btn" href="/rounds/">Back a startup</a>
  </div>
  <nav className="sections" aria-label="Sections">
    <a href="/how/">How It Works</a>
    <a href="/desk/">Estimate Desk</a>
    <a href="/news/">News</a>
    <a href="/launch/">List Your Company</a>
    <button type="button" className="protocol-nav" data-protocol-open aria-haspopup="dialog">Protocol</button>
  </nav>
  <div className="hero-hint"><span>Move your cursor to change the light.</span><span>Scroll for today’s issue &darr;</span></div>
</header>

<main className="page" id="front">
  <section className="front">
    <article className="lead">
      <div className="kicker"><b>Extra</b> &nbsp;·&nbsp; Primary issuance &nbsp;·&nbsp; Any stage</div>
      <HeroText as="h2" id="headline" text="Your half‑built idea now has" em="backers." />

      {/* split-flap, compact: fills the lead column under the headline */}
      <section className="board-wrap in-lead" id="prices">
        <div className="sec-head">
          <h2>Opening Prices <i>&mdash; today’s issuances</i></h2>
          <span className="kicker">Fixed per round · 1,000,000 founder units · updated live</span>
        </div>
        <div className="board" id="board" data-scroll-reveal="single" role="table" aria-label="Open rounds">
          <div className="brow head" role="row"><span>TICKER</span><span className="name">COMPANY</span><span>STAGE</span><span>PRICE</span><span>SUBSCRIBED</span></div>
        </div>
        <div className="board-foot"><span>Founder-approved prices never move during a round.</span><span>Fictional demo fixtures.</span></div>
      </section>
    </article>

    <aside className="side">
      <div className="cta-box">
        <DeckToggle>Prospecto lets founders at any stage &mdash; a dorm-room idea, a scrappy prototype, the first paying customers &mdash; publish a transparent valuation, set a fixed price, and put one <em>“Invest in us”</em> link on their website. Backers buy units directly from the startup.</DeckToggle>
        <div className="byline">By the Prospecto desk &nbsp;·&nbsp; Filed 9:41 a.m.</div>
      </div>
      <div className="bell">
        <div><strong>8</strong><span>Rounds open</span></div>
        <div><strong>$412,880</strong><span>Demo credits raised</span></div>
      </div>
      {/* native accordion: name="brief" keeps one item open at a time, no JS */}
      <div className="briefs">
        <div className="kicker">In brief</div>
        <details name="brief">
          <summary><span className="n">01</span><h3>Idea-stage teams are welcome.</h3><span className="pm" aria-hidden="true"></span></summary>
          <p>Five stages, from <span className="mono" style={{ fontSize: '13px' }}>IDEA</span> to <span className="mono" style={{ fontSize: '13px' }}>GROWTH</span>, are recorded separately from incorporation. An unincorporated project is labeled exactly that.</p>
        </details>
        <details name="brief">
          <summary><span className="n">02</span><h3>Every unit comes from the startup.</h3><span className="pm" aria-hidden="true"></span></summary>
          <p>No order book, no resale, no leverage. Each purchase is new issuance at the founder’s fixed price, and the proceeds land in the round account.</p>
        </details>
        <details name="brief">
          <summary><span className="n">03</span><h3>The estimate shows its work.</h3><span className="pm" aria-hidden="true"></span></summary>
          <p>Inputs, weights, model version and a sensitivity band are printed next to every suggested price. The founder can override it, with a reason on the record.</p>
        </details>
      </div>
    </aside>
  </section>
</main>

{/* back a startup: the round terminal */}
<section className="b1" id="rounds">
  <div className="page b1-head">
    <div className="sec-head" style={{ marginBottom: '0' }}>
      <h2>Back a startup</h2>
      <span className="kicker">Keep scrolling. The paper turns into the product.</span>
    </div>
  </div>
  <div className="page">
    <div className="stage" id="stage">
      <RoundTerminal co={FERN} />
      <div className="paper" id="paper" aria-hidden="true">
        <div className="paper-head"><span className="kicker">Late edition · how to read a round</span><h3>One company. One fixed price. <i>Three columns.</i></h3></div>
        <div><span className="kicker">Column one</span><h4>Who already backed it.</h4><p>Every commitment is printed the moment it lands: time, units, total. No bids, no asks, just people who believed early.</p></div>
        <div><span className="kicker">Column two</span><h4>One company, one fixed price, one honest chart.</h4><p>The price doesn’t move. The line that rises is how much of the round is committed.</p><p>The founders’ story, team and dated evidence sit right underneath.</p><blockquote>“Nobody bids. Nobody asks. You either believe early, or you watch.”</blockquote></div>
        <div><span className="kicker">Column three</span><h4>Pick a quantity. Get an exact quote.</h4><p>The quote shows unit price, fee and your total. You confirm once; allocation is final when the round closes.</p></div>
      </div>
    </div>
  </div>
</section>

<FounderCards company={FERN.n} founders={FERN.f ?? []} demo />

<footer className="page">
  <div className="colophon" data-scroll-reveal="single">
    <span className="mark">The Prospecto</span>
    <p>Printed on black at prospecto.finance. Built at HackNC 2026. Every company on this page is a fictional fixture, every unit is simulated, and the estimate is a demo heuristic.</p>
    <nav><a href="/rounds/">Back a startup</a><a href="/launch/">List</a><a href="/news/">News</a><a href="https://github.com/ezrazhang7/hack-nc-2027">GitHub</a></nav>
  </div>
</footer>

    </>
  );
}
