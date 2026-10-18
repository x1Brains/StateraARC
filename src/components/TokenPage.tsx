import { useEffect, useState } from 'react';
import { IconArrowRight } from './icons';
import { CHAIN } from '../lib/arc';
// $STR — the Statera token page. LIVE on Arc mainnet since 2026-10-16.
// STR is a plain, sealed ERC-20: 88,880,000 fixed, no owner, no tax, no mint, burnable, permit.
// The only way STR leaves the 44.44M Robots allocation: mint a Statera Robot (bonding curve $8 → $44 USDC, 10,000 STR per mint).
// Tie to X1 City = HOLD STR -> perks/status in the Unreal Engine game.

const STR_ADDRESS = '0xaAEeA145196107F96A209A843e4f14A69dAe99D0';
const ROBOTS_ADDRESS = '0xA57C7AC417b3895F3b865119710c90a1733c5ac0';
const MINT_URL = 'https://x1city.io/citizenship/robots';
const EXPLORER = 'https://explorer.arc.io';
const ROBOT_IMG = 'https://arweave.net/un4oE_9SeHIbaxIBXPHtIEWKP1vGEqO9cSgykzKd590/';
const MAX = 4444, START = 8, END = 44, PER_MINT = 10_000;
const priceOf = (n: number) => START + ((END - START) * (n - 1)) / (MAX - 1);

const CORE = [
  { k: '88,880,000', l: 'Fixed supply', d: 'Created once at deploy. There is no mint function — the supply can never grow, ever.' },
  { k: 'No owner', l: 'No admin keys', d: 'Deployed ownerless. Nobody — us included — can change, pause, freeze or blacklist anything.' },
  { k: '0% tax', l: 'Clean transfers', d: 'No transfer tax. Works with every wallet, DEX and aggregator on Arc without warnings.' },
  { k: 'Burnable', l: 'Real deflation', d: 'Holders can burn STR to permanently remove it from supply — tracked on-chain (totalBurned).' },
  { k: 'Permit', l: 'Gasless approvals', d: 'EIP-2612 — one signature instead of an extra approval transaction.' },
  { k: 'Arc-native', l: 'USDC gas', d: 'A standard ERC-20 on Circle’s Arc L1 — cheap, instant, USDC-denominated fees.' },
];
const SPLIT = [
  { pct: 50, amt: '44,440,000', l: 'Statera Robots', d: 'Locked in the Robots NFT contract — 10,000 STR to every minter. Only minting releases it.', c: 'var(--red, #ff5a1e)' },
  { pct: 20, amt: '17,776,000', l: 'Game & staking', d: 'X1 City in-game rewards and staking.', c: '#ffc24a' },
  { pct: 20, amt: '17,776,000', l: 'Treasury & liquidity', d: 'Liquidity pools and project treasury.', c: '#3b82f6' },
  { pct: 10, amt: '8,888,000', l: 'Team', d: 'Team allocation.', c: '#a855f7' },
];
const ROADMAP = [
  { tag: 'Phase 1', title: 'STR + Statera Robots live on Arc', now: true,
    body: 'The sealed 88.88M token is live on Arc mainnet, and the 4,444 Statera Robots are minting — every Robot pays its minter 10,000 STR and is an X1 City citizenship.' },
  { tag: 'Phase 2', title: 'Official STR / USDC pool',
    body: 'Statera’s own Uniswap V4 pool for STR, auto-listed on the StateraArc screener + swap.' },
  { tag: 'Phase 3', title: 'Tied into X1 City',
    body: 'X1 City is a full open world being built in Unreal Engine 5 — web3 GameFi, the first EVM-SVM game on Arc. STR is the token tied into it.' },
];

async function call(to: string, data: string): Promise<string> {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result as string;
}

function Curve({ minted }: { minted: number | null }) {
  const W = 640, H = 200, P = 28;
  const x = (n: number) => P + ((n - 1) / (MAX - 1)) * (W - 2 * P);
  const y = (p: number) => H - P - ((p - START) / (END - START)) * (H - 2 * P);
  const m = Math.max(1, Math.min(MAX, (minted ?? 0) + 1));
  return (
    <svg className="tok-curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Robot mint price rises in a straight line from $8 to $44">
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="currentColor" opacity=".18" />
      <line x1={P} y1={P} x2={P} y2={H - P} stroke="currentColor" opacity=".18" />
      <path d={`M${x(1)},${y(START)} L${x(m)},${y(priceOf(m))} L${x(m)},${H - P} L${x(1)},${H - P} Z`} fill="rgba(255,110,40,.18)" />
      <line x1={x(1)} y1={y(START)} x2={x(MAX)} y2={y(END)} stroke="url(#tokFire)" strokeWidth="3" strokeLinecap="round" />
      <defs><linearGradient id="tokFire" x1="0" x2="1"><stop offset="0" stopColor="#ffc24a" /><stop offset=".5" stopColor="#ff7a1e" /><stop offset="1" stopColor="#ff2f14" /></linearGradient></defs>
      <circle cx={x(m)} cy={y(priceOf(m))} r="6" fill="#fff" stroke="#ff7a1e" strokeWidth="3" />
      <text x={x(m)} y={y(priceOf(m)) - 12} textAnchor={m > MAX * 0.8 ? 'end' : m < MAX * 0.15 ? 'start' : 'middle'} fill="currentColor" fontSize="12">Next: ${priceOf(m).toFixed(2)}</text>
      <text x={P} y={H - 8} fill="currentColor" opacity=".6" fontSize="11">Robot #1 · $8</text>
      <text x={W - P} y={H - 8} textAnchor="end" fill="currentColor" opacity=".6" fontSize="11">Robot #4,444 · $44</text>
    </svg>
  );
}

