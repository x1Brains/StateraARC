#!/usr/bin/env node
// board-watch — tells the owner on ntfy when a token with real wallets is off the StateraArc board, a listed token drops off, or the
// list stops updating. Runs on the VPS after each snapshot (statera-board-watch.timer). Reads only; it changes nothing on the site.
// ⛔ 10-31 (KAIRO): the board can't show what it's missing, so this starts from the swap store. `--dry` prints and sends nothing.
// Silence a checked token: add its address + reason to /root/board-watch/ack.json.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DIR = process.env.WATCH_DIR || '/root/board-watch', STATE = `${DIR}/state.json`, ACK = `${DIR}/ack.json`;
const SNAP = process.env.SNAPSHOT || '/root/statera-live/tokens-snapshot.json', SWAPS = process.env.SWAPS_DB || '/root/statera-swaps/swaps.db';
const DRY = process.argv.includes('--dry');
const MIN_WALLETS = 25, MIN_TRADES = 20, MIN_VOL = 100, WASH = 0.02, QUIET_H = 72, MAX_CHECK = 60; // judged by wallets, not one volume cut (owner: slow days happen)
const KEEP_LIQ = 10_000, KEEP_MCAP = 50_000, REPEAT_H = 24, STALE_MIN = 90;
// ⛔ 11-11: a vanity-address spam factory floods Arc with tokens ground to end in 7777/77777 (identical ~$2.8K seed liq,
// 3-6 holders, DONTBUY/MEMESPAD names). The alerter skips them so the owner isn't pinged every run; this touches NOTHING
// on the public board or the indexer — the board still judges them by the alive rule on its own.
const SPAM = (a) => /7777$/.test(a || '');
const FARM_MIN = 6; // >= this many near-identical qualifiers = a coordinated wash farm (see pass 2 below)

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function notify(title, body) {
  if (DRY) { console.log(`[ntfy] ${title}\n${body}`); return true; }
  const t = process.env.ALERT_TOPIC; if (!t) { console.log('no ALERT_TOPIC'); return false; }
  const r = await fetch(/^https?:/.test(t) ? t : `https://ntfy.sh/${t}`, { method: 'POST', body, headers: { Title: title, Tags: 'mag' }, signal: AbortSignal.timeout(15000) });
  return r.ok;
}

