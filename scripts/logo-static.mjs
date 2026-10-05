#!/usr/bin/env node
/*
 * Static token logos for the SITE (runs on the VPS after logo-cache.mjs; needs `sharp` from /root/statera-logos).
 *
 * ⛔ WHY (owner 09-29: "logos are loading slow af"): a screener page showed ~34 logos through /api/logo — a Vercel
 * function that relays to the VPS over the tunnel. Vercel's edge caches each one per region, but most listed tokens are
 * viewed rarely, so a visitor usually got the MISS path: median 1.2 s per logo.
 *
 * This turns every cached 192px PNG (/root/statera-live/logos/<address>.png) into a 112px WebP at public/l/<address>.webp
 * (2x the largest place a logo is drawn, 52px) plus public/l/index.json, the list of addresses that have one. They ride
 * along with the snapshot backup commit (vps-snapshot-push.sh, at most every 6h), so they cost no extra deploys, and
 * Vercel's CDN serves them as plain files. TokenLogo tries this file first; a token listed since the last deploy still
 * gets the /api/logo path.
 *
 * Usage: node scripts/logo-static.mjs [srcDir] [outDir]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const sharp = createRequire('/root/statera-logos/')('sharp');

const SRC = process.argv[2] || '/root/statera-live/logos';
const OUT = process.argv[3] || path.join(process.cwd(), 'public/l');
// Share-card logos (10-04, owner: "make sure the logos get in there before everything else"): a 160px JPEG per token, flattened
// on the card's tile colour, bundled INTO the og function (vercel.json includeFiles api/_ogl/**). api/og.js reads it from disk
// first: no network, so a card can't be published without its logo the way the 10-04 \$ARGUS post was. (resvg draws WebP
// blank, so the site's .webp can't be used.)
const OGL = process.argv[4] || path.join(process.cwd(), 'api/_ogl');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(OGL, { recursive: true });
const have = [];
let made = 0, kept = 0, bad = 0;
for (const f of fs.readdirSync(SRC)) {
  const m = f.match(/^(0x[0-9a-f]{40})\.png$/);
  if (!m) continue;
  const src = path.join(SRC, f), dst = path.join(OUT, `${m[1]}.webp`);
  try {
    if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) {
      await sharp(src).resize(112, 112, { fit: 'cover' }).webp({ quality: 82 }).toFile(dst + '.tmp');
      fs.renameSync(dst + '.tmp', dst); made++;
    } else kept++;
    const ogl = path.join(OGL, `${m[1]}.jpg`);
    if (!fs.existsSync(ogl) || fs.statSync(ogl).mtimeMs < fs.statSync(src).mtimeMs) {
      await sharp(src).resize(160, 160, { fit: 'cover' }).flatten({ background: '#161310' }).jpeg({ quality: 85 }).toFile(ogl + '.tmp');
      fs.renameSync(ogl + '.tmp', ogl);
    }
    have.push(m[1]);
  } catch { bad++; }
}
// a logo whose source was dropped from the cache goes too, so index.json never lists a file that isn't there
for (const f of fs.readdirSync(OUT)) { const m = f.match(/^(0x[0-9a-f]{40})\.webp$/); if (m && !have.includes(m[1])) fs.unlinkSync(path.join(OUT, f)); }
for (const f of fs.readdirSync(OGL)) { const m = f.match(/^(0x[0-9a-f]{40})\.jpg$/); if (m && !have.includes(m[1])) fs.unlinkSync(path.join(OGL, f)); }
have.sort();
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(have));
console.log(`[logo-static] ${have.length} logos (${made} new/updated, ${kept} unchanged, ${bad} failed)`);
