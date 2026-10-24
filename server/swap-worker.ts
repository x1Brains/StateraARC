// swap-worker — runs swap-store queries OFF the API's main thread (node:sqlite is synchronous: one slow query used to freeze
// every request the API serves — home, board, visits, token pages; 10-21 outage). Two lanes: 'fast' (bars, history, flow, wallet
// swaps) and 'slow' (top traders / holder profitability — whole-history aggregates), so a slow ranking never delays a chart.
// A job over its deadline gets its worker terminated and respawned (a runaway query can't hold the lane).
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

if (!isMainThread && parentPort) {
  const S: Record<string, (...a: unknown[]) => unknown> = await import('./swap-store.ts') as any;
  parentPort.on('message', (m: { id: number; fn: string; args: unknown[] }) => {
    let r: unknown = null, err: string | null = null;
    try { r = S[m.fn](...m.args); } catch (e) { err = String((e as Error).message || e); }
    parentPort!.postMessage({ id: m.id, r, err });
  });
}

type Pending = { ok: (v: unknown) => void; ko: (e: Error) => void; timer: NodeJS.Timeout };
class Lane {
  private w: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private name: string; private ms: number; private heapMb: number;
  constructor(name: string, ms: number, heapMb: number) { this.name = name; this.ms = ms; this.heapMb = heapMb; }
  private spawn() {
    const w = new Worker(new URL(import.meta.url), { execArgv: ['--disable-warning=ExperimentalWarning'], resourceLimits: { maxOldGenerationSizeMb: this.heapMb, maxYoungGenerationSizeMb: 8 } });
    w.on('message', (m: { id: number; r: unknown; err: string | null }) => {
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.err) p.ko(new Error(m.err)); else p.ok(m.r);
    });
    const fail = (e: Error) => { if (this.w === w) this.w = null; for (const [, p] of this.pending) { clearTimeout(p.timer); p.ko(e); } this.pending.clear(); };
    w.on('error', fail); w.on('exit', () => fail(new Error(`${this.name} worker exited`)));
    w.unref();
    this.w = w;
  }
  call(fn: string, args: unknown[]): Promise<unknown> {
    if (!this.w) this.spawn();
    const id = ++this.seq, w = this.w!;
    return new Promise((ok, ko) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); ko(new Error(`${fn} timed out`));
        poolStats.timeouts++;
        // the worker is stuck in a query: kill it (its other jobs fail and are retried by their callers)
        if (this.w === w) { this.w = null; w.terminate().catch(() => {}); }
      }, this.ms);
      this.pending.set(id, { ok, ko, timer });
      w.postMessage({ id, fn, args });
    });
  }
}
export const poolStats = { calls: 0, timeouts: 0, dedup: 0 };
// 3 lanes (10-21 load test: cirBTC's money flow — a 7-day join over the maker history — ran 12 s after a restart in the SAME lane
// as the chart, so the chart and trade history queued behind it and were dropped with it): charts + trades + wallet swaps never
// wait on flow or on the whole-history rankings
// heap caps (10-23 OOM kills): a worker that outgrows its cap dies alone and respawns — the API process keeps serving
const fast = new Lane('fast', 12_000, 56), mid = new Lane('mid', 30_000, 56), slow = new Lane('slow', 60_000, 112);
const SLOW = new Set(['topTraders', 'profitability']), MID = new Set(['flow']);
const inflight = new Map<string, Promise<unknown>>();
/** Run a swap-store function in a worker; identical concurrent calls share one run. */
export function swapCall<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
  poolStats.calls++;
  const k = fn + JSON.stringify(args);
  const hit = inflight.get(k); if (hit) { poolStats.dedup++; return hit as Promise<T>; }
  const p = (SLOW.has(fn) ? slow : MID.has(fn) ? mid : fast).call(fn, args).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p as Promise<T>;
}
