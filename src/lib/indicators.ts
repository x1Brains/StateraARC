// Chart indicators, computed in the browser from the candles the chart already has (no extra requests).
// Each returns one value per input bar (null while there isn't enough history yet), aligned by index.
export interface OHLCV { time: number; open: number; high: number; low: number; close: number; volume?: number }
type S = (number | null)[];

export function sma(v: number[], n: number): S {
  const out: S = new Array(v.length).fill(null); let sum = 0;
  for (let i = 0; i < v.length; i++) { sum += v[i]; if (i >= n) sum -= v[i - n]; if (i >= n - 1) out[i] = sum / n; }
  return out;
}
export function ema(v: number[], n: number): S {
  const out: S = new Array(v.length).fill(null); const k = 2 / (n + 1); let e: number | null = null, seed = 0;
  for (let i = 0; i < v.length; i++) {
    if (e == null) { seed += v[i]; if (i === n - 1) { e = seed / n; out[i] = e; } continue; }
    e = v[i] * k + e * (1 - k); out[i] = e;
  }
  return out;
}
export function bollinger(v: number[], n = 20, mult = 2): { mid: S; up: S; lo: S } {
  const mid = sma(v, n), up: S = new Array(v.length).fill(null), lo: S = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    const m = mid[i]!; let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m) ** 2;
    const sd = Math.sqrt(s / n); up[i] = m + mult * sd; lo[i] = m - mult * sd;
  }
  return { mid, up, lo };
}
// VWAP anchored to each UTC day (resets at 00:00 UTC) — the usual intraday VWAP; on daily+ candles it is just the typical price.
export function vwap(b: OHLCV[]): S {
  const out: S = []; let pv = 0, vol = 0, day = -1;
  for (const k of b) {
    const d = Math.floor(k.time / 86400); if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (k.high + k.low + k.close) / 3, w = k.volume || 0;
    pv += tp * w; vol += w; out.push(vol > 0 ? pv / vol : tp);
  }
  return out;
}
export function rsi(v: number[], n = 14): S {
  const out: S = new Array(v.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
export function macd(v: number[], f = 12, s = 26, sig = 9): { macd: S; signal: S; hist: S } {
  const ef = ema(v, f), es = ema(v, s);
  const m: S = v.map((_, i) => (ef[i] != null && es[i] != null ? ef[i]! - es[i]! : null));
  const firstIdx = m.findIndex((x) => x != null);
  const sg: S = new Array(v.length).fill(null);
  if (firstIdx >= 0) { const e = ema(m.slice(firstIdx) as number[], sig); e.forEach((x, i) => { sg[firstIdx + i] = x; }); }
  const h: S = m.map((x, i) => (x != null && sg[i] != null ? x - sg[i]! : null));
  return { macd: m, signal: sg, hist: h };
}
export function heikinAshi(b: OHLCV[]): OHLCV[] {
  const out: OHLCV[] = [];
  for (let i = 0; i < b.length; i++) {
    const k = b[i], c = (k.open + k.high + k.low + k.close) / 4;
    const o = i === 0 ? (k.open + k.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: k.time, open: o, close: c, high: Math.max(k.high, o, c), low: Math.min(k.low, o, c), volume: k.volume });
  }
  return out;
}
