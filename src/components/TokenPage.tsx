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
  { tag: 'Phase 2', title: 'Holder perks in X1 City',
    body: 'Hold STR and unlock perks, status and access inside X1 City — the Unreal-Engine world. Your bag is your pass; the more you hold, the more you unlock.' },
  { tag: 'Phase 3', title: 'Omnichain — STR reaches X1',
    body: 'A LayerZero OFT adapter makes STR one token across Arc and X1 with a unified supply — so STR (and your standing) travels between chains without a second wallet.' },
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
          <p className="tok-tag">The token of <b>Statera</b> — and your standing inside <span className="r">X1 City</span>.</p>
          <p className="tok-lede">A sealed, trust-minimized ERC-20. 21,000,000 fixed supply, no mint, ownerless, burnable — money that stays bulletproof while the perks and cross-chain reach clip on around it.</p>
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

      {/* ── THE SHOWPIECE: STR = your rank in X1 City ── */}
      <section className="tok-city">
        <div className="tok-city-bg"><img src="/hero-lava-4.jpg" alt="" /></div>
        <div className="wrap tok-city-inner">
          <div className="kicker">The bigger picture · why Statera matters</div>
          <h2 className="tok-city-h">Your STR isn’t a chart.<br />It’s your <span className="r">rank</span> in X1 City.</h2>
          <p className="tok-city-sub">X1 City is a living, Unreal-Engine metropolis at <b>x1city.io</b>. The STR in your wallet is your key, your status and your reputation inside it — and because STR goes omnichain, the token you buy on Arc <b>is</b> your standing in the city. One asset, two chains, a real world your bag plugs into.</p>

          {/* tier ladder — the more you hold, the higher you stand */}
          <div className="tok-tiers">
            {[
              { t: 'Visitor', h: 34 }, { t: 'Resident', h: 52 }, { t: 'Citizen', h: 70 }, { t: 'Elite', h: 86 }, { t: 'Founder', h: 100, top: true },
            ].map((x) => (
              <div className="tt-col" key={x.t}>
                <div className="tt-bar-wrap"><div className={`tt-bar ${x.top ? 'top' : ''}`} style={{ height: `${x.h}%` }} /></div>
                <div className="tt-label">{x.t}</div>
              </div>
            ))}
          </div>
          <div className="tok-tiers-cap">More STR held → higher standing, more of the city unlocked. <span className="dim">(tiers illustrative — the vision, not final)</span></div>

          {/* Arc → X1 flow */}
          <div className="tok-flow2">
            <div className="tf2"><span className="tf2-n">1</span><b>Arc</b><span>Buy &amp; hold STR</span></div>
            <div className="tf2-arw">→</div>
            <div className="tf2"><span className="tf2-n">2</span><b>Standing</b><span>Perks &amp; access unlock</span></div>
            <div className="tf2-arw">→</div>
            <div className="tf2 hot"><span className="tf2-n">3</span><b>X1 City</b><span>Enter the world · Unreal Engine</span></div>
          </div>
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
