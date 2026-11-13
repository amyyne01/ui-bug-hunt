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
};
let posts = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST') { posts++; return res.end('ok'); }
  if (req.url === '/sitemap.xml') return res.end(`<urlset>${[...Object.keys(PAGES).filter((r) => !r.includes('?')), '/account', '/boom'].map((r) => `<url><loc>http://${req.headers.host}${r}</loc></url>`).join('')}</urlset>`);
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
const scan = await run('scan.mjs', ['--base', BASE, '--routes', routes, '--matrix', '-:d,m', '--hover', '--resize', '--shots',
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
check(/18 routes, keeping 1 /.test(sm.stdout) && /all page loads done/.test(sm.stdout), 'pages read from a sitemap');

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
check(rep.status === 0 && ['## overflow', '## clipped', '## lowContrast', '## unitSplit', '## coveredAtEnd', '## hoverShift', '## small', '## sent to a sign-in page', '## error screen', '## untranslated keys']
  .every((h) => text.includes(h)), 'report has a section for each kind');

server.close();
if (fails.length) { console.error(`\n${fails.length} check(s) failed; output kept in ${OUT}`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
console.log('\nall checks passed');
