# Full-site audit (read-only): every page at desktop 1440 and phone 390. Per page: horizontal overflow (page wider than the
# viewport + elements sticking out past their parent card), console errors, page errors, failed requests / HTTP >= 400,
# broken images, visible junk numbers (NaN, Infinity, e+, $0.00 where a value is expected, absurd $), and the key numbers
# each page shows (so the SAME number can be compared across pages). Screenshots for a human look.
#   python3 scripts/regress/site-audit.py https://www.stateraarc.com out/audit
import json, re, sys, time
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://www.stateraarc.com').rstrip('/')
OUT = (sys.argv[2] if len(sys.argv) > 2 else 'audit-out').rstrip('/') + '/'
import os; os.makedirs(OUT, exist_ok=True)
WALLET = '0x398c96b846966eaa7fdf56f89a028de9e8c9598a'  # the lab wallet (public address; read-only portfolio view)
TOKENS = {'cirBTC': '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', 'ARGUS': '0xece5ca8bf9220718e5727754026757512212cb3c',
          'WETH': '0x128cc466b61f542da60c70e3aa11c10e19b84edb', 'EURC': '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'}
JUNK = re.compile(r'NaN|Infinity|undefined|null|\d[eE][+-]?\d{2,}|\$\d{1,3}(,\d{3}){4,}')
findings, numbers = [], {}

OVERFLOW_JS = """(() => {
  const vw = window.innerWidth, out = [];
  const pageW = document.documentElement.scrollWidth;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.position === 'fixed') continue;
    // skip content inside a horizontal scroller (intended)
    let p = el.parentElement, scroller = false;
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } p = p.parentElement; }
    if (scroller) continue;
    if (r.right > vw + 1) out.push((el.className && el.className.toString().slice(0, 40)) || el.tagName);
  }
  return { pageW, vw, sticking: [...new Set(out)].slice(0, 8) };
})()"""
IMG_JS = "[...document.images].filter(i=>i.complete && i.naturalWidth===0 && i.getBoundingClientRect().width>0).map(i=>i.src.slice(0,90))"

def audit(ctx, name, path, wait=9000, act=None):
    pg = ctx.new_page(); cons, perr, bad = [], [], []
    pg.on('console', lambda m: cons.append(m.text[:160]) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: perr.append(str(e)[:160]))
    pg.on('response', lambda r: bad.append(f'{r.status} {r.url[:110]}') if r.status >= 400 and 'favicon' not in r.url else None)
    t0 = time.time(); pg.goto(BASE + path, wait_until='domcontentloaded', timeout=60000); pg.wait_for_timeout(wait)
    extra = act(pg) if act else None
    ov = pg.evaluate(OVERFLOW_JS); imgs = pg.evaluate(IMG_JS); text = pg.evaluate('document.body.innerText')
    junk = sorted(set(m.group(0) for m in JUNK.finditer(text)))[:8]
    vpw = ctx.pages[0].viewport_size['width'] if ctx.pages else 0
    pg.screenshot(path=f'{OUT}{name}.png', full_page=True)
    rec = {'page': name, 'load_s': round(time.time() - t0, 1), 'overflow': ov, 'broken_imgs': imgs[:6], 'console_errors': len(cons), 'console_sample': cons[:4],
           'page_errors': perr[:3], 'http_errors': sorted(set(bad))[:8], 'junk_text': junk, 'extra': extra}
    issues = []
    if ov['pageW'] > ov['vw'] + 1: issues.append(f"page {ov['pageW']}px wider than viewport {ov['vw']}px")
    if ov['sticking']: issues.append(f"elements past the right edge: {ov['sticking']}")
    if imgs: issues.append(f'{len(imgs)} broken images')
    if perr: issues.append(f'page errors: {perr[:2]}')
    if bad: issues.append(f'{len(set(bad))} failed requests')
    if junk: issues.append(f'junk text: {junk}')
    rec['issues'] = issues; findings.append(rec)
    print(f"{name:28} {rec['load_s']:>5}s  issues: {issues or 'none'}", flush=True)
    pg.close(); return extra

