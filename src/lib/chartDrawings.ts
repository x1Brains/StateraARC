// Drawing tools for the token chart (lightweight-charts v5 series primitive): horizontal line, trend line, ray, rectangle,
// Fibonacci retracement and a price-range ruler. Points are stored as (unix time, USD price) so a drawing stays put across
// timeframes and the Price / MCap switch; the chart supplies time→x (interpolated over its bars, extrapolated past them).
import type { ISeriesPrimitive, SeriesAttachedParameter, IPrimitivePaneView, IPrimitivePaneRenderer, ISeriesApi, SeriesType, Time } from 'lightweight-charts';

export type Tool = 'pointer' | 'hline' | 'trend' | 'ray' | 'rect' | 'fib' | 'measure';
export const TOOL_POINTS: Record<Tool, number> = { pointer: 0, hline: 1, trend: 2, ray: 2, rect: 2, fib: 2, measure: 2 };
export interface Pt { t: number; p: number }
export interface Drawing { id: string; tool: Exclude<Tool, 'pointer'>; pts: Pt[] }
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const COL = '#ff9a3c', SEL = '#ffd27a', UP = '#5ad18a', DN = '#ff5a5a';

type Ctx = CanvasRenderingContext2D;
export class Drawings implements ISeriesPrimitive<Time> {
  items: Drawing[] = [];
  draft: Drawing | null = null;   // the drawing being placed (its last point follows the cursor)
  selected: string | null = null;
  scale = 1;                      // price → displayed value (market cap mode multiplies by supply)
  fmt: (v: number) => string = (v) => String(v);
  timeToX: (t: number) => number | null = () => null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private req: (() => void) | null = null;
  private view: IPrimitivePaneView;
  constructor() {
    const self = this;
    const renderer: IPrimitivePaneRenderer = { draw(target) { target.useMediaCoordinateSpace(({ context, mediaSize }) => self.paint(context, mediaSize.width, mediaSize.height)); } };
    this.view = { renderer: () => renderer, zOrder: () => 'top' };
  }
  attached(p: SeriesAttachedParameter<Time>) { this.series = p.series; this.req = p.requestUpdate; }
  detached() { this.series = null; this.req = null; }
  updateAllViews() { /* coordinates are computed at paint time */ }
  paneViews() { return [this.view]; }
  redraw() { this.req?.(); }

  private y(p: number): number | null { const v = this.series?.priceToCoordinate(p * this.scale); return v == null ? null : v; }
  private xy(pt: Pt): [number, number] | null { const x = this.timeToX(pt.t), y = this.y(pt.p); return x == null || y == null ? null : [x, y]; }

