import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TokenLogo } from './TokenLogo';
import { IconClose, IconExternal, IconSend } from './icons';
import { isAddress, compact, mCall, activeEth, req, CHAIN, type NftHolding } from '../lib/arc';

// NFTs in the portfolio: every item shown as a tile with its art, and (on your own wallet) a Send button.
// Statera Robots are read STRAIGHT FROM THE CHAIN (ERC721Enumerable: balanceOf → tokenOfOwnerByIndex → artOf),
// so they always show even when the explorer API is slow or blocked. Other ERC-721 collections come from the
// explorer's per-item NFT list; if that fails they fall back to the plain collection card (no send).

const ROBOTS = '0xa57c7ac417b3895f3b865119710c90a1733c5ac0';
const ROBOTS_IMG = 'https://arweave.net/un4oE_9SeHIbaxIBXPHtIEWKP1vGEqO9cSgykzKd590/';
// ipfs:// and ar:// links don't open in a browser — send them through public gateways.
// Public IPFS gateways rate-limit hard (ipfs.io / dweb.link answer 429 under load) — so every IPFS link is tried on
// several gateways in turn. `ipfsPath` pulls "<cid>/<path>" out of ipfs://… or any https://<gateway>/ipfs/… link.
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
const ipfsPath = (u: string): string | null => {
  if (u.startsWith('ipfs://')) return u.slice(7).replace(/^ipfs\//, '');
  const m = u.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/); return m ? m[1] : null;
};
const gw = (u: string | null): string | null => !u ? null : ipfsPath(u) ? GATEWAYS[0] + ipfsPath(u) : u.startsWith('ar://') ? 'https://arweave.net/' + u.slice(5) : u;
/** every URL worth trying for a link, best gateway first */
const candidates = (u: string | null): string[] => { if (!u) return []; const p = ipfsPath(u); return p ? GATEWAYS.map((g) => g + p) : [gw(u)!]; };
async function fetchJson(u: string): Promise<any> {
  let last: any;
  for (const c of candidates(u)) { try { const r = await fetch(c, { signal: AbortSignal.timeout(9000) }); if (r.ok) return await r.json(); last = new Error('http ' + r.status); } catch (e) { last = e; } }
  throw last || new Error('unreachable');
}
/** Image straight from the NFT's own tokenURI metadata (on-chain → JSON → image). Used when the explorer has none. */
const metaImgCache = new Map<string, Promise<string | null>>();
function imageFromChain(contract: string, id: bigint): Promise<string | null> {
  const k = contract + ':' + id;
  if (!metaImgCache.has(k)) metaImgCache.set(k, (async () => {
    try {
      const r = await mCall(contract, '0xc87b56dd' + id.toString(16).padStart(64, '0'));
      if (!r || r === '0x') return null;
      const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128)));
      const bytes = h.slice(128, 128 + len * 2); const arr = new Uint8Array(bytes.length / 2);
      for (let i = 0; i < arr.length; i++) arr[i] = parseInt(bytes.substr(i * 2, 2), 16);
      const u = new TextDecoder().decode(arr);
      let j: any;
      if (u.startsWith('data:application/json')) { const b = u.slice(u.indexOf(',') + 1); j = JSON.parse(u.includes(';base64,') ? atob(b) : decodeURIComponent(b)); }
      else j = await fetchJson(u);
      return j?.image || j?.image_url || null;
    } catch { return null; }
  })());
  return metaImgCache.get(k)!;
}
/** <img> with fallbacks: explorer image → the NFT's own metadata image → clean placeholder (never a broken icon). */
function Art({ src, alt, id, contract }: { src: string | null; alt: string; id: bigint; contract?: string }) {
  const [list, setList] = useState<string[]>(() => candidates(src));
  const [i, setI] = useState(0);
  const [tried, setTried] = useState(false);
  useEffect(() => { setList(candidates(src)); setI(0); setTried(false); }, [src]);
  const next = () => {
    if (i + 1 < list.length) { setI(i + 1); return; }
    if (tried || !contract) { setList([]); return; }
    setTried(true); setList([]);
    imageFromChain(contract, id).then((u) => { const c = candidates(u).filter((x) => !candidates(src).includes(x)); setList(c); setI(0); });
  };
  useEffect(() => { if (!src && contract && !tried) next(); }, [src, contract]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = list[i];
  return cur ? <img src={cur} alt={alt} loading="lazy" onError={next} /> : <span className="nf-noimg">#{String(id)}</span>;
}
const TIER: Record<string, [string, string]> = { M: ['Mythic', '#ff5a5a'], L: ['Legendary', '#ffc24a'], E: ['Epic', '#c084fc'], R: ['Rare', '#60a5fa'], C: ['Common', '#a9b3c4'] };
const ARC_CHAIN_HEX = '0x13b2'; // 5042
const DEAD = '0x000000000000000000000000000000000000dEaD';
// Burn = send to the standard dead address (nobody holds its key). address(0) can't be used: ERC-721 transfers to it revert.
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexId = (n: bigint) => n.toString(16).padStart(64, '0');

export interface NftItem { contract: string; id: bigint; name: string; collection: string; image: string | null; tier?: string; type: string; }

let tiersCache: Promise<string> | null = null;
const loadTiers = () => (tiersCache ??= fetch('/robot-tiers.txt').then((r) => r.text()).then((t) => t.trim()).catch(() => ''));

/** Statera Robots owned by `owner`, read on-chain. */
async function robotsOf(owner: string): Promise<NftItem[]> {
  const bal = await mCall(ROBOTS, '0x70a08231' + pad(owner));
  const n = bal && bal !== '0x' ? Number(BigInt(bal)) : 0;
  if (!n) return [];
  const tiers = await loadTiers();
  const out: NftItem[] = [];
  for (let i = 0; i < Math.min(n, 200); i++) {
    const idHex = await mCall(ROBOTS, '0x2f745c59' + pad(owner) + hexId(BigInt(i)));
    if (!idHex || idHex === '0x') continue;
    const id = BigInt(idHex);
    const artHex = await mCall(ROBOTS, '0xdaded9c6' + hexId(id));
    const art = artHex && artHex !== '0x' ? Number(BigInt(artHex)) : 0;
    out.push({ contract: ROBOTS, id, type: 'ERC-721', collection: 'X1City Statera Robots',
      name: art ? `Statera Robot #${art}` : `Token #${id}`, image: art ? `${ROBOTS_IMG}${art}.png` : null, tier: art ? tiers[art - 1] : undefined });
  }
  return out;
}

/** Other ERC-721 items from the explorer's per-item list (best effort). */
async function explorerItems(owner: string): Promise<NftItem[]> {
  try {
    const j = await req(`${CHAIN.api}/addresses/${owner.toLowerCase()}/nft?type=ERC-721`);
    const arr: any[] = j?.items || [];
    return arr.map((x: any) => {
      const t = x.token || {};
      const contract = String(t.address_hash || t.address || '').toLowerCase();
      return { contract, id: BigInt(x.id ?? 0), type: 'ERC-721', collection: t.name || t.symbol || 'NFT',
        name: x.metadata?.name || `${t.name || 'NFT'} #${x.id}`, image: gw(x.image_url || x.metadata?.image || null) } as NftItem;
    }).filter((it) => it.contract && it.contract !== ROBOTS);
  } catch { return []; }
}

export function NftPanel({ owner, wallet, isOwnWallet, collections }: { owner: string; wallet: string | null; isOwnWallet: boolean; collections: NftHolding[] }) {
  const [items, setItems] = useState<NftItem[] | null>(null);
  const [send, setSend] = useState<{ item: NftItem; burn: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const [detail, setDetail] = useState<NftItem | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    Promise.all([robotsOf(owner).catch(() => []), explorerItems(owner)]).then(([r, o]) => { if (alive) setItems([...r, ...o]); });
    return () => { alive = false; };
  }, [owner, tick]);

  // Collections the explorer knows about but whose items we couldn't list → keep the old collection card.
  const listed = new Set((items || []).map((i) => i.contract));
  const cardsOnly = collections.filter((c) => !listed.has(c.address.toLowerCase()) && c.address.toLowerCase() !== ROBOTS);
  const total = (items?.length || 0) + cardsOnly.length;
  if (items && !total) return null;

  return (
    <div className="pf-nfts">
      <div className="pf-nfts-head">NFTs <span>{items == null ? 'loading…' : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}</span></div>
      <div className="nf-grid">
        {(items || []).map((it) => {
          const t = it.tier ? TIER[it.tier] : null;
          return (
            <div className="nf-card" key={it.contract + ':' + it.id}>
              <button type="button" className="nf-img" onClick={() => setDetail(it)} title="Open details">
                <Art src={it.image} alt={it.name} id={it.id} contract={it.contract} />
                {t && <span className="nf-tier" style={{ color: t[1], borderColor: t[1] + '66' }}>{t[0]}</span>}
              </button>
              <div className="nf-meta" onClick={() => setDetail(it)}>
                <span className="nf-nm">{it.name}</span>
                <span className="nf-col">{it.collection} · #{String(it.id)}</span>
              </div>
              {isOwnWallet && wallet && <div className="nf-acts">
                <button className="nf-send" onClick={() => setSend({ item: it, burn: false })}><IconSend className="i" /> Send</button>
                <button className="nf-burn" onClick={() => setSend({ item: it, burn: true })} title="Send to the dead address — gone for good">🔥 Burn</button>
              </div>}
            </div>
          );
        })}
        {cardsOnly.map((n) => (
          <a className="pf-nft" key={n.address} href={`${CHAIN.scan}/token/${n.address}`} target="_blank" rel="noreferrer" title={n.name}>
            <TokenLogo symbol={n.symbol || n.name} seed={n.address} url={n.icon} />
            <span className="pf-nft-id">
              <span className="pf-nft-nm">{n.name}</span>
              <span className="pf-nft-ct">{compact(n.count)} {n.type.includes('1155') ? 'items' : n.count === 1 ? 'NFT' : 'NFTs'}</span>
            </span>
          </a>
        ))}
      </div>
      {detail && <NftDetail item={detail} owner={owner} canAct={isOwnWallet && !!wallet} onClose={() => setDetail(null)}
        onSend={(burn) => { setSend({ item: detail, burn }); setDetail(null); }} />}
      {send && wallet && <NftSendModal item={send.item} burn={send.burn} wallet={wallet} onClose={() => setSend(null)} onSent={() => setTimeout(() => setTick((x) => x + 1), 4000)} />}
    </div>
  );
}