export function TokenPage() {
  const [minted, setMinted] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [show, setShow] = useState<{ d: number; t: string }[]>([]);
  useEffect(() => {                                              // random Mythic / Legendary / Epic Robots
    fetch('/robot-tiers.txt').then(r => r.text()).then(txt => {
      const t = txt.trim(); const pick = (k: string, n: number) => {
        const ids: number[] = []; for (let i = 0; i < t.length; i++) if (t[i] === k) ids.push(i + 1);
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
        return ids.slice(0, n).map(d => ({ d, t: k }));
      };
      setShow([...pick('M', 4), ...pick('L', 4), ...pick('E', 4)]);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    call(ROBOTS_ADDRESS, '0xa2309ff8').then(h => setMinted(Number(BigInt(h)))).catch(() => {});   // totalMinted()
  }, []);
  const strLeft = minted != null ? (MAX - minted) * PER_MINT : null;
  const copy = async () => { try { await navigator.clipboard.writeText(STR_ADDRESS); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ } };

  return (
    <>
      <section className="tok-hero">
        <div className="tok-hero-bg"><img src="/hero-lava-2.jpg" alt="" /></div>
        <div className="tok-hero-inner">
          <div className="tok-live-badge"><span className="tlb-dot" /> Live on Arc mainnet</div>
          <div className="tok-logo-wrap">
            <img className="tok-logo" src="/str-token-512.png" alt="STR — the Statera token" />
          </div>
          <h1 className="tok-title">$<span className="r">STR</span></h1>
          <p className="tok-tag">The <b>Statera token</b> — tied into <span className="r">X1 City</span>, a web3 GameFi world in Unreal Engine 5.</p>
          <p className="tok-lede">A sealed ERC-20 with no one at the wheel — <b>no owner, no admin keys, no tax, no mint</b>. 88,880,000 fixed supply, burnable. Half of it can only be earned by minting a <b>Statera Robot</b>.</p>
          <div className="tok-addr">
            <span className="tok-addr-l">Official contract</span>
            <code className="tok-addr-v">{STR_ADDRESS}</code>
            <button type="button" className="tok-addr-btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
            <a className="tok-addr-btn" href={`${EXPLORER}/token/${STR_ADDRESS}`} target="_blank" rel="noreferrer">Explorer ↗</a>
          </div>
          <div className="tok-hero-stats">
            <div className="ths"><b>88,880,000</b><span>Fixed supply</span></div>
            <div className="ths-div" />
            <div className="ths"><b className="r">0%</b><span>Transfer tax</span></div>
            <div className="ths-div" />
            <div className="ths"><b>10,000</b><span>STR per Robot</span></div>
          </div>
        </div>
      </section>

      <div className="wrap">

      {show.length > 0 && (
      <section className="section">
        <div className="section-head"><div><div className="kicker">Statera Robots · 4,444</div><h2>Every Robot comes with 10,000 STR</h2>
          <p className="sub">A random pick of the rarest — 88 Mythic · 379 Legendary · 658 Epic. Which one you get is drawn when you mint.</p></div></div>
        <div className="tok-robots">
          {show.map(x => (
            <a className={'tok-robot tr-' + x.t} key={x.d} href={MINT_URL} target="_blank" rel="noreferrer">
              <img src={ROBOT_IMG + x.d + '.png'} alt={'Statera Robot #' + x.d} loading="lazy" />
              <span className="tr-tag">{{ M: 'MYTHIC', L: 'LEGENDARY', E: 'EPIC' }[x.t]}</span>
              <span className="tr-str"><img src="/str-token-256.png" alt="" />+10,000 STR</span>
            </a>
          ))}
        </div>
        <div className="tok-robots-cta">
          <div><b>Mint a Robot → get <span className="r">10,000 STR</span></b><span>Your X1 City citizenship + 10,000 Statera tokens in one transaction · from $8 USDC</span></div>
          <a className="btn solid" href={MINT_URL} target="_blank" rel="noreferrer">Mint now <IconArrowRight className="arw" /></a>
        </div>
      </section>
      )}

      {/* how to get STR: the Robots bonding curve */}
      <section className="section">
        <div className="section-head"><div><div className="kicker">How to get STR</div><h2>Mint a Statera Robot → get 10,000 STR</h2>
          <p className="sub">The only way STR leaves the 44,440,000 Robots allocation — half of the whole supply.</p></div></div>
        <div className="tok-mint panel">
          <div className="tok-mint-text">
            <p><b>4,444 Statera Robots</b> — NFT citizenships of X1 City on Arc. Every Robot you mint sends <b className="r">10,000 STR</b> straight to your wallet in the same transaction. There is no presale and no other faucet: the 44.44M STR sit inside the Robots contract and only minting releases them.</p>
            <p><b>Bonding curve.</b> The mint price climbs in a straight line from <b>$8 USDC</b> for Robot #1 to <b>$44 USDC</b> for Robot #4,444 — each mint makes the next one about <b>$0.008</b> more expensive. Early minters get the same 10,000 STR for the lowest price, so the <b>cost per STR rises as the collection fills</b> (from $0.0008 to $0.0044 per STR).</p>
            <p>One Robot per wallet. Your Robot is drawn at random when you mint — Common, Rare, Epic, Legendary or Mythic — revealed instantly, and it’s your X1 City citizenship.</p>
            <div className="tok-mint-stats">
              <div><span>Robots minted</span><b>{minted != null ? minted.toLocaleString() : '…'} / 4,444</b></div>
              <div><span>Next mint price</span><b className="r">${minted != null ? priceOf(Math.min(MAX, minted + 1)).toFixed(2) : '…'}</b></div>
              <div><span>STR left to mint</span><b>{strLeft != null ? strLeft.toLocaleString() : '…'}</b></div>
            </div>
            <a className="btn solid" href={MINT_URL} target="_blank" rel="noreferrer">Mint a Robot on X1 City <IconArrowRight className="arw" /></a>
          </div>
          <div className="tok-mint-curve"><Curve minted={minted} /></div>
        </div>
      </section>


      <section className="section">
        <div className="section-head"><div><div className="kicker">The Token</div><h2>Built to be bulletproof</h2>
          <p className="sub">STR is deliberately minimal — and immutable by construction. Nothing about it can be changed by anyone.</p></div></div>
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

      <section className="section">
        <div className="section-head"><div><div className="kicker">Supply split</div><h2>88,880,000 STR — where it lives</h2></div></div>
        <div className="tok-split-bar">
          {SPLIT.map(s => <span key={s.l} style={{ width: s.pct + '%', background: s.c }} title={`${s.l} ${s.pct}%`} />)}
        </div>
        <div className="tok-split">
          {SPLIT.map(s => (
            <div className="tok-split-item panel" key={s.l}>
              <div className="tsi-h"><span className="tsi-dot" style={{ background: s.c }} /><b>{s.pct}%</b> {s.l}</div>
              <div className="tsi-amt">{s.amt} STR</div>
              <p className="tok-card-d">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div><div className="kicker">Roadmap</div><h2>Live now — and what’s next</h2></div></div>
        <div className="tok-road">
          {ROADMAP.map((r) => (
            <div className={`tok-road-item ${r.now ? 'now' : ''}`} key={r.tag}>
              <div className="tok-road-dot" />
              <div className="tok-road-body panel">
                <div className="tok-road-tag">{r.tag}{r.now && <span className="tok-live">Live</span>}</div>
                <div className="tok-road-title">{r.title}</div>
                <p className="tok-road-p">{r.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      </div>

      <section className="tok-city">
        <div className="tok-city-bg"><img src="/hero-lava-4.jpg" alt="" /></div>
        <div className="wrap tok-city-inner">
          <div className="kicker">The bigger picture · Web3 GameFi</div>
          <h2 className="tok-city-h">$STR, tied into <span className="r">X1 City</span>.</h2>
          <p className="tok-city-sub"><b>X1 City is a full open world being built in Unreal Engine 5</b> — web3 GameFi, and the first game to bridge <b>EVM and SVM</b>, on Arc. <b>$STR</b> is the token woven into it — more than a chart, it’s your link to the world we’re building.</p>
          <div className="tok-city-video">
            <video src="/x1city-rain.mp4" controls playsInline preload="metadata" poster="/hero-lava-4.jpg" />
            <span className="tcv-cap">X1 City — in-engine footage (Unreal Engine 5)</span>
          </div>
          <div className="tok-city-actions">
            <div className="tok-city-tag"><span className="tct-dot" /> Unreal Engine 5 · Web3 GameFi · in active development</div>
            <a className="btn solid tok-city-cta" href="https://x1city.io" target="_blank" rel="noreferrer">Explore X1 City <IconArrowRight className="arw" /></a>
          </div>
        </div>
      </section>

      <div className="wrap">
      {/* honest safety note */}
      <section className="section">
        <div className="tok-warn">
          <b>Only one real STR.</b> The official Statera token contract is <code>{STR_ADDRESS}</code> on Arc mainnet — always check the address.
          Any other “STR” or “Statera” token is not ours. There is no presale: STR comes from minting Statera Robots. Not financial advice — DYOR.
          <br />Official contact: <a href="mailto:stateraarc@gmail.com">stateraarc@gmail.com</a>
        </div>
      </section>
      </div>
    </>
  );
}