  private paint(c: Ctx, W: number, H: number) {
    const all = this.draft ? [...this.items, this.draft] : this.items;
    for (const d of all) {
      const sel = d.id === this.selected, col = sel ? SEL : COL;
      c.save(); c.strokeStyle = col; c.fillStyle = col; c.lineWidth = sel ? 2 : 1.4; c.font = '11px JetBrains Mono, monospace';
      const a = d.pts[0] && this.xy(d.pts[0]), b = d.pts[1] && this.xy(d.pts[1]);
      if (d.tool === 'hline' && a) {
        line(c, 0, a[1], W, a[1]); label(c, this.fmt(d.pts[0].p * this.scale), W - 4, a[1] - 4, col, 'right');
      } else if ((d.tool === 'trend' || d.tool === 'ray') && a && b) {
        let [x2, y2] = b;
        if (d.tool === 'ray' && x2 !== a[0]) { const k = (y2 - a[1]) / (x2 - a[0]); x2 = x2 > a[0] ? W : 0; y2 = a[1] + k * (x2 - a[0]); }
        line(c, a[0], a[1], x2, y2); dot(c, a); if (d.tool === 'trend') dot(c, b);
      } else if (d.tool === 'rect' && a && b) {
        c.globalAlpha = 0.12; c.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.globalAlpha = 1; c.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      } else if (d.tool === 'fib' && a && b) {
        const p0 = d.pts[0].p, p1 = d.pts[1].p, x0 = Math.min(a[0], b[0]), x1 = Math.max(W, Math.max(a[0], b[0]));
        for (const f of FIB) {
          const p = p1 + (p0 - p1) * f, y = this.y(p); if (y == null) continue;
          c.globalAlpha = f === 0 || f === 1 ? 1 : 0.75; line(c, x0, y, x1, y);
          label(c, `${f.toFixed(3)}  ${this.fmt(p * this.scale)}`, x0 + 4, y - 3, col, 'left');
        }
        c.globalAlpha = 0.35; c.setLineDash([4, 4]); line(c, a[0], a[1], b[0], b[1]); c.setLineDash([]);
      } else if (d.tool === 'measure' && a && b) {
        const up = d.pts[1].p >= d.pts[0].p, mc = up ? UP : DN;
        c.fillStyle = mc; c.strokeStyle = mc; c.globalAlpha = 0.14; c.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); c.globalAlpha = 1;
        line(c, a[0], a[1], b[0], b[1]);
        const pct = ((d.pts[1].p - d.pts[0].p) / d.pts[0].p) * 100, dv = (d.pts[1].p - d.pts[0].p) * this.scale;
        const secs = Math.abs(d.pts[1].t - d.pts[0].t);
        const txt = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  ${dv >= 0 ? '+' : '−'}${this.fmt(Math.abs(dv))}  ${dur(secs)}`;
        label(c, txt, (a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 6, mc, 'center', true);
      } else if (a) dot(c, a);
      c.restore();
    }
    void H;
  }
  // nearest drawing within `tol` px of (x, y), for selecting with the pointer tool
  hit(x: number, y: number, tol = 6): string | null {
    let best: string | null = null, bd = tol;
    for (const d of this.items) {
      const a = d.pts[0] && this.xy(d.pts[0]), b = d.pts[1] && this.xy(d.pts[1]);
      let dist = Infinity;
      if (d.tool === 'hline' && a) dist = Math.abs(y - a[1]);
      else if (a && b && (d.tool === 'trend' || d.tool === 'ray' || d.tool === 'measure')) dist = segDist(x, y, a, b);
      else if (a && b && (d.tool === 'rect' || d.tool === 'fib')) {
        const inX = x >= Math.min(a[0], b[0]) - tol && (d.tool === 'fib' || x <= Math.max(a[0], b[0]) + tol), inY = y >= Math.min(a[1], b[1]) - tol && y <= Math.max(a[1], b[1]) + tol;
        dist = inX && inY ? 0 : Infinity;
      }
      if (dist <= bd) { bd = dist; best = d.id; }
    }
    return best;
  }
}
function line(c: Ctx, x1: number, y1: number, x2: number, y2: number) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function dot(c: Ctx, p: [number, number]) { c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2); c.fill(); }
function label(c: Ctx, t: string, x: number, y: number, col: string, align: CanvasTextAlign, box = false) {
  c.textAlign = align;
  if (box) { const w = c.measureText(t).width + 10, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x; c.fillStyle = 'rgba(10,10,12,.85)'; c.fillRect(x0, y - 13, w, 17); }
  c.fillStyle = col; c.fillText(t, x, y);
}
function segDist(x: number, y: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
function dur(s: number) { return s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`; }

const KEY = (token: string) => `statera-draw-v1:${token.toLowerCase()}`;
export function loadDrawings(token: string): Drawing[] { try { const j = JSON.parse(localStorage.getItem(KEY(token)) || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } }
export function saveDrawings(token: string, d: Drawing[]) { try { if (d.length) localStorage.setItem(KEY(token), JSON.stringify(d)); else localStorage.removeItem(KEY(token)); } catch { /* storage blocked: drawings last for this visit */ } }
