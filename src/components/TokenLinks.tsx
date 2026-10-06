// Bottom-of-page links section for a token: trade it HERE (Statera's in-app swap), the block explorer, its liquidity
// pool, and the main Arc DEXes. ⛔ 10-05 owner: never send a trader to another site to trade — Statera routes every
// indexed token in-app (was a 'Trade on Warp' link).
import { IconArrowRight, IconExternal } from './icons';

export function TokenLinks({ address, scanBase, pool, onTrade }: {
  address: string; scanBase: string; pool?: string | null; onTrade?: () => void;
}) {
  const isAddr = (a?: string | null) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  return (
    <div className="panel side-card tlinks">
      <h3>Links &amp; DEXes</h3>
      <div className="tlink-grid">
        {onTrade && (
          <button type="button" className="tlink" onClick={onTrade}>
            <b>Trade on Statera <IconArrowRight className="arw" /></b><span>In-app swap · best route across Arc DEXes</span>
          </button>
        )}
        <a className="tlink" href={`${scanBase}/token/${address}`} target="_blank" rel="noreferrer">
          <b>Block Explorer <IconExternal className="arw" /></b><span>Contract, holders &amp; transfers</span>
        </a>
        {isAddr(pool) && (
          <a className="tlink" href={`${scanBase}/address/${pool}`} target="_blank" rel="noreferrer">
            <b>Liquidity Pool <IconExternal className="arw" /></b><span className="mono">{pool!.slice(0, 10)}…{pool!.slice(-6)}</span>
          </a>
        )}
      </div>
      <div className="tlink-dexes">
        <span className="tlink-dexes-l">Arc DEXes</span>
        <a href="https://circlewarp.fun" target="_blank" rel="noreferrer">Warp</a>
        <span className="sep">·</span>
        <a href="https://app.uniswap.org" target="_blank" rel="noreferrer">Uniswap</a>
        <span className="sep">·</span>
        <a href="https://radardex.pro" target="_blank" rel="noreferrer">RadarDEX</a>
        <span className="sep">·</span>
        <a href="https://explorer.arc.io" target="_blank" rel="noreferrer">ArcExplorer</a>
      </div>
    </div>
  );
}
