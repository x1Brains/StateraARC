// $STR — the Statera token teaser / hype page. Not live yet: no contract address, no buy,
// no presale — deliberately, so nobody gets phished by a fake. Communicates what STR is,
// its trust-minimized design, the roadmap of companion features, and how it bridges Arc → X1 City.

const CORE = [
  { k: '21,000,000', l: 'Fixed supply', d: 'Minted once, forever. There is no mint function — the supply can never grow.' },
  { k: 'No mint', l: 'Inflation impossible', d: 'Nothing to renounce; new STR can never be created by anyone, including us.' },
  { k: 'Burnable', l: 'Real deflation', d: 'Every burn permanently removes STR from total supply — tracked on-chain (totalBurned).' },
  { k: 'Permit', l: 'Gasless approvals', d: 'EIP-2612 — one signature instead of an extra approval transaction.' },
  { k: 'Ownerless', l: 'No admin, no keys', d: 'No pause, no blacklist, no fees, no upgrade switch. Sealed the moment it ships.' },
  { k: 'Arc-native', l: 'USDC gas', d: 'A standard ERC-20 on Circle’s Arc L1 — cheap, instant, USDC-denominated fees.' },
];

const ROADMAP = [
  { tag: 'Phase 1', title: 'STR goes live on Arc', now: true,
    body: 'The sealed 21M token ships on Arc — instantly tradeable and auto-listed on the StateraArc screener + swap. That’s the whole token: hold it, send it, burn it.' },
  { tag: 'Phase 2', title: 'Ignite — burn to citizenship',
    body: 'Burn STR to mint your X1 City citizenship NFT in a single transaction. The burn is the entry fee to the city; your STR isn’t spent to a wallet, it’s destroyed forever.' },
  { tag: 'Phase 3', title: 'Omnichain — STR reaches X1',
    body: 'A LayerZero OFT adapter makes STR one token across Arc and X1 with a unified supply. Your citizenship and your STR follow you between chains — no second wallet required.' },
  { tag: 'Phase 4', title: 'Burn reputation & tiers',
    body: 'Your lifetime burns build an on-chain reputation that unlocks citizenship tiers, perks and status inside X1 City. The more you’ve committed, the more you are.' },
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
        <p className="tok-tag">The token of <b>Statera</b> — your key from Circle’s Arc chain into <b>X1 City</b>.</p>
        <p className="tok-lede">A sealed, trust-minimized ERC-20: 21,000,000 supply, no mint, ownerless, burnable. The money stays dumb and bulletproof — everything powerful (citizenship, cross-chain) clips on around it, never inside it.</p>
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
        <div className="section-head"><div><div className="kicker">Roadmap</div><h2>The token now — the city next</h2>
          <p>STR ships sealed and complete. Everything after is a separate companion that never touches the token itself.</p></div></div>
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
            <h2>From a token on Arc to a citizen in <span className="r">X1 City</span></h2>
            <p>X1 City is a living, Unreal-Engine-built world at <b>x1city.io</b> with an on-chain citizenship layer. STR is the on-ramp: burn it on Arc and you become a citizen — minted as a credential the game recognizes.</p>
            <p>The clever part: you never need a second wallet. Your Arc wallet signs once, and a deterministic in-game wallet is derived from that signature — so an Arc holder can walk straight into a Solana-based city, run an AI agent, and act on-chain, all from the wallet they already have.</p>
            <ul className="tok-x1-list">
              <li><b>Hold or burn STR</b> → your citizenship NFT.</li>
              <li><b>Citizenship</b> → entry + identity inside X1 City (Unreal Engine).</li>
              <li><b>One signature</b> → a derived wallet + AI agent, no seed phrase, no second app.</li>
              <li><b>Cross-chain</b> → STR &amp; your citizenship span Arc and X1 as one.</li>
            </ul>
          </div>
          <div className="tok-x1-r">
            <div className="tok-flow">
              <div className="tf-step"><span className="tf-n">1</span><div><b>Arc</b><span>Buy / hold STR</span></div></div>
              <div className="tf-arrow">↓</div>
              <div className="tf-step"><span className="tf-n">2</span><div><b>Ignite</b><span>Burn → citizenship NFT</span></div></div>
              <div className="tf-arrow">↓</div>
              <div className="tf-step"><span className="tf-n">3</span><div><b>X1 City</b><span>Enter the game · Unreal Engine</span></div></div>
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