// only for tokens about to be reported — the indexer's state file is too big to load here
async function symbolOf(t) {
  try {
    const j = await (await fetch('https://arc.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: t, data: '0x95d89b41' }, 'latest'] }) })).json();
    const b = Buffer.from(j.result.slice(2), 'hex'); return b.subarray(64, 64 + Number(BigInt('0x' + b.subarray(32, 64).toString('hex')))).toString('utf8') || '?';
  } catch { return '?'; }
}

const now = Date.now(), nowS = Math.floor(now / 1000);
const st = read(STATE, { sent: {}, listed: {} }), ack = read(ACK, {});
const snapRaw = read(SNAP, null);
if (!snapRaw?.tokens?.length) { await notify('Statera: list unreadable', 'The token list file could not be read.'); process.exit(0); }
const board = new Map(snapRaw.tokens.filter((t) => !t.bad).map((t) => [t.address, t]));
const due = (k) => now - (st.sent[k] || 0) > REPEAT_H * 3600e3;
const lines = [];

// 1) the list itself
const ageMin = (now - Date.parse(snapRaw.generatedAt)) / 60000;
if (ageMin > STALE_MIN && due('stale')) { lines.push(`List not updated for ${Math.round(ageMin)} min`); st.sent.stale = now; }
const prevN = Object.keys(st.listed).length;
const shrank = prevN > 0 && board.size < st.count * 0.9;
if (shrank && due('shrank')) { lines.push(`List shrank: ${st.count} to ${board.size} tokens`); st.sent.shrank = now; }

// 2) listed tokens that dropped off (a failed build above would flag everything, so it's skipped then)
if (!shrank) for (const [a, o] of Object.entries(st.listed)) {
  if (board.has(a) || ack[a] || SPAM(a) || !due(a)) continue;
  lines.push(`Dropped: ${o.s} liq $${Math.round(o.l).toLocaleString('en-US')} ${a}`); st.sent[a] = now;
}

// 3) real trading, not on the board
const db = new DatabaseSync(SWAPS, { readOnly: true }); db.exec('PRAGMA busy_timeout=5000');
const rows = db.prepare(`SELECT p.token t, SUM(c.v) v, SUM(c.n) n, MAX(c.t) last FROM c1m c JOIN pools p ON p.pid = c.pid
  WHERE c.t >= ? AND p.ok = 1 GROUP BY p.token`).all(nowS - 7 * 86400);
const cand = rows.filter((r) => !board.has(r.t) && !ack[r.t] && !SPAM(r.t) && r.n >= MIN_TRADES && r.v >= MIN_VOL && nowS - r.last < QUIET_H * 3600)
  .sort((a, b) => b.v - a.v).slice(0, MAX_CHECK);
const q = db.prepare(`SELECT COUNT(DISTINCT m.maker) w, SUM(CASE WHEN s.side > 0 THEN s.usd ELSE 0 END) b, SUM(CASE WHEN s.side < 0 THEN s.usd ELSE 0 END) se
  FROM swaps s JOIN pools p ON p.pid = s.pid JOIN makers m ON m.tx = s.tx WHERE p.token = ? AND p.ok = 1 AND s.ts >= ?`);
// Pass 1: qualify by real wallets, drop simple wash round-trips
const qual = [];
for (const r of cand) {
  const x = q.get(r.t, nowS - 7 * 86400);
  const wash = Math.abs(x.b - x.se) / Math.max(x.b + x.se, 1) < WASH; // buys = sells within the swap fee: a bot round trip
  if (x.w < MIN_WALLETS || wash) continue;
  qual.push({ r, w: x.w });
}
// ⛔ 11-11: a scam bot-farm cycles near-identical fake volume across dozens of tokens at once (one wave = 56 tokens, all
// ~75 wallets / ~$23K 7d / ~200 trades — Scamgoor, PUSSY×6, DERP404…). Organic coins never line up that tightly, so a
// token is treated as farm (and NOT pinged) when >= FARM_MIN qualifiers share its volume (±15%) and wallets (±20%). A
// genuine lone missing token (KAIRO) has no such twins and still alerts. Alerter-only: the board + indexer are untouched.
const near = (a, b) => Math.abs(a.r.v - b.r.v) <= 0.15 * b.r.v && Math.abs(a.w - b.w) <= 0.2 * b.w + 3;
let real = 0, muted = 0;
for (const c of qual) {
  if (qual.filter((o) => near(c, o)).length >= FARM_MIN) { muted++; if (DRY) console.log(`farm-muted ${c.r.t} wallets ${c.w} vol7d ${Math.round(c.r.v)}`); continue; }
  real++;
  const sym = await symbolOf(c.r.t);
  if (DRY) console.log(`candidate ${sym} ${c.r.t} wallets ${c.w} vol7d ${Math.round(c.r.v)} trades ${c.r.n}`);
  if (!due(c.r.t)) continue;
  lines.push(`Not listed: ${sym} ${c.w} wallets, $${Math.round(c.r.v).toLocaleString('en-US')} 7d ${c.r.t}`); st.sent[c.r.t] = now;
}
db.close();

// remember what's listed and worth watching
st.count = board.size; st.listed = {};
for (const [a, t] of board) if (!SPAM(a) && ((t.liq ?? 0) >= KEEP_LIQ || (t.mcap ?? 0) >= KEEP_MCAP)) st.listed[a] = { s: t.symbol, l: t.liq ?? 0 };
for (const k of Object.keys(st.sent)) if (now - st.sent[k] > 14 * 86400e3) delete st.sent[k];

console.log(`[board-watch] ${new Date(now).toISOString()} board ${board.size} watched ${Object.keys(st.listed).length} checked ${cand.length} real ${real} farmMuted ${muted} alerts ${lines.length}`);
if (lines.length) await notify('Statera board check', lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n+${lines.length - 12} more` : ''));
if (!DRY) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE + '.tmp', JSON.stringify(st)); fs.renameSync(STATE + '.tmp', STATE); }
