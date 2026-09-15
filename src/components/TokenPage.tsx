// $STR — the Statera token teaser / hype page. Not live yet: no contract address, no buy,
// no presale — deliberately, so nobody gets phished by a fake.
// Tie to X1 City = HOLD STR -> perks/status in the Unreal Engine game. + omnichain (STR reaches X1).
// Deliberately NO "burn STR for a citizenship NFT" messaging (citizenship model isn't burn-gated).

const CORE = [
  { k: '21,000,000', l: 'Fixed supply', d: 'Minted once, forever. There is no mint function — the supply can never grow.' },
  { k: 'No mint', l: 'Inflation impossible', d: 'Nothing to renounce; new STR can never be created by anyone, including us.' },
  { k: 'Burnable', l: 'Real deflation', d: 'Holders can burn STR to permanently remove it from supply — tracked on-chain (totalBurned).' },
  { k: 'Permit', l: 'Gasless approvals', d: 'EIP-2612 — one signature instead of an extra approval transaction.' },
  { k: 'Ownerless', l: 'No admin, no keys', d: 'No pause, no blacklist, no fees, no upgrade switch. Sealed the moment it ships.' },
  { k: 'Arc-native', l: 'USDC gas', d: 'A standard ERC-20 on Circle’s Arc L1 — cheap, instant, USDC-denominated fees.' },
];

const ROADMAP = [
  { tag: 'Phase 1', title: 'STR goes live on Arc', now: true,
    body: 'The sealed 21M token ships on Arc — instantly tradeable and auto-listed on the StateraArc screener + swap. That’s the whole token: hold it, send it, burn it.' },
  { tag: 'Phase 2', title: 'Perks in X1 City',
    body: 'X1 City is a full open world being built in Unreal Engine. STR holders get perks in the game as it rolls out — your bag ties you into the world.' },
  { tag: 'Phase 3', title: 'Omnichain — STR reaches X1',
    body: 'A LayerZero OFT adapter makes STR one token across Arc and X1 with a unified supply — STR as a true cross-chain asset.' },
];

export function TokenPage() {
  return (
    <>
      {/* ── cinematic hero (full-bleed, lava) ── */}
      <section className="tok-hero">
        <div className="tok-hero-bg"><img src="/hero-lava-2.jpg" alt="" /></div>
        <div className="tok-hero-inner">
          <div className="tok-logo-wrap">
            <img className="tok-logo" src="/str-logo.jpg" alt="Statera Arc" />
          </div>
          <span className="tok-soon"><span className="tok-soon-dot" /> Not live yet · Coming to Arc</span>
          <h1 className="tok-title">$<span className="r">STR</span></h1>
          <p className="tok-tag">The token of <b>Statera</b> — tied into <span className="r">X1 City</span>, an Unreal-Engine game in the making.</p>
          <p className="tok-lede">A sealed, trust-minimized ERC-20: 21,000,000 fixed supply, no mint, ownerless, burnable. Hold it on Arc and you plug into X1 City — the open world we’re building.</p>
          <div className="tok-hero-stats">
            <div className="ths"><b>21,000,000</b><span>Fixed supply</span></div>
            <div className="ths-div" />
            <div className="ths"><b className="r">0</b><span>Mint · ever</span></div>
            <div className="ths-div" />
            <div className="ths"><b>Arc</b><span>USDC-gas L1</span></div>
          </div>
        </div>
      </section>

      <div className="wrap">
      {/* core token features */}
      <section className="section">
        <div className="section-head"><div><div className="kicker">The Token</div><h2>Built to be bulletproof</h2>
          <p>STR is deliberately minimal. The smaller the money, the less there is to ever go wrong — and it’s immutable by construction.</p></div></div>
        <div className="tok-grid">
          {CORE.map((f) => (
            <div className="tok-card panel" key={f.l}>
              <div className="tok-card-k r">{f.k}</div>
              <div className="tok-card-l">{f.l}</div>
              <p className="tok-card-d">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* roadmap */}
      <section className="section">
        <div className="section-head"><div><div className="kicker">Roadmap</div><h2>The token now — the reach next</h2>
          <p>STR ships sealed and complete. Everything after is a separate system layered on top that never touches the token itself.</p></div></div>
        <div className="tok-road">
          {ROADMAP.map((r) => (
            <div className={`tok-road-item ${r.now ? 'now' : ''}`} key={r.tag}>
              <div className="tok-road-dot" />
              <div className="tok-road-body panel">
                <div className="tok-road-tag">{r.tag}{r.now && <span className="tok-live">Ships first</span>}</div>
                <h3>{r.title}</h3>
                <p>{r.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── THE SHOWPIECE: STR ties into X1 City, an Unreal Engine game ── */}
      <section className="tok-city">
        <div className="tok-city-bg"><img src="/hero-lava-4.jpg" alt="" /></div>
        <div className="wrap tok-city-inner">
          <div className="kicker">The bigger picture</div>
          <h2 className="tok-city-h">Hold STR. Stand taller in <span className="r">X1 City</span>.</h2>
          <p className="tok-city-sub"><b>X1 City is a full open world being built in Unreal Engine.</b> STR is the token tied into it — hold STR and you’ll get perks in the game as it rolls out. Your bag isn’t just a chart on Arc; it plugs into a real world we’re building.</p>
          <div className="tok-city-tag"><span className="tct-dot" /> Unreal Engine · in active development</div>
          <a className="btn solid tok-city-cta" href="https://x1city.io" target="_blank" rel="noreferrer">Explore X1 City <span className="arw">→</span></a>
        </div>
      </section>

      {/* honest safety note */}
      <section className="section">
        <div className="tok-warn">
          <b>Heads up — STR is not live yet.</b> There is no contract address, no presale, and nothing to buy right now.
          Anything claiming to be “STR” or a “Statera presale” today is a scam. The official launch and the real address will
          be announced here on StateraArc. Not financial advice — DYOR.
        </div>
      </section>
      </div>
    </>
  );
}