async function ensureArc(eth: any): Promise<boolean> {
  try {
    const cur = await eth.request({ method: 'eth_chainId' });
    if (typeof cur === 'string' && cur.toLowerCase() === ARC_CHAIN_HEX) return true;
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_HEX }] });
    return true;
  } catch { return false; }
}

function NftSendModal({ item, burn = false, wallet, onClose, onSent }: { item: NftItem; burn?: boolean; wallet: string; onClose: () => void; onSent?: () => void }) {
  const [to, setTo] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => { const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', onEsc); return () => document.removeEventListener('keydown', onEsc); }, [onClose]);

  const recipient = burn ? DEAD : to.trim();
  const validTo = burn ? confirm.trim().toUpperCase() === 'BURN' : isAddress(recipient) && recipient.toLowerCase() !== wallet.toLowerCase();
  const verb = burn ? 'Burn' : 'Send', done = burn ? 'Burned' : 'Sent';
  const isRobot = item.contract === ROBOTS;

  const sendIt = async () => {
    if (!validTo || phase === 'sending') return;
    const eth = activeEth();
    setPhase('sending'); setHash(null);
    try {
      if (!eth) throw new Error('No wallet found.');
      if (!(await ensureArc(eth))) throw new Error('Switch your wallet to Arc mainnet to send.');
      // safeTransferFrom(from, to, id) — refuses to drop the NFT into a contract that can't hold NFTs.
      const data = '0x42842e0e' + pad(wallet) + pad(recipient) + hexId(item.id);
      const params = { from: wallet, to: item.contract, data, value: '0x0' };
      setMsg('Checking the transfer…');
      const sim = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [params, 'latest'] }) }).then((x) => x.json()).catch(() => null);
      if (sim?.error) throw new Error(`This ${verb.toLowerCase()} would fail (${sim.error.message || 'reverted'}). Nothing was sent.`);
      setMsg('Confirm in your wallet…');
      const txHash: string = await eth.request({ method: 'eth_sendTransaction', params: [params] });
      setHash(txHash); setMsg('Sent — waiting for confirmation…');
      for (let i = 0; i < 40; i++) {
        const r = await eth.request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null);
        if (r) { const ok = BigInt(r.status) === 1n; setPhase(ok ? 'done' : 'error'); setMsg(ok ? `${done} ${item.name}.` : 'Transaction reverted.'); if (ok) onSent?.(); return; }
        await new Promise((res) => setTimeout(res, 1500));
      }
      setPhase('done'); setMsg(`${done} ${item.name} (still confirming).`); onSent?.();
    } catch (e: any) {
      setPhase('error'); setMsg(e?.message?.includes('User denied') || e?.code === 4001 ? 'Cancelled in wallet.' : (e?.message || 'Send failed.'));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal send-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-head">
          {item.image ? <img className="nf-thumb" src={item.image} alt="" /> : <span className="nf-thumb" />}
          <div className="sm-title"><b>{verb} {item.name}</b><span>{item.collection} · token #{String(item.id)}</span></div>
          <button className="sm-x" onClick={onClose} aria-label="close"><IconClose /></button>
        </div>
        <div className="sm-body">
          {burn ? (
            <div className="sm-field">
              <div className="nf-burn-warn">
                <b>This destroys the NFT for good.</b> It goes to the dead address <code>{DEAD}</code> — nobody can ever move it back.
                {isRobot && <> This is a Statera Robot: burning it also gives up the X1 City citizenship that comes with it.</>}
              </div>
              <label>Type BURN to confirm</label>
              <input className="sm-in mono" placeholder="BURN" value={confirm} onChange={(e) => setConfirm(e.target.value)} spellCheck={false} />
            </div>
          ) : (
            <div className="sm-field">
              <label>Recipient (Arc address)</label>
              <input className="sm-in mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
              {to && !isAddress(recipient) && <span className="sm-warn">Enter a valid 0x… address</span>}
              {to && isAddress(recipient) && !validTo && <span className="sm-warn">That's the wallet it's already in</span>}
            </div>
          )}
          <button className={'btn solid sm-send' + (burn ? ' nf-burn-go' : '')} onClick={sendIt} disabled={!validTo || phase === 'sending' || phase === 'done'}>
            {phase === 'sending' ? (burn ? 'Burning…' : 'Sending…') : phase === 'done' ? done : `${verb} ${item.name}`}
          </button>
          {msg && (
            <div className={`sm-status ${phase}`}>
              {msg}
              {hash && <> · <a href={`https://explorer.arc.io/tx/${hash}`} target="_blank" rel="noreferrer">View tx <IconExternal className="i" /></a></>}
            </div>
          )}
          {isRobot && !burn && <p className="sm-note">The X1 City citizenship goes with the Robot: the new owner claims it on x1city.io.</p>}
          <p className="sm-note">Sends on Arc mainnet (chain 5042). Double-check the address — NFT transfers are irreversible. Gas is paid in USDC.</p>
        </div>
      </div>
    </div>
  );
}