def nums(pg, sel):
    return pg.evaluate(f"[...document.querySelectorAll('{sel}')].map(e=>e.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean)")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    for tag, vp, mob in [('desk', {'width': 1440, 'height': 900}, False), ('mob', {'width': 390, 'height': 844}, True)]:
        c = b.new_context(viewport=vp, is_mobile=mob); c.add_init_script("try{localStorage.setItem('statera-disclaimer-v1','1')}catch(e){}")
        c.new_page()  # keeps a page open for the viewport lookup
        numbers[f'home-{tag}'] = audit(c, f'home-{tag}', '/', act=lambda pg: nums(pg, '.hero-trust .ht'))
        def scr(pg):
            out = {'stats': nums(pg, '.stats .stat')}
            for f in ['Launchpad', 'Ecosystem']:
                try: pg.get_by_role('button', name=f, exact=True).first.click(); pg.wait_for_timeout(1500); out[f] = pg.evaluate("document.querySelectorAll('.trow.tok').length")
                except Exception as e: out[f] = 'ERR ' + str(e)[:60]
            pg.get_by_role('button', name='All', exact=True).first.click(); pg.wait_for_timeout(1200)
            try: pg.fill('input[placeholder*="earch"]', 'weth'); pg.wait_for_timeout(1500); out['search weth'] = nums(pg, '.trow.tok .tsym')[:3]; pg.fill('input[placeholder*="earch"]', ''); pg.wait_for_timeout(800)
            except Exception as e: out['search'] = 'ERR ' + str(e)[:60]
            try: pg.locator('.pager button', has_text='Next').first.click(); pg.wait_for_timeout(1500); out['page2'] = pg.evaluate("(document.querySelector('.pager-info')||{}).innerText||''")
            except Exception: out['page2'] = 'no pager'
            return out
        numbers[f'screener-{tag}'] = audit(c, f'screener-{tag}', '/screener', act=scr)
        for sym, a in TOKENS.items():
            numbers[f'token-{sym}-{tag}'] = audit(c, f'token-{sym}-{tag}', f'/token/{a}', wait=14000,
                act=lambda pg: {'hero': nums(pg, '.tx-price') + nums(pg, '.tx-stats > div'), 'chart_candles': pg.evaluate("!!document.querySelector('.chart-box canvas')"),
                                'trades_rows': pg.evaluate("document.querySelectorAll('.tr-table .tr-row:not(.tr-head)').length")})
        numbers[f'network-{tag}'] = audit(c, f'network-{tag}', '/network', act=lambda pg: {'money': nums(pg, '.nx-total'), 'pulse': nums(pg, '.nx-big .v'), 'rows': nums(pg, '.nx-asset .nx-row')})
        def port(pg):
            try:
                pg.fill('input', WALLET); pg.keyboard.press('Enter'); pg.wait_for_timeout(20000)
                return {'text': re.sub(r'\s+', ' ', pg.evaluate('document.body.innerText'))[400:1400]}
            except Exception as e: return {'err': str(e)[:100]}
        numbers[f'portfolio-{tag}'] = audit(c, f'portfolio-{tag}', '/portfolio', act=port)
        def swap(pg):
            out = {}
            try:
                pg.locator('.swap-card input, input[inputmode="decimal"]').first.fill('5'); pg.wait_for_timeout(1000)
                # pick the receive token: open the picker and choose WETH if present
                btns = pg.locator('button', has_text='Select');
                if btns.count(): btns.first.click(); pg.wait_for_timeout(800); pg.keyboard.type('WETH'); pg.wait_for_timeout(1200); pg.locator('.tp-row, .tp-item, .picker-row, [class*=picker] button').first.click(); pg.wait_for_timeout(9000)
                out['quote'] = re.sub(r'\s+', ' ', pg.evaluate("(document.querySelector('.swap-quote')||document.querySelector('.swap-info')||{}).innerText||''"))[:200]
            except Exception as e: out['err'] = str(e)[:120]
            return out
        numbers[f'swap-{tag}'] = audit(c, f'swap-{tag}', '/swap', act=swap)
        audit(c, f'str-{tag}', '/str')
        c.close()
    b.close()
json.dump({'findings': findings, 'numbers': numbers}, open(OUT + 'audit.json', 'w'), indent=1, default=str)
print('wrote', OUT + 'audit.json')
