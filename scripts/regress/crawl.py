# StateraArc regression crawl — the "did the upgrade break anything" check.
# Drives every page headless (Playwright Chromium INSIDE WSL — never a window on the owner's screen) and records, per
# page: time to content, request count by host, RPC calls by method, 429s, bytes downloaded, console errors, failed
# loads, and the visible text (so key numbers can be diffed). Compare two runs with compare.py.
#
#   python3 scripts/regress/crawl.py https://www.stateraarc.com out/live
#   python3 scripts/regress/crawl.py https://<preview>.vercel.app out/preview
#   python3 scripts/regress/compare.py docs/v1-baseline/crawl out/preview
#
# ⛔ Vercel's security checkpoint blocks an IP that hammers the site — one crawl at a time, not in a loop.
import json, os, re, sys, time, collections
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://www.stateraarc.com').rstrip('/')
OUT = (sys.argv[2] if len(sys.argv) > 2 else 'regress-out').rstrip('/') + '/'
TOKENS = ['0x171a4217b86a807a64eb94757db6849fb4bdbaa0',  # cirBTC — deep V3 market, core asset
          '0xece5ca8bf9220718e5727754026757512212cb3c']  # ARGUS — launchpad coin, V4
os.makedirs(OUT, exist_ok=True)
HAS_PRICE = "(()=>/\\$[0-9]/.test(document.body.innerText))()"
HAS_ROWS = "document.querySelectorAll('.trow.tok').length>5"
LANDING = "(()=>{const t=document.body.innerText;return /\\$[0-9]/.test(t) && t.length>1500})()"
results = {}


def host(u):
    return re.sub(r'^https?://([^/]+).*', r'\1', u)


def run(ctx, name, path, ready=None, settle_ms=20000):
    page = ctx.new_page()
    reqs, cons, fails = [], [], []
    t0 = time.time()

    def on_req(r):
        post = r.post_data or '' if r.method == 'POST' else ''
        reqs.append({'t': round(time.time() - t0, 2), 'm': r.method, 'url': r.url, 'type': r.resource_type,
                     'rpc': re.findall(r'"method"\s*:\s*"(\w+)"', post)})

    def on_done(r):
        for x in reversed(reqs):
            if x['url'] == r.url and 'bytes' not in x:
                try:
                    x['bytes'] = r.sizes().get('responseBodySize', 0)
                    x['status'] = r.response().status if r.response() else None
                except Exception:
                    x['bytes'] = 0
                break

    page.on('request', on_req)
    page.on('requestfinished', on_done)
    page.on('console', lambda m: cons.append(f'{m.type}: {m.text[:300]}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: cons.append(f'PAGEERROR: {str(e)[:300]}'))
    page.on('requestfailed', lambda r: fails.append(f'{r.url[:160]} {r.failure}'))
    page.goto(BASE + path, wait_until='domcontentloaded', timeout=60000)
    t_content = None
    if ready:
        try:
            page.wait_for_function(ready, timeout=45000)
            t_content = round(time.time() - t0, 2)
        except Exception:
            t_content = 'timeout'
    # Fixed settle window (not networkidle — the v1 token page never goes idle), then scroll for lazy loads.
    page.wait_for_timeout(settle_ms // 2)
    h, y = page.evaluate('document.body.scrollHeight'), 0
    while y < h:
        y += 800
        page.evaluate(f'window.scrollTo(0,{y})'); page.wait_for_timeout(200)
        h = page.evaluate('document.body.scrollHeight')
    page.wait_for_timeout(settle_ms // 2)
    page.evaluate('window.scrollTo(0,0)')
    page.screenshot(path=OUT + name + '.png', full_page=True)
    open(OUT + name + '.txt', 'w').write(page.evaluate('document.body.innerText'))
    rpc = collections.Counter(m for x in reqs for m in x['rpc'])
    nonimg = [x for x in reqs if x['type'] not in ('image', 'font', 'stylesheet', 'media')]
    results[name] = {
        'path': path, 't_content': t_content,
        'requests': len(nonimg), 'images': sum(1 for x in reqs if x['type'] == 'image'),
        'bytes_total': sum(x.get('bytes', 0) or 0 for x in reqs),
        'bytes_data': sum(x.get('bytes', 0) or 0 for x in nonimg if x['type'] in ('fetch', 'xhr')),
        'rpc_calls': sum(rpc.values()), 'rpc_by_method': dict(rpc.most_common()),
        'status_429': sum(1 for x in reqs if x.get('status') == 429),
        'by_host': dict(collections.Counter(host(x['url']) for x in nonimg).most_common()),
        'api_paths': sorted(set(re.sub(r'^https?://[^/]+', '', x['url']).split('?')[0] for x in nonimg if host(x['url']) == host(BASE) and '/api/' in x['url'])),
        'largest': [f"{(x.get('bytes') or 0)/1e6:.2f}MB {x['url'][:140]}" for x in sorted(reqs, key=lambda x: -(x.get('bytes') or 0))[:8]],
        'console_errors': len(cons), 'failed_loads': len(fails),
        'console_sample': cons[:15], 'failed_sample': fails[:15],
    }
    page.close()
    r = results[name]
    print(f"{name:16} content {r['t_content']}s  req {r['requests']}  rpc {r['rpc_calls']}  429 {r['status_429']}  "
          f"data {r['bytes_data']/1e6:.2f}MB  errors {r['console_errors']}", flush=True)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_init_script("try{localStorage.setItem('statera-disclaimer-v1','1')}catch(e){}")
    run(ctx, 'landing', '/', LANDING)
    run(ctx, 'screener', '/screener', HAS_ROWS)
    for i, a in enumerate(TOKENS):
        run(ctx, f'token{i + 1}', f'/token/{a}', HAS_PRICE, settle_ms=30000)
    run(ctx, 'str', '/str', HAS_PRICE)
    run(ctx, 'portfolio', '/portfolio')
    run(ctx, 'swap', '/swap')
    m = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    m.add_init_script("try{localStorage.setItem('statera-disclaimer-v1','1')}catch(e){}")
    run(m, 'landing_mobile', '/', LANDING)
    b.close()
results['_meta'] = {'base': BASE, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
json.dump(results, open(OUT + 'summary.json', 'w'), indent=1)
print('wrote', OUT + 'summary.json')
