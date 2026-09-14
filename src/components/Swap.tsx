import { useMemo, useState } from 'react';
import { tprice, compact, CHAIN, type Token } from '../lib/arc';
import { TokenLogo } from './TokenLogo';

const USDC: Token = {
  address: '0x3600000000000000000000000000000000000000', name: 'USD Coin', symbol: 'USDC',
  holders: null, totalSupply: null, type: 'ERC-20', iconUrl: null, launchpad: null,
  isOurs: false, isEcosystem: true, price: 1, liq: null, mcap: null,
};

export function Swap({ tokens, wallet, onConnect }: { tokens: Token[]; wallet: string | null; onConnect: () => void }) {
  // Tradeable = anything we have a price for, plus USDC as the base quote.
  const priced = useMemo(() => [USDC, ...tokens.filter((t) => t.price != null && t.address !== USDC.address)], [tokens]);
  const [fromA, setFromA] = useState(USDC.address);
  const [toA, setToA] = useState('');
  const [amt, setAmt] = useState('');

  const from = priced.find((t) => t.address === fromA) || USDC;
  const to = priced.find((t) => t.address === toA) || priced[1];

  // Quote via pool prices: USD value in / price out. Routed through USDC when neither side is USDC.
  const quote = useMemo(() => {
    const n = parseFloat(amt);
    if (!n || !from?.price || !to?.price) return null;
    const usdIn = n * from.price;
    return usdIn / to.price;
  }, [amt, from, to]);

  const flip = () => { setFromA(to?.address || ''); setToA(from?.address || ''); };
  const rate = from?.price && to?.price ? from.price / to.price : null;

  const TokenSelect = ({ value, onChange, exclude }: { value: string; onChange: (a: string) => void; exclude?: string }) => (
    <select className="tk-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {priced.filter((t) => t.address !== exclude).map((t) => (
        <option key={t.address} value={t.address}>{t.symbol}</option>
      ))}
    </select>
  );

  return (
    <div className="wrap"><section className="section">
      <div className="section-head">
        <div><div className="kicker">Swap</div><h2>Swap Tokens</h2><p>Quote any Arc token against USDC, routed through on-chain pool liquidity.</p></div>
      </div>

      <div className="swap-wrap">
        <div className="swap-card">
          <div className="swap-box">
            <div className="swap-row"><span className="swap-l">You pay</span></div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
              <div className="tk-pill"><TokenLogo symbol={from?.symbol || '?'} seed={from?.address || ''} url={from?.iconUrl || null} /><TokenSelect value={fromA} onChange={setFromA} exclude={toA} /></div>
            </div>
            {from?.price != null && amt && <div className="swap-sub">≈ ${compact(parseFloat(amt) * from.price)}</div>}
          </div>

          <button className="swap-flip" onClick={flip} aria-label="flip">⇅</button>

          <div className="swap-box">
            <div className="swap-row"><span className="swap-l">You receive (est.)</span></div>
            <div className="swap-in">
              <input className="swap-amt" placeholder="0.0" value={quote != null ? compact(quote) : ''} readOnly />
              <div className="tk-pill"><TokenLogo symbol={to?.symbol || '?'} seed={to?.address || ''} url={to?.iconUrl || null} /><TokenSelect value={toA || (priced[1]?.address ?? '')} onChange={setToA} exclude={fromA} /></div>
            </div>
            {to?.price != null && quote != null && <div className="swap-sub">≈ ${compact(quote * to.price)}</div>}
          </div>

          {rate != null && <div className="swap-info"><span>Rate</span><span className="mono">1 {from?.symbol} = {tprice(rate)} {to?.symbol === 'USDC' ? '' : ''}{to?.symbol}</span></div>}

          <button className="btn solid swap-cta" onClick={wallet ? undefined : onConnect} disabled={!!wallet}>
            {wallet ? 'Swap — execution coming' : 'Connect Wallet'}
          </button>
          <div className="swap-note">Quote from on-chain pool prices. On-chain execution routes through the Arc DEX — that integration is the final wiring step. Not financial advice.</div>
        </div>

        <aside className="swap-side">
          <div className="panel side-card">
            <h3>How it works</h3>
            <p className="side-note">StateraArc reads live pool reserves to price every token. Swaps route your input through USDC-paired liquidity on {CHAIN.name}. Slippage protection and min-out are applied at execution.</p>
          </div>
        </aside>
      </div>
    </section></div>
  );
}
