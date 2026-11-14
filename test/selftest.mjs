#!/usr/bin/env node
/**
 * ui-bug-hunt self-test: serves pages with one seeded bug each, runs scan -> pick -> report on them and checks
 * that every bug is caught and the clean page stays clean.
 *
 *   node test/selftest.mjs [--channel chromium]     (after `npm install` in skills/ui-bug-hunt/scripts)
 *   node test/selftest.mjs --serve 4173             only serve the pages, to try the whole skill on them
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ui-bug-hunt', 'scripts');
const page = (body, css = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>t</title><style>body{margin:16px;font:16px/1.5 Arial,sans-serif;color:#111;background:#fff}
.btn{display:inline-block;min-width:120px;padding:12px 16px;background:#1a4fd6;color:#fff;text-decoration:none}.btn:hover{background:#0b2f8a}${css}</style></head>
<body><main><h1>Fixture</h1>${body}</main></body></html>`;

const icon = (s = 20, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" ${extra}><circle cx="10" cy="10" r="8" fill="currentColor"/></svg>`;
// route -> [html, the check that must flag it (null = must be clean)]
const PAGES = {
  '/': [page('<p>A clean page.</p><a class="btn" href="/">Home</a>'), null],
  '/overflow': [page('<div class="wide">A banner wider than any screen</div>', '.wide{width:1800px;background:#eee}'), 'overflow'],
  '/clipped': [page('<div class="cut">A long title that loses its end without warning</div>', '.cut{width:120px;white-space:nowrap;overflow:hidden}'), 'clipped'],
  '/squeezed': [page('<div style="width:60px"><p>A long sentence squeezed into a narrow sliver of the page.</p></div>'), 'squeezed'],
  '/broken-img': [page('<img src="/missing.png" width="200" height="100" alt="product">'), 'brokenImg'],
  '/overlap': [page('<div style="position:relative;height:60px"><a class="btn" href="/">Save</a><a class="btn" href="/" style="position:absolute;left:20px;top:0">Cancel</a></div>'), 'overlapControls'],
  '/offscreen': [page('<div style="overflow:visible;width:100%;position:relative;height:60px"><a class="btn" href="/" style="position:absolute;left:-60px;top:0">Menu</a></div>'), 'offscreen'],
  '/contrast': [page('<p style="color:#c8c8c8">Pale grey text on a white page.</p>'), 'lowContrast'],
  '/unit': [page('<div style="width:50px"><span>1,250 USD</span></div>'), 'unitSplit'],
  '/covered': [page('<div style="height:1500px"></div><a class="btn" href="/">Pay now</a><div class="bar">Total</div>', 'body{margin:0}.bar{position:fixed;left:0;right:0;bottom:0;height:64px;background:#222;color:#fff}'), 'coveredAtEnd'],
  '/fixed': [page('<p>Two bars.</p><div class="a">Cookies</div><div class="b">Install the app</div>', '.a,.b{position:fixed;left:0;right:0;bottom:0;height:60px;background:#222;color:#fff}.b{bottom:30px;background:#444}'), 'fixedOverlap'],
  '/dialog': [page('<div role="dialog" aria-label="Settings" style="position:fixed;top:-40px;left:20px;width:200px;height:1400px;background:#eee">Settings</div>'), 'bigDialog'],
  '/hover': [page('<div style="display:flex"><a class="grow" href="/">Grow</a><span>next</span></div><a class="flat" href="/">Flat link</a>', '.grow:hover{padding:0 30px}.flat{display:block;margin-top:20px;color:#111;text-decoration:none;cursor:default}'), 'hover'],
  '/small-tap': [page('<button style="width:20px;height:20px;padding:0;border:0;background:#1a4fd6"><span aria-label="close"></span></button>'), 'small'],
  '/raw-keys': [page('<p>orders.new.title</p>'), 'rawKeys'],
  '/writes': [page('<p>Saves on load.</p><script>fetch("/api/save",{method:"POST"}).catch(()=>{})</script>'), 'blockedWrites'],
  '/search?q=shoes': [page('<p>Results.</p><a class="btn" href="/">Home</a>'), null],
  // a realistic page that must stay clean: an icon nav with an active item, uneven cards, wrapped tags, a form row, checkboxes
  '/app': [page(`<nav class="nav">${['Home', 'Orders', 'Clients', 'Reports', 'Settings'].map((t, i) => `<a class="nl${i ? '' : ' active'}"${i ? '' : ' aria-current="page"'} href="/app">${icon()}<span>${t}</span></a>`).join('')}</nav>
<div class="cards"><div class="card"><h3>Alpha</h3><p>Short.</p></div><div class="card"><h3>Beta</h3><p>A longer description that takes a few more lines than its neighbours do.</p></div><div class="card"><h3>Gamma</h3><p>Medium length text here.</p></div></div>
<div class="tags">${['design', 'billing', 'mobile', 'checkout', 'search', 'profile', 'reports', 'onboarding', 'emails'].map((t) => `<span class="tag">${t}</span>`).join('')}</div>
<div class="frm"><input class="in" type="email" aria-label="Email"><button class="go" type="button">Subscribe</button></div>
<label class="row"><input type="checkbox"> Email me the report</label>
<label class="ck2"><input class="sr2" type="checkbox"><span class="box2"></span> Dark mode</label>`,
  `.nav{display:flex;flex-wrap:wrap;gap:8px}.nl{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;color:#111;text-decoration:none}.nl:hover{background:#eee}.nl.active{color:#1a4fd6;font-weight:700}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:start;margin:16px 0}.card{border:1px solid #999;padding:12px}.card h3{margin:0}
.tags{display:flex;flex-wrap:wrap;gap:8px;max-width:420px}.tag{padding:4px 10px;background:#eee;border-radius:12px;font-size:14px}
.frm{display:flex;gap:8px;max-width:420px;margin:16px 0}.in{flex:1;min-width:0;height:44px;box-sizing:border-box;padding:0 12px;border:1px solid #777;font-size:16px}.go{height:44px;padding:0 16px;border:0;background:#1a4fd6;color:#fff;font-size:16px}.go:hover{background:#0b2f8a}
.row,.ck2{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 16px;position:relative}.sr2{position:absolute;opacity:0;width:20px;height:20px;margin:0}
.box2{position:relative;display:block;width:20px;height:20px;box-sizing:border-box;border:2px solid #333}.sr2:checked+.box2{background:#1a4fd6}.sr2:focus-visible+.box2{outline:2px solid #1a4fd6;outline-offset:2px}
.box2::after{content:"";position:absolute;left:-8px;top:-8px;width:32px;height:32px;border-radius:50%;background:rgba(26,79,214,.2);transform:scale(0);transition:transform .15s}.sr2:checked+.box2::after{transform:scale(1)}`), null],
  // a custom checkbox whose ripple (::after) is cut by its wrapper once checked, and one cut only while it animates
  '/checkbox-crop': [page(`<div class="clip"><label class="ck"><input class="sr" type="checkbox" aria-label="Remember me"><span class="box"></span></label></div>
<div class="clip2"><input class="pop" type="checkbox" aria-label="Pop"></div>`,
  `.clip{overflow:hidden;width:24px;height:24px}.ck{display:block;position:relative;width:24px;height:24px}.sr{position:absolute;opacity:0;width:24px;height:24px;margin:0}
.box{display:block;position:relative;width:20px;height:20px;border:2px solid #333}.box::after{content:"";position:absolute;left:-12px;top:-12px;width:44px;height:44px;border-radius:50%;background:rgba(26,79,214,.25);transform:scale(0);transition:transform .2s}.sr:checked+.box::after{transform:scale(1)}
.clip2{overflow:hidden;width:22px;height:22px;margin-top:24px}.pop{appearance:none;display:block;box-sizing:border-box;width:22px;height:22px;margin:0;border:2px solid #333}.pop:checked{background:#1a4fd6;animation:pop .3s}@keyframes pop{50%{transform:scale(1.5)}}`), 'toggle'],
  // keyboard focus: a link with no indicator, a ring cut by its wrapper, a link in an off-screen menu
  '/focus': [page('<a class="btn" href="/">Normal</a> <a class="plain" href="/">Plain</a><div class="wrap"><a class="ring" href="/">Ring</a></div><div class="menu"><a href="/">Hidden menu link</a></div>',
    '.plain{display:inline-block;min-height:44px;line-height:44px;color:#111;outline:none}.wrap{overflow:hidden;width:120px;margin-top:16px}.ring{display:block;min-height:44px;line-height:44px;color:#111}.ring:focus-visible{outline:3px solid #1a4fd6;outline-offset:2px}.menu{position:absolute;left:-400px;top:0}'), 'focus'],
  // a tab that fits its label today and cuts it once the label is 40% longer
  '/stretch': [page('<div class="tab">Notifications</div>', '.tab{width:112px;white-space:nowrap;overflow:hidden;background:#eee}'), 'stretch'],
  '/misaligned': [page(`<div class="r"><a class="it" href="/">One</a><a class="it" href="/">Two</a><a class="it" href="/" style="position:relative;top:5px">Three</a><a class="it" href="/">Four</a></div>
<a class="lk" href="/">${icon(16, 'style="position:relative;top:-8px"')}<span>Settings</span></a>`,
  '.r{display:flex;gap:8px}.it{display:block;width:90px;height:44px;line-height:44px;text-align:center;background:#eee;color:#111;text-decoration:none}.it:hover{background:#ddd}.lk{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-top:20px;color:#111}'), 'misaligned'],
  '/icon-size': [page(`<ul class="ic">${[20, 20, 20, 26, 20].map((s) => `<li><a href="/">${icon(s)}<span>Item</span></a></li>`).join('')}</ul>`,
    '.ic{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:12px}.ic a{display:inline-flex;align-items:center;gap:8px;min-height:44px;color:#111}'), 'iconSize'],
  '/size-mismatch': [page('<div style="display:flex;gap:8px;align-items:center"><input aria-label="Email" style="height:44px;box-sizing:border-box;border:1px solid #777;width:160px"><button type="button" style="height:36px;border:0;background:#1a4fd6;color:#fff;padding:0 16px">Go</button></div>'), 'sizeMismatch'],
  '/style-mismatch': [page(`<ul>${['Anna', 'Boris', 'Chloe', 'David', 'Emma'].map((n, i) => `<li class="who"${i === 2 ? ' style="color:#b00020"' : ''}>${n}</li>`).join('')}</ul>`), 'styleMismatch'],
  '/colour-drift': [page(`${'<p style="color:#333333">Paragraph text here.</p>'.repeat(8)}${'<p style="color:#353535">A stray shade.</p>'.repeat(2)}`), 'colourDrift'],
};
let posts = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { posts++; return res.end('ok'); }
  if (req.url === '/sitemap.xml') return res.end(`<urlset>${[...Object.keys(PAGES).filter((r) => !r.includes('?')), '/account', '/boom', '/orders/1/cancel'].map((r) => `<url><loc>http://${req.headers.host}${r}</loc></url>`).join('')}</urlset>`);
  if (req.url === '/orders/1/cancel') return res.end(page('<p>Order cancelled.</p>'));   // a link that acts when opened
  if (req.url === '/account') { res.writeHead(302, { location: '/login' }); return res.end(); }
  if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/html' }); return res.end(page('<p>Internal Server Error</p>')); }
  const hit = PAGES[req.url] || (req.url === '/login' ? [page('<p>Sign in</p>')] : null);
  res.writeHead(hit ? 200 : 404, { 'content-type': 'text/html' });
  res.end(hit ? hit[0] : 'not found');
});
const serveAt = process.argv.indexOf('--serve');   // --serve 4173: only serve the pages, to try the skill on them
await new Promise((ok) => server.listen(serveAt >= 0 ? +process.argv[serveAt + 1] : 0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
if (serveAt >= 0) { console.log(`fixture pages on ${BASE} (Ctrl+C to stop): ${Object.keys(PAGES).join(' ')}`); await new Promise(() => {}); }
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-bug-hunt-test-'));
const routes = path.join(OUT, 'routes.txt');
fs.writeFileSync(routes, [...Object.keys(PAGES), '/account', '/boom'].join('\n'));

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
// async: the fixture server lives in this process and must keep answering while the scanner runs
const run = (script, args) => new Promise((done) => {
  const p = spawn(process.execPath, [path.join(SCRIPTS, script), ...args]);
  const r = { stdout: '', stderr: '', status: null };
  p.stdout.on('data', (d) => { r.stdout += d; }); p.stderr.on('data', (d) => { r.stderr += d; });
  p.on('close', (code) => { r.status = code; done(r); });
});
const scanDir = path.join(OUT, 'scan');
const extra = process.argv.slice(2);   // e.g. --channel chromium

// 1. a mistyped flag stops the run (before any browser starts)
check((await run('scan.mjs', ['--base', BASE, '--routes', routes, '--read_only', 'x'])).status === 2, 'a mistyped flag is refused');

// 2. the scan
const scan = await run('scan.mjs', ['--base', BASE, '--routes', routes, '--matrix', '-:d,m', '--hover', '--resize', '--shots', '--focus', '--toggle', '--stretch',
  '--read-only', '/api/', '--wait', '400', '--workers', '1', '--out', scanDir, ...extra]);
process.stdout.write(scan.stdout.split(/\r?\n/).slice(-4).join('\n') + scan.stderr);
check(scan.status === 0 && /all page loads done/.test(scan.stdout), 'scan ran to the end');
const rows = fs.existsSync(path.join(scanDir, 'scan.json')) ? JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8')) : [];
const row = (route, vp) => rows.find((r) => r.route === route && r.vp === vp) || {};
for (const [route, [, kind]] of Object.entries(PAGES)) {
  const d = row(route, 'd'), m = row(route, 'm');
  if (kind === null) {
    check(d.visual?.count === 0 && m.visual?.count === 0 && !d.errorScreen && !d.hover?.layoutShift.length
      && Object.values(d.resize || {}).every((v) => v.count === 0), `${route} is clean at every size`);
    if (route === '/app') check(d.toggle?.checked === 2 && !d.toggle.cropped.length && !d.toggle.notRestored.length && m.toggle?.checked === 2 && !m.toggle.cropped.length, '/app: both checkboxes clicked, none cut, both put back');
    if (route === '/app') check(d.focus?.checked >= 8 && !d.focus.noIndicator.length && !d.focus.cropped.length && !d.focus.hidden.length, `/app: ${d.focus?.checked} controls reached with Tab, every focus ring visible and whole`);
    if (route === '/app') check(d.stretch?.texts > 15 && !d.stretch.broke.length && !m.stretch?.broke.length, `/app: ${d.stretch?.texts} labels made longer, nothing breaks`);
  } else if (kind === 'stretch') {
    check(!d.visual?.clipped?.length && d.stretch?.broke.some((s) => s.startsWith('clipped') && s.includes('div.tab')), '/stretch: a tab that is fine today and cuts a longer label');
  } else if (kind === 'focus') {
    check(d.focus?.noIndicator.some((s) => s.includes('Plain')) && !d.focus.noIndicator.some((s) => s.includes('Normal') || s.includes('Ring')), '/focus: a link with no focus indicator (and only that one)');
    check(d.focus?.cropped.some((s) => s.includes('Ring') && s.includes('cut 5px')), '/focus: a focus ring cut by its wrapper');
    check(d.focus?.hidden.some((s) => s.includes('Hidden menu link')), '/focus: focus lands on an off-screen link');
  } else if (kind === 'toggle') {
    check(d.toggle?.cropped.some((s) => s.includes('Remember me') && s.includes('once checked')), '/checkbox-crop: a ripple cut by its wrapper once checked');
    check(d.toggle?.cropped.some((s) => s.includes('Pop') && s.includes('during the click animation')), '/checkbox-crop: a box cut only while it animates');
    check(!d.toggle?.notRestored.length, '/checkbox-crop: checkboxes put back');
  } else if (kind === 'misaligned') {
    check(d.visual?.misaligned?.some((s) => s.includes('Three') && s.includes('5px lower')), '/misaligned: an item 5px lower than its neighbours');
    check(d.visual?.misaligned?.some((s) => s.includes('icon sits')), '/misaligned: an icon off its label');
  } else if (kind === 'hover') {
    check(d.hover?.layoutShift.some((s) => s.includes('Grow')), '/hover: a link that moves its neighbours');
    check(d.hover?.noFeedback.some((s) => s.includes('Flat link')), '/hover: a link with no hover feedback');
  } else if (kind === 'small') check(m.visual?.small?.length > 0 && !d.visual?.small?.length, `${route}: small tap target on phone only`);
  else if (kind === 'rawKeys') check(d.rawKeys?.includes('orders.new.title'), `${route}: untranslated key`);
  else if (kind === 'blockedWrites') check(d.blockedWrites?.length === 1 && posts === 0, `${route}: --read-only stopped the POST (${posts} reached the server)`);
  else check(d.visual?.[kind]?.length > 0 || m.visual?.[kind]?.length > 0, `${route}: ${kind}`);
}
check(row('/account', 'd').loginWall === true, '/account: sent to a sign-in page');
check(row('/boom', 'd').errorScreen === true, '/boom: error screen');
check(row('/overflow', 'd').resize?.[390]?.overflow?.length > 0, '/overflow: also caught on live resize to 390');
const shots = fs.existsSync(path.join(scanDir, 'shots')) ? fs.readdirSync(path.join(scanDir, 'shots')) : [];
check(shots.includes('root_xx_d.png') && shots.includes('search-q=shoes_xx_m.png') && shots.includes('overflow_xx_d_resized768.png'), `screenshots written (${shots.length})`);

// 3. a second run resumes: nothing left to do
check(/0 page loads to do/.test((await run('scan.mjs', ['--base', BASE, '--routes', routes, '--matrix', '-:d,m', '--out', scanDir, ...extra])).stdout), 'a second run resumes with nothing left');

// 3b. pages from a sitemap, thinned by --max-routes
const sm = await run('scan.mjs', ['--base', BASE, '--sitemap', `${BASE}/sitemap.xml`, '--max-routes', '1', '--matrix', '-:m', '--wait', '200', '--out', path.join(OUT, 'sitemap'), ...extra]);
const inMap = Object.keys(PAGES).filter((r) => !r.includes('?')).length + 3;
check(sm.stdout.includes(`${inMap} routes, keeping 1 `) && /all page loads done/.test(sm.stdout), 'pages read from a sitemap');
const state = path.join(OUT, 'state.json');
fs.writeFileSync(state, '{"cookies":[],"origins":[]}');
const signed = await run('scan.mjs', ['--base', BASE, '--sitemap', `${BASE}/sitemap.xml`, '--storage', state, '--max-routes', '1', '--matrix', '-:m', '--wait', '200', '--out', path.join(OUT, 'signed'), ...extra]);
check(/1 action-looking sitemap page/.test(signed.stdout) && signed.stdout.includes(`${inMap - 1} routes, keeping 1 `), 'signed in: the action-looking sitemap page is left out');
check((await run('scan.mjs', ['--base', BASE, '--crawl', '5', '--storage', state, '--out', path.join(OUT, 'crawl'), ...extra])).status === 2, 'signed in: crawling is refused');
check((await run('scan.mjs', ['--base', BASE, '--routes', routes, '--toggle', '--storage', state, '--out', path.join(OUT, 'tg'), ...extra])).status === 2, 'signed in: clicking checkboxes is refused');

// 4. pick: flagged pages are opened, error pages are not
const review = path.join(OUT, 'review');
const pick = await run('pick.mjs', ['--shots', path.join(scanDir, 'shots'), '--out', review, scanDir]);
const batch = fs.existsSync(path.join(review, 'batch-1.md')) ? fs.readFileSync(path.join(review, 'batch-1.md'), 'utf8') : '';
const picked = fs.existsSync(path.join(review, 'picked.json')) ? JSON.parse(fs.readFileSync(path.join(review, 'picked.json'), 'utf8')) : {};
check(pick.status === 0 && batch.includes('overflow_xx_d.png') && batch.includes('clipped_xx_m.png'), 'pick lists the flagged screenshots');
check(!batch.includes('boom_') && !batch.includes('account_') && picked.notReviewable?.length === 2, 'pick leaves out the error screen and the login wall');
check(!batch.includes('contrast_xx_d.png') && !batch.includes('overflow_xx_d_resized390.png') && picked.images < shots.length / 2, `pick opens a fraction of the shots (${picked.images} of ${shots.length})`);

const all = await run('pick.mjs', ['--shots', path.join(scanDir, 'shots'), '--all-sizes', '--out', path.join(OUT, 'review-all'), scanDir]);
check(all.status === 0 && fs.readFileSync(path.join(OUT, 'review-all', 'batch-1.md'), 'utf8').includes('overflow_xx_d_resized390.png'), 'pick --all-sizes opens every flagged size');

// 5. report
const md = path.join(OUT, 'report.md');
const rep = await run('report.mjs', [md, scanDir]);
const text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
check(rep.status === 0 && ['## overflow', '## clipped', '## lowContrast', '## unitSplit', '## coveredAtEnd', '## hoverShift', '## small', '## toggleCrop', '## stretch', '## focusNone', '## focusCrop', '## focusHidden', '## misaligned', '## iconSize', '## sizeMismatch', '## styleMismatch', '## colourDrift', '## sent to a sign-in page', '## error screen', '## untranslated keys']
  .every((h) => text.includes(h)), 'report has a section for each kind');

// 6. a rescan against an earlier scan: the earlier one had a bug that is gone, and lacked the /clipped page
const oldDir = path.join(OUT, 'old');
fs.mkdirSync(oldDir);
fs.writeFileSync(path.join(oldDir, 'scan.json'), JSON.stringify([...rows.filter((r) => r.route !== '/clipped'),
  { route: '/', locale: '', vp: 'd', visual: { overflow: ['main > div.old-banner "Old" (0..2000)'] } }]));
const md2 = path.join(OUT, 'report-diff.md');
const rep2 = await run('report.mjs', [md2, scanDir, '--baseline', oldDir]);
const text2 = fs.existsSync(md2) ? fs.readFileSync(md2, 'utf8') : '';
check(rep2.status === 0 && /Since the last scan: 1 fixed, 1 new, /.test(text2) && /### Fixed \(1\)\n- `overflow: main > div\.old-banner/.test(text2) && /### New \(1\)\n- `clipped: /.test(text2), 'report --baseline: one fixed, one new');

server.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed; output kept in ${OUT}`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
console.log('\nall checks passed');
