# Compare two crawl runs (crawl.py) page by page: load, requests, RPC, bytes, errors — and which on-page section
# headings / labels disappeared (a missing label = a section that stopped rendering).
#   python3 scripts/regress/compare.py <baseline_dir> <candidate_dir>
import json, re, sys

A, B = sys.argv[1].rstrip('/') + '/', sys.argv[2].rstrip('/') + '/'
a, b = json.load(open(A + 'summary.json')), json.load(open(B + 'summary.json'))
KEYS = ['t_content', 'requests', 'rpc_calls', 'status_429', 'bytes_data', 'console_errors', 'failed_loads']


def labels(path):
    # Words-only lines (no digits) = headings, tab names, column labels, buttons. Numbers change every minute; labels don't.
    try:
        return {l.strip() for l in open(path) if l.strip() and not re.search(r'\d', l) and len(l.strip()) < 60}
    except FileNotFoundError:
        return set()


bad = 0
for page in [k for k in a if not k.startswith('_')]:
    if page not in b:
        print(f'!! {page}: MISSING in candidate'); bad += 1; continue
    cells = []
    for k in KEYS:
        va, vb = a[page].get(k), b[page].get(k)
        if k == 'bytes_data':
            va, vb = round((va or 0) / 1e6, 2), round((vb or 0) / 1e6, 2)
        cells.append(f'{k}={va}->{vb}')
    print(f'{page:16} ' + '  '.join(cells))
    gone = labels(A + page + '.txt') - labels(B + page + '.txt')
    if gone:
        bad += 1
        print(f'   !! labels missing in candidate ({len(gone)}): ' + ' | '.join(sorted(gone)[:25]))
    new_api = set(b[page].get('api_paths', [])) - set(a[page].get('api_paths', []))
    if new_api:
        print('   new /api paths: ' + ', '.join(sorted(new_api)))
print('\nRESULT:', 'CHECK the !! lines above' if bad else 'no missing pages or sections')
