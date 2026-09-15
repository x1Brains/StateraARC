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
    <div className="wrap">
      {/* hero */}
      <section className="tok-hero">
        <div className="tok-hero-glow" />
        <img className="tok-logo" src="/str-logo.jpg" alt="Statera Arc" />
        <span className="badge b-red tok-soon">Not live yet · Coming to Arc</span>
        <h1 className="tok-title">$<span className="r">STR</span></h1>
        <p className="tok-tag">The token of <b>Statera</b> — and your standing inside <b>X1 City</b>.</p>
        <p className="tok-lede">A sealed, trust-minimized ERC-20: 21,000,000 supply, no mint, ownerless, burnable. The money stays minimal and bulletproof — the perks and cross-chain reach clip on around it, never inside it.</p>
        <div className="tok-supply-badge"><span className="tsb-n">21,000,000</span><span className="tsb-l">STR · fixed forever</span></div>
      </section>

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

      {/* tie-in to X1 City / Unreal Engine */}
      <section className="section">
        <div className="tok-x1 panel">
          <div className="tok-x1-l">
            <div className="kicker">The bigger picture</div>
            <h2>Hold STR. Stand taller in <span className="r">X1 City</span>.</h2>
            <p>X1 City is a living, Unreal-Engine-built world at <b>x1city.io</b>. Holding STR is your pass — it unlocks perks, status and access inside the game. Your STR balance *is* your standing; the more you hold, the more you get.</p>
            <p>And because STR goes omnichain, the token you buy on Arc reaches X1 as one and the same asset — your holdings and your perks follow you between chains, no second app required.</p>
            <ul className="tok-x1-list">
              <li><b>Hold STR</b> → perks, status &amp; access in X1 City.</li>
              <li><b>Hold more</b> → higher standing, more unlocks.</li>
              <li><b>Omnichain</b> → STR spans Arc and X1 as one token.</li>
              <li><b>Unreal Engine</b> → a real world your bag plugs into.</li>
            </ul>
          </div>
          <div className="tok-x1-r">
            <div className="tok-flow">
              <div className="tf-step"><span className="tf-n">1</span><div><b>Arc</b><span>Buy / hold STR</span></div></div>
              <div className="tf-arrow">↓</div>
              <div className="tf-step"><span className="tf-n">2</span><div><b>Perks</b><span>Status &amp; access unlock</span></div></div>
              <div className="tf-arrow">↓</div>
              <div className="tf-step"><span className="tf-n">3</span><div><b>X1 City</b><span>Enter the world · Unreal Engine</span></div></div>
            </div>
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
  );
}