// ───────────── NFT detail card (click a tile) — styled after the x1brains.io LabWork marketplace card ─────────────
const ROBOT_TIER_COUNT: Record<string, number> = { Mythic: 88, Legendary: 379, Epic: 658, Rare: 1192, Common: 2127 };
const traitColor = (k: string, v: string) => {
  if (!/rarity|tier|grade/i.test(k)) return null;
  const hit = Object.values(TIER).find(([n]) => n.toLowerCase() === v.toLowerCase());
  return hit ? hit[1] : null;
};
function decodeStr(hex: string): string | null {
  try {
    const h = hex.replace(/^0x/, ''); const len = Number(BigInt('0x' + h.slice(64, 128)));
    const bytes = h.slice(128, 128 + len * 2); const arr = new Uint8Array(bytes.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(bytes.substr(i * 2, 2), 16);
    return new TextDecoder().decode(arr) || null;
  } catch { return null; }
}
interface Meta { name?: string; description?: string; image?: string; external_url?: string; seller_fee_basis_points?: number; attributes?: { trait_type?: string; value?: any }[] }

function NftDetail({ item, owner, canAct, onClose, onSend }: { item: NftItem; owner: string; canAct: boolean; onClose: () => void; onSend: (burn: boolean) => void }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'none'>('loading');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await mCall(item.contract, '0xc87b56dd' + hexId(item.id));
        const u = r && r !== '0x' ? decodeStr(r) : null;
        if (!u) throw new Error('no uri');
        if (alive) setUri(u);
        let j: Meta;
        if (u.startsWith('data:application/json')) {
          const body = u.slice(u.indexOf(',') + 1);
          j = JSON.parse(u.includes(';base64,') ? atob(body) : decodeURIComponent(body));
        } else j = await fetchJson(u);
        if (alive) { setMeta(j); setState('ok'); }
      } catch { if (alive) setState('none'); }
    })();
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onEsc);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { alive = false; document.removeEventListener('keydown', onEsc); document.body.style.overflow = prev; };
  }, [item.contract, item.id, onClose]);

  const isRobot = item.contract === ROBOTS;
  const image = item.image || (meta?.image ? gw(meta.image) : null);   // keep the tile's image; never swap it
  const attrs = (meta?.attributes || []).filter((a) => a && a.trait_type);
  const royalty = meta?.seller_fee_basis_points != null ? `${(meta.seller_fee_basis_points / 100).toFixed(1).replace(/\.0$/, '')}%` : null;
  const copy = () => { navigator.clipboard?.writeText(item.contract).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const links: [string, string][] = [
    ['Explorer', `https://explorer.arc.io/token/${item.contract}/instance/${item.id}`],
    ['ArcScan', `https://arc.etherscan.io/nft/${item.contract}/${item.id}`],
    ['OpenSea', `https://opensea.io/item/arc/${item.contract}/${item.id}`],
    ...(uri && !uri.startsWith('data:') ? [['Metadata', gw(uri)!] as [string, string]] : []),
    ...(image ? [['Image', image] as [string, string]] : []),
    ...(meta?.external_url ? [['Website', meta.external_url] as [string, string]] : []),
  ];

  return createPortal(
    <div className="nd-back" onClick={onClose}>
      <div className="nd-card" onClick={(e) => e.stopPropagation()}>
        <div className="nd-line" />
        <button className="nd-x" onClick={onClose} aria-label="close">×</button>
        <div className="nd-img"><Art src={image} alt={item.name} id={item.id} contract={item.contract} /></div>
        <div className="nd-info">
          <div className="nd-name">{meta?.name || item.name}</div>
          <div className="nd-col">{item.collection} <span className="nd-pill">{item.type}</span> <span className="nd-pill">#{String(item.id)}</span></div>
          {meta?.description && <p className="nd-desc">{meta.description.length > 260 ? meta.description.slice(0, 257) + '…' : meta.description}</p>}
          <div className="nd-sec">{state === 'loading' ? 'Traits — loading…' : `Traits — ${attrs.length}`}</div>
          {state === 'none' && <div className="nd-empty">No metadata found for this item.</div>}
          {!!attrs.length && <div className="nd-traits">
            {attrs.map((a, i) => {
              const v = String(a.value ?? ''); const col = traitColor(a.trait_type!, v);
              const pct = isRobot && /rarity/i.test(a.trait_type!) && ROBOT_TIER_COUNT[v] ? ` · ${(ROBOT_TIER_COUNT[v] / 44.44).toFixed(1)}%` : '';
              return <div key={i} className="nd-trait" style={col ? { borderColor: col + '66', background: col + '12' } : undefined}>
                <span className="nd-tk">{a.trait_type}</span><span className="nd-tv" style={col ? { color: col } : undefined}>{v}{pct}</span>
              </div>;
            })}
          </div>}
          <div className="nd-specs">
            <div><span>Chain</span><b>Arc · 5042</b></div>
            <div><span>Standard</span><b>{item.type}</b></div>
            <div><span>Owner</span><b title={owner}>{owner.slice(0, 6)}…{owner.slice(-4)}</b></div>
            {royalty && <div><span>Royalty</span><b>{royalty}</b></div>}
          </div>
          <div className="nd-contract"><span>Contract</span><code>{item.contract}</code><button onClick={copy}>{copied ? 'COPIED' : 'COPY'}</button></div>
          <div className="nd-links">{links.map(([l, h]) => <a key={l} href={h} target="_blank" rel="noreferrer">{l} <IconExternal className="i" /></a>)}</div>
          {canAct && <div className="nd-acts">
            <button className="nd-go" onClick={() => onSend(false)}><IconSend className="i" /> Send</button>
            <button className="nd-burn" onClick={() => onSend(true)}>🔥 Burn</button>
          </div>}
        </div>
      </div>
    </div>, document.body);
}
