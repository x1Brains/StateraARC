// Bottom-of-page links section for a token: where to trade it (Warp on Arc mainnet), the block
// explorer, its liquidity pool, and the main Arc DEXes. Warp/pool links only render where they
// apply (5042 tokens), so testnet just shows the explorer + DEX directory.
export function TokenLinks({ address, scanBase, pool, warp }: {
  address: string; scanBase: string; pool?: string | null; warp?: boolean;
}) {
  const isAddr = (a?: string | null) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  return (
    <div className="panel side-card tlinks">
      <h3>Links &amp; DEXes</h3>
      <div className="tlink-grid">
        {warp && (
          <a className="tlink" href={`https://circlewarp.fun/trade/${address}`} target="_blank" rel="noreferrer">
            <b>Trade on Warp <span className="arw">↗</span></b><span>Launchpad · Uniswap v4</span>
          </a>
        )}
        <a className="tlink" href={`${scanBase}/token/${address}`} target="_blank" rel="noreferrer">
          <b>Block Explorer <span className="arw">↗</span></b><span>Contract, holders &amp; transfers</span>
        </a>
        {isAddr(pool) && (
          <a className="tlink" href={`${scanBase}/address/${pool}`} target="_blank" rel="noreferrer">
            <b>Liquidity Pool <span className="arw">↗</span></b><span className="mono">{pool!.slice(0, 10)}…{pool!.slice(-6)}</span>
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
        <a href="https://www.arcexplorer.org" target="_blank" rel="noreferrer">ArcExplorer</a>
      </div>
    </div>
  );
}
