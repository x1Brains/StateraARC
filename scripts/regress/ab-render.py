# Render-level A/B: two local builds (old on :4174, new on :4173) with live RPC/RadarDEX blocked so both render the same
# static snapshot; compares home stats, dashboard tabs, screener rows per filter/view, search. Logo placeholders can differ
# by image-load timing (a letter avatar vs a logo) — compare names, not that.
import re, json
from playwright.sync_api import sync_playwright
LIVE = re.compile(r'(arc\.io|drpc|tenderly|blockdaemon|quicknode|/api/radar|/api/warp|coinbase|xdex|abacus|arc-scan)')
def grab(base):
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True); c = b.new_context(viewport={'width': 1440, 'height': 900})
        c.add_init_script("try{localStorage.setItem('statera-disclaimer-v1','1')}catch(e){}")
        c.route(LIVE, lambda r: r.abort())
        pg = c.new_page(); pg.goto(base + '/'); pg.wait_for_timeout(6000)
        txt = pg.evaluate('document.body.innerText')
        out['home_stats'] = pg.evaluate("Array.from(document.querySelectorAll('.hero-trust *, .dash-stats *')).filter(e=>!e.children.length).map(e=>e.innerText.trim()).filter(Boolean)")
        n = pg.evaluate("document.querySelectorAll('.dash-tabs button:not(.dash-all)').length")
        out['dash_tab_count'] = [n]
        for i in range(n):
            pg.locator('.dash-tabs button:not(.dash-all)').nth(i).click(); pg.wait_for_timeout(600)
            out['dash_tab%d' % i] = pg.evaluate("Array.from(document.querySelectorAll('.dash-row')).map(e=>e.innerText.replace(/\\s+/g,' ').slice(0,40))")
        pg.goto(base + '/screener'); pg.wait_for_timeout(5000)
        rows = lambda: pg.evaluate("Array.from(document.querySelectorAll('.trow.tok')).map(r=>(r.querySelector('.tname')||{}).innerText+'|'+(r.querySelector('.tsym')||{}).innerText)")
        out['screener_default'] = rows()
        out['screener_stats'] = pg.evaluate("Array.from(document.querySelectorAll('.stats .stat')).map(e=>e.innerText.replace(/\\s+/g,' '))")
        for name in ['Launchpad', 'Ecosystem', 'Gainers', 'Losers', 'Trending']:
            pg.get_by_role('button', name=name, exact=True).first.click(); pg.wait_for_timeout(700); out['screener_' + name] = rows()
            if name in ('Launchpad', 'Ecosystem'): pg.get_by_role('button', name='All', exact=True).first.click(); pg.wait_for_timeout(500)
        pg.get_by_role('button', name=re.compile('Show inactive')).first.click(); pg.wait_for_timeout(700); out['screener_inactive'] = rows()
        pg.fill('input[placeholder*="earch"]', 'arg'); pg.wait_for_timeout(800); out['search_arg'] = rows()
        b.close()
    return out
a, b = grab('http://localhost:4174'), grab('http://localhost:4173')
bad = 0
for k in a:
    same = a[k] == b[k]; bad += not same
    print(f"{'SAME' if same else 'DIFF'} {k:20} n={len(a[k])}  e.g. {str(a[k][:2])[:110]}")
    if not same: print('   old', str(a[k])[:300]); print('   new', str(b[k])[:300])
print('RESULT', 'IDENTICAL' if not bad else f'{bad} DIFFERENT')
