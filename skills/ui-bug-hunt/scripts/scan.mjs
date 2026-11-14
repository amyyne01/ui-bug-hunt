#!/usr/bin/env node
/**
 * ui-bug-hunt scanner: every route x locale x viewport of a running web app, measured by visual_probe.js,
 * plus (desktop) a hover pass and a live-resize pass, plus screenshots. One JSON row per page load.
 *
 *   node scan.mjs --config scan-config.json   (or: --base https://app.example.com --routes routes.txt) --out <dir> [options]
 *
 * --base URL            the running app (local dev or production)
 * --routes FILE         one path per line ("/", "/pricing", "/products/42"), any framework; or
 * --sitemap URL         the pages listed in a sitemap.xml (sitemap indexes followed)
 * --crawl N             no source and no sitemap: follow the site's own links from --base, up to N pages
 *                       (action-looking links skipped: cancel, delete, approve, logout...; --crawl-skip REGEX).
 *                       Refused with --storage unless --crawl-signed-in: crawl public pages or a TEST account only
 * --discover DIR        a Next.js project: its app/ or pages/ routes (route groups and a [locale] segment
 *                       dropped; [dynamic] segments need --ids FILE {"/products/[id]": "/products/42"},
 *                       else they are listed as skipped)
 * --locales fr,ar       the locales to scan ("" = the app's default only). Default: ""
 * --locale-mode M       how a locale reaches the app: prefix (/fr/page, default) | query:<param> (?lang=fr) |
 *                       cookie:<name> (a cookie on the base host) | none (browser language only)
 * --vps d,m,x           d 1366x900, l 1024x768, t 768x1024, m 390x844, x 320x700. Default d,m,x
 * --hover               desktop: hover up to --hover-max (25) controls: no feedback / neighbours move
 * --resize              desktop: shrink the SAME loaded page to 768, 390, 320 (no reload), probe + shot each
 * --focus               desktop: press Tab up to --focus-max (25) times (keys only): a control with no visible focus
 *                       indicator, a focus ring cut off by its container, focus landing on something invisible.
 *                       At every size: a focused field left under a fixed bar (a sticky save bar, a bottom nav)
 * --menus               the second pass that clicks: each menu button (aria-haspopup, aria-expanded="false", <summary>;
 *                       up to --menus-max, 8) is opened, its popup measured (off the screen, cut by a container,
 *                       covered by another layer), then closed with Escape. Menu items are never clicked. Refused
 *                       with --storage unless --menus-signed-in (a TEST account; action-looking labels are skipped)
 * --dark                scan with the dark colour scheme (prefers-color-scheme: dark); give it its own --out. A theme
 *                       switched by a class or localStorage needs --init instead
 * --placeholder-text REGEX   text that should not ship (default: coming soon, lorem ipsum, under construction);
 *                       the recon adds the app's own languages
 * --toggle              a pass that clicks: each checkbox and switch (up to --toggle-max, 10) is clicked, watched
 *                       frame by frame for anything cut off by its container (the tick, a ripple, a focus ring), then
 *                       clicked again to put it back. Radios are never clicked. Refused with --storage unless
 *                       --toggle-signed-in (a TEST account only; action-looking labels are then skipped)
 * --stretch             every short label made 40% longer (a translation, a long name), measured again: what newly
 *                       overflows, clips, leaves the screen or overlaps is reported as "breaks with longer text"
 * --shots               viewport screenshots into <out>/shots
 * --read-only REGEX     abort every POST/PUT/PATCH/DELETE whose URL matches (scanning production)
 * --storage FILE        Playwright storageState (cookies/localStorage) for signed-in pages
 * --init FILE           a JS snippet run before every page (localStorage keys, dismissing a welcome modal)
 * --wait MS             settle time after load (default 4000)
 * --error-text REGEX    text that means the page shows an error screen (default: common English + framework
 *                       messages); the recon adds the app's own error titles in its languages
 * --channel NAME        browser: chrome (default, a real Chrome: bot gates block "HeadlessChrome") or chromium
 *                       (Playwright's own: `npx playwright install chromium`); chrome falls back to chromium
 * --workers N           parallel pages (default 2; a 15 GB machine runs ONE scan at a time)
 * --matrix SPEC         per-locale viewports, e.g. "en:d,m,x;ar:m" (use "-" for no locale); default --locales x --vps
 * --max-routes N       keep N routes spread evenly (a sitemap of 3000 posts); --refresh-routes re-reads a sitemap/crawl
 * --locale-segment S    (with --discover) the folder name of a locale segment besides [locale] / [lang]
 * --no-hover --no-resize --no-shots --no-focus --no-stretch --no-toggle --no-menus   turn off what a --config turned on (e.g. the coverage pass)
 * --budget SECONDS      stop starting new pages after this long (a chunk); the same command resumes later
 * --tag NAME            output file name part (default "scan"); resumes: routes already in the JSON are skipped
 * --pw-from DIR         a repo whose node_modules has playwright
 * --config FILE         scan-config.json from the recon step: any flag above as a key ("base", "locales", "hover": true)
 *
 * Writes <out>/<tag>.json (array of rows, rewritten after every page = the checkpoint).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {   // the flag list above is the help
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split(/\r?\n/).slice(2).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}
// A mistyped flag must stop the run, not be ignored: "--read_only" would scan production with no write protection.
const VALUE_FLAGS = '--base --routes --sitemap --crawl --crawl-skip --discover --ids --locales --locale-mode --vps --hover-max --toggle-max --focus-max --menus-max --placeholder-text --read-only --storage --init --wait --error-text --channel --workers --matrix --max-routes --locale-segment --budget --tag --pw-from --config --out'.split(' ');
const BOOL_FLAGS = '--hover --resize --shots --no-hover --no-resize --no-shots --focus --no-focus --stretch --no-stretch --toggle --no-toggle --toggle-signed-in --menus --no-menus --menus-signed-in --dark --crawl-signed-in --refresh-routes'.split(' ');
const unknown = (name, where) => { console.error(`unknown ${where} "${name}" (node scan.mjs --help lists every flag)`); process.exit(2); };
for (let i = 0; i < argv.length; i++) { if (VALUE_FLAGS.includes(argv[i])) i++; else if (!BOOL_FLAGS.includes(argv[i])) unknown(argv[i], 'flag'); }
// --config FILE: the recon's scan-config.json ({"base": ..., "locales": "fr,ar", "hover": true, ...}); flags on the
// command line win over it (--no-hover / --no-resize / --no-shots turn a config's true off). Keys = flag names without "--".
const CONF = argv.includes('--config') ? JSON.parse(fs.readFileSync(argv[argv.indexOf('--config') + 1], 'utf8')) : {};
for (const k of Object.keys(CONF)) if (![...VALUE_FLAGS, ...BOOL_FLAGS].includes('--' + k)) unknown(k, 'config key');
const arg = (k, d) => { const i = argv.indexOf(k); if (i >= 0) return argv[i + 1]; const c = CONF[k.slice(2)]; return c === undefined || c === null || c === true ? d : String(c); };
const flag = (k) => !argv.includes('--no-' + k.slice(2)) && (argv.includes(k) || CONF[k.slice(2)] === true);
const HERE = path.dirname(fileURLToPath(import.meta.url));   // works with spaces and non-ASCII in the install path
const PROBE = fs.readFileSync(path.join(HERE, 'visual_probe.js'), 'utf8');

// Playwright: --pw-from, else this skill's own install (npm install here), else the current project.
// The browser is the installed Chrome by default; without one, Playwright's chromium (see --channel).
let playwright;
for (const dir of [arg('--pw-from'), HERE, process.cwd()].filter(Boolean)) {
  try { playwright = createRequire(path.join(dir, 'package.json'))('playwright'); break; } catch { /* next */ }
}
if (!playwright) { console.error(`playwright not found: run "npm install" in ${HERE}, or pass --pw-from <a project with node_modules/playwright>`); process.exit(2); }

const BASE = (arg('--base') || '').replace(/\/$/, '');
const OUT = arg('--out', path.resolve('ui-bug-hunt-out'));
const TAG = arg('--tag', 'scan');
const LOCALES = (arg('--locales', '') || '').split(',');
const VPS = arg('--vps', 'd,m,x').split(',');
// --matrix "fr:d,m,x;ar:m": viewports per locale (overrides --locales x --vps, which is a full cross product)
const MATRIX = arg('--matrix') ? arg('--matrix').split(';').filter(Boolean).map((p) => { const [l, v] = p.split(':'); return [l === '-' ? '' : l, v.split(',')]; }) : LOCALES.map((l) => [l, VPS]);
const BUDGET_MS = +arg('--budget', 0) * 1000;   // stop starting new pages after this many seconds (0 = no limit); re-run to continue
const WORKERS = +arg('--workers', 2);
const WAIT = +arg('--wait', 4000);
const HOVER_MAX = +arg('--hover-max', 25);
const READ_ONLY = arg('--read-only') ? new RegExp(arg('--read-only')) : null;
const LOCALE_MODE = arg('--locale-mode', 'prefix');
const ERROR_TEXT = new RegExp(arg('--error-text', "Something went wrong|Something broke|Application error|Internal Server Error|This page could not be found|Page not found|Unhandled Runtime Error"), 'i');
const VIEWPORTS = { d: [1366, 900, false], l: [1024, 768, false], t: [768, 1024, true], m: [390, 844, true], x: [320, 700, true] };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
if (!BASE) { console.error('--base is required'); process.exit(2); }
const ACTIONS = 'log-?out|sign-?out|delete|remove|destroy|unsubscribe|cancel|approve|reject|accept|confirm|archive|restore|publish|unpublish|activate|deactivate|enable|disable|toggle|mark|read-all|reset|revoke|block|ban|refund|void|pay|charge|send|resend|ship|fulfil|clear|empty|duplicate|clone|export|download|impersonate';
const TOGGLE_MAX = +arg('--toggle-max', 10);
if (flag('--toggle') && arg('--storage') && !flag('--toggle-signed-in')) {
  console.error('refusing to click checkboxes signed in: a switch can save a setting the moment it is clicked, and --read-only does not\n'
    + 'stop every kind of save. Run --toggle on public pages, or (a TEST account only) add --toggle-signed-in.');
  process.exit(2);
}
const MENUS_MAX = +arg('--menus-max', 8);
if (flag('--menus') && arg('--storage') && !flag('--menus-signed-in')) {
  console.error('refusing to open menus signed in: the scanner would be clicking inside a real account. Run --menus on public pages,\n'
    + 'or (a TEST account only) add --menus-signed-in.');
  process.exit(2);
}
const PLACEHOLDER_TEXT = new RegExp(arg('--placeholder-text', 'coming soon|lorem ipsum|under construction'), 'i');

// Next.js routes from the source (app router: app/**/page.*, pages router: pages/**). Any other framework:
// the recon writes a routes file instead (--routes). Route groups "(x)" and a locale segment are dropped.
function discover(repo) {
  const ids = arg('--ids') ? JSON.parse(fs.readFileSync(arg('--ids'), 'utf8')) : {};
  const localeSeg = new Set(['[locale]', '[lang]', '[lng]', ...(arg('--locale-segment') ? [arg('--locale-segment')] : [])]);
  const out = [], skipped = [];
  const add = (r) => { r = r.replace(/\/+$/, '') || '/'; if (r.includes('[')) { if (ids[r]) out.push(ids[r]); else skipped.push(r); } else out.push(r); };
  const clean = (segs) => '/' + segs.filter((x) => x && !/^\(.*\)$/.test(x) && !localeSeg.has(x) && !x.startsWith('@')).join('/');
  const walk = (dir, base, router) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['api', 'node_modules'].includes(e.name) && !e.name.startsWith('_')) walk(p, base, router); continue; }
      if (router === 'app' && /^page\.(t|j)sx?$/.test(e.name)) add(clean(path.relative(base, dir).split(path.sep)));
      if (router === 'pages' && /\.(t|j)sx?$/.test(e.name) && !e.name.startsWith('_')) {
        const segs = path.relative(base, p).replace(/\.(t|j)sx?$/, '').split(path.sep);
        if (segs[segs.length - 1] === 'index') segs.pop();
        add(clean(segs));
      }
    }
  };
  let found = false;
  for (const [rel, router] of [['src/app', 'app'], ['app', 'app'], ['src/pages', 'pages'], ['pages', 'pages']]) {
    const dir = path.join(repo, rel);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) { walk(dir, dir, router); found = true; }
  }
  if (!found) { console.error(`no app/ or pages/ folder under ${repo}: not a Next.js app, give --routes <file> (the recon lists them)`); process.exit(2); }
  return { routes: [...new Set(out)].sort(), skipped };
}



// Same function in pick.mjs. Characters a file name cannot hold ("/search?q=x", "#/tab") become "-".
const slug = (j, extra = '') => `${(j.route.replace(/^\//, '').replace(/\//g, '__').replace(/[<>:"|?*\\#]/g, '-') || 'root')}_${j.locale || 'xx'}_${j.vp}${extra}.png`;
const HOVER_MARK = `(max) => { const els = [...document.querySelectorAll('main a[href],main button,main [role=button],main [role=tab],main summary,header a[href],header button,nav a[href],aside a[href],aside button,footer a[href]')]
  .filter((e) => (e.checkVisibility?.() ?? true) && !e.disabled && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().top < innerHeight * 2);
  els.slice(0, max).forEach((e, i) => e.setAttribute('data-uibh', i)); return Math.min(els.length, max); }`;
const HOVER_SNAP = `(i) => { const e = document.querySelector('[data-uibh="' + i + '"]'); if (!e) return null; const cs = getComputedStyle(e);
  const kids = e.parentElement ? [...e.parentElement.children].map((k) => [k.offsetLeft, k.offsetTop, k.offsetWidth, k.offsetHeight]) : [];
  const own = [...e.querySelectorAll('*')].slice(0, 6).map((k) => { const c = getComputedStyle(k); return c.color + c.backgroundColor + c.opacity + c.transform; }).join();
  return { rail: !!e.closest('aside,nav,[data-sidebar]'), style: [cs.backgroundColor, cs.color, cs.borderColor, cs.boxShadow, cs.textDecorationLine, cs.opacity, cs.transform, cs.filter, cs.outlineStyle].join('|') + own,
    cursor: cs.cursor, kids, label: (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30), tag: e.tagName.toLowerCase() }; }`;

async function hoverPass(page) {
  const n = await page.evaluate(`(${HOVER_MARK})(${HOVER_MAX})`);
  const noFeedback = [], layoutShift = [];
  for (let i = 0; i < n; i++) {
    await page.mouse.move(1, 1); await page.waitForTimeout(60);
    const before = await page.evaluate(`(${HOVER_SNAP})(${i})`);
    if (!before) continue;
    try { await page.hover(`[data-uibh="${i}"]`, { timeout: 1500 }); } catch { continue; }
    await page.waitForTimeout(260);
    const after = await page.evaluate(`(${HOVER_SNAP})(${i})`);
    if (!after) continue;
    const label = `${before.tag} "${before.label}"`;
    if (after.style === before.style) noFeedback.push(label + (after.cursor === 'pointer' ? ' (pointer only)' : ' (no change, no pointer)'));
    // Same children only (a tooltip added to the row is not a shift); a sidebar rail widens by design.
    if (!before.rail && before.kids.length === after.kids.length) {
      const moved = before.kids.filter((a, j) => a.some((x, k) => Math.abs(x - after.kids[j][k]) > 1)).length;
      if (moved) layoutShift.push(`${label} moves ${moved} item(s) of its row`);
    }
  }
  await page.mouse.move(1, 1);
  return { checked: n, noFeedback, layoutShift };
}

// Shared by the click and focus passes (runs in the page): grow(rect, style) = the rect plus its outline and
// hard-edged shadows; cut(rect, from, base) = how far rect sticks out past an ancestor that clips, and which one.
const CUT_LIB = `
  const px = (s) => parseFloat(s) || 0;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const grow = (r, cs) => {
    let g = cs.outlineStyle !== 'none' ? Math.max(0, Math.max(px(cs.outlineWidth), cs.outlineStyle === 'auto' ? 2 : 0) + px(cs.outlineOffset)) : 0;   // a negative offset draws the ring inside
    for (const m of cs.boxShadow.matchAll(/rgba?\\([^)]*\\)\\s+(-?[\\d.]+)px\\s+(-?[\\d.]+)px\\s+([\\d.]+)px\\s+(-?[\\d.]+)px(\\s+inset)?/g))
      if (!m[5] && +m[3] === 0) g = Math.max(g, +m[4] + Math.max(Math.abs(+m[1]), Math.abs(+m[2])));
    return { left: r.left - g, top: r.top - g, right: r.right + g, bottom: r.bottom + g };
  };
  const over = (r, c) => Math.max(c.left - r.left, r.right - c.right, c.top - r.top, r.bottom - c.bottom, 0);
  const cut = (r, from, base) => {
    let worst = Math.max(-r.left, r.right - document.documentElement.clientWidth, 0), by = null;
    for (let p = from; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = p.getBoundingClientRect();
      const c = { left: b.left + p.clientLeft, top: b.top + p.clientTop, right: b.left + p.clientLeft + p.clientWidth, bottom: b.top + p.clientTop + p.clientHeight };
      if (/auto|scroll/.test(cs.overflowX + cs.overflowY) && over(base, c) > 0.5) continue;   // scrolled partly out of a scrolling box: not a crop
      const o = over(r, c);
      if (o > worst) { worst = o; by = p; }
    }
    return [worst, by];
  };`;
// --focus: Tab through the page (keys only, nothing is clicked). After each Tab the page reports on the element
// that HAD focus one step earlier, now that it can be compared with its own unfocused look.
const FOCUS_MAX = +arg('--focus-max', 25);
const FOCUS_STEP = `(() => {
  ${CUT_LIB}
  const label = (el) => name(el) + ' "' + (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '"';
  // everything a focus style can change, on the element, its ::before/::after and two wrappers (focus-within)
  const look = (el) => { const parts = []; let p = el;
    for (let k = 0; p && k < 3; k++, p = p.parentElement) { const c = getComputedStyle(p); parts.push(c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderBottomColor, c.borderBottomWidth, c.backgroundColor, c.backgroundImage); }
    const c = getComputedStyle(el); parts.push(c.color, c.textDecorationLine, c.opacity, c.transform, c.filter);
    for (const w of ['::before', '::after']) { const q = getComputedStyle(el, w); parts.push(q.content, q.opacity, q.backgroundColor, q.boxShadow, q.outlineStyle, q.borderTopColor, q.transform); }
    return parts.join('|'); };
  const res = {};
  const prev = window.__uibhFocus;
  const looks = (els) => els.filter((x) => x && x.isConnected).map(look).join('#');
  if (prev && looks(prev.els) === prev.look) res.none = prev.label;   // same look focused and not
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;   // web components: the real control is inside
  window.__uibhFocus = null;
  if (!el || el === document.body || el === document.documentElement || el.tagName === 'IFRAME') return res;
  res.key = label(el);
  // a visually hidden input (custom checkbox, radio, switch, select) shows its focus on the box drawn next to it / its label
  const er = el.getBoundingClientRect(), stand = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && (+getComputedStyle(el).opacity < 0.1 || er.width <= 2 || er.height <= 2);
  const lab = stand ? el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) : null;
  const els = stand ? [el.nextElementSibling, el.previousElementSibling, lab].filter(Boolean) : [el];
  const v = els[0] || el;
  const r = v.getBoundingClientRect(), cs = getComputedStyle(v);
  const shown = (v.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true) && r.width > 1 && r.height > 1 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  if (!shown) { res.hidden = res.key; return res; }
  // the browser scrolled the focused control into view, and it is still under a fixed bar (a sticky save bar, a bottom nav)
  const at = v.getRootNode() === document ? document.elementFromPoint((Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2, (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2) : null;
  if (at && !v.contains(at) && !at.contains(v) && !(lab && lab.contains(at))) {
    let f = at; while (f && !/fixed|sticky/.test(getComputedStyle(f).position)) f = f.parentElement;
    if (f && !f.contains(v)) res.covered = res.key + ' is under ' + name(f);
  }
  const [o, by] = cut(grow(r, cs), v.parentElement, r);
  // only a ring cut around a control that is itself whole: one already half out of its box (a carousel, the screen edge) is not a ring bug
  const whole = by && cut(r, v.parentElement, r)[0] <= 0.5;   // by null = the screen edge: a full-width control always touches it
  if (o >= 1.5 && whole) res.crop = res.key + ' ring cut ' + Math.round(o) + 'px by ' + (by ? name(by) : 'the screen edge');
  window.__uibhFocus = { els, label: res.key, look: looks(els) };
  return res;
})()`;
async function focusPass(page, touch) {
  const out = { checked: 0, noIndicator: [], cropped: [], hidden: [], covered: [] };
  const seen = new Set();
  await page.evaluate('window.scrollTo(0, 0); document.activeElement?.blur?.(); window.__uibhFocus = null;');
  for (let i = 0; i <= FOCUS_MAX; i++) {
    if (i < FOCUS_MAX) await page.keyboard.press('Tab'); else await page.evaluate('document.activeElement?.blur?.()');   // last step: only judge the previous one
    await page.waitForTimeout(120);
    const s = await page.evaluate(FOCUS_STEP).catch(() => null);
    if (!s) break;
    if (s.none) out.noIndicator.push(s.none);
    if (s.hidden) out.hidden.push(s.hidden);
    if (s.crop) out.cropped.push(s.crop);
    if (s.covered) out.covered.push(s.covered);
    if (!s.key) { if (i > 0) break; continue; }   // focus left the page
    if (seen.has(s.key) && i < FOCUS_MAX) { await page.evaluate('document.activeElement?.blur?.()'); const last = await page.evaluate(FOCUS_STEP).catch(() => null); if (last?.none) out.noIndicator.push(last.none); break; }   // went round
    seen.add(s.key); out.checked++;
  }
  await page.evaluate('document.activeElement?.blur?.(); window.scrollTo(0, 0);').catch(() => {});
  for (const k of ['noIndicator', 'cropped', 'hidden', 'covered']) out[k] = touch && k !== 'covered' ? [] : [...new Set(out[k])].slice(0, 12);   // a phone has no Tab key: only the covered field counts there
  return out;
}

// --stretch: make every short label 40% longer (what a translation or a long name does), measure again, and keep
// only what broke because of it. Numbers and running text are left alone. The page is not put back: this runs last.
const STRETCH = `(() => { let n = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = [];
  for (let t = w.nextNode(); t; t = w.nextNode()) nodes.push(t);
  for (const t of nodes) {
    const s = t.textContent.trim(), p = t.parentElement;
    if (s.length < 3 || s.length > 60 || /\\d/.test(s) || !p || p.closest('script,style,noscript,textarea,svg,code,pre,[contenteditable]') || !(p.checkVisibility?.() ?? true)) continue;
    t.textContent = t.textContent.replace(s, s + s.slice(0, Math.ceil(s.length * 0.4))); n++;
  }
  return n; })()`;
async function stretchPass(page, touch) {
  const kinds = ['overflow', 'clipped', 'offscreen', 'overlapControls', 'textSpill', 'wordBroken'];
  const same = (x) => x.replace(/"[^"]*"/g, '').replace(/\d+/g, '#');   // the label and the pixel numbers change with the text
  const before = await page.evaluate(`(${PROBE})(${touch})`);
  const texts = await page.evaluate(STRETCH);
  await page.waitForTimeout(300);
  const after = await page.evaluate(`(${PROBE})(${touch})`);
  const broke = [];
  for (const k of kinds) { const had = new Set((before[k] || []).map(same)); for (const x of after[k] || []) if (!had.has(same(x))) broke.push(`${k}: ${x}`); }
  return { texts, broke: broke.slice(0, 10) };
}

// --toggle: the checkboxes and switches of the page, each marked on the part the user sees and clicks (the input
// itself, or for a hidden input the small box drawn next to it, else its label).
const TOGGLE_MARK = `(max, skipSrc) => {
  const skip = skipSrc ? new RegExp(skipSrc, 'i') : null;
  const boxLike = (x) => { if (!x) return false; const r = x.getBoundingClientRect(); return r.width >= 8 && r.width <= 90 && r.height >= 8 && r.height <= 60; };
  const kinds = []; let skipped = 0;
  for (const e of document.querySelectorAll('input[type=checkbox],[role=checkbox],[role=switch]')) {
    if (kinds.length >= max) break;
    if (e.disabled || e.getAttribute('aria-disabled') === 'true' || e.closest('[aria-hidden="true"],[inert],dialog:not([open])') || !(e.checkVisibility?.() ?? true)) continue;
    const lab = e.closest('label') || (e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]')) || null;
    const text = (e.getAttribute('aria-label') || (lab || e).textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    if (skip && skip.test(text)) { skipped++; continue; }
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const drawn = r.width >= 8 && r.height >= 8 && +cs.opacity > 0.1 && cs.clipPath === 'none' && cs.clip === 'auto';
    const box = drawn ? e : [e.nextElementSibling, e.previousElementSibling].find(boxLike);
    const v = box || lab;
    if (!v) continue;
    const vr = v.getBoundingClientRect();
    if (vr.width === 0 || vr.height === 0 || vr.top > innerHeight * 3) continue;
    v.setAttribute('data-uibh-t', kinds.length); e.setAttribute('data-uibh-ti', kinds.length); v.setAttribute('data-uibh-tl', text);
    kinds.push(box ? 'box' : 'label');
  }
  return { kinds, skipped };
}`;
// Runs for ms: every frame, how far any part of the control (its own box, children, ::before/::after, outline,
// hard-edged shadows) sticks out past an ancestor that clips. ponytail: a pseudo-element is placed from its computed
// left/top/size/transform only when it is absolutely positioned in a positioned parent; others are not measured.
const TOGGLE_WATCH = `(i, ms) => new Promise((done) => {
  const v = document.querySelector('[data-uibh-t="' + i + '"]');
  if (!v) return done(null);
  ${CUT_LIB}
  const pseudo = (el, which) => {
    const cs = getComputedStyle(el, which);
    if (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.position !== 'absolute' || getComputedStyle(el).position === 'static') return null;
    const b = el.getBoundingClientRect();
    let w = px(cs.width), h = px(cs.height);
    if (!w || !h) return null;
    let cx = b.left + el.clientLeft + px(cs.left) + w / 2, cy = b.top + el.clientTop + px(cs.top) + h / 2;
    const m = cs.transform.match(/matrix\\(([^)]+)\\)/);
    if (m) { const t = m[1].split(',').map(Number); w *= Math.hypot(t[0], t[1]); h *= Math.hypot(t[2], t[3]); cx += t[4]; cy += t[5]; }
    return grow({ left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 }, cs);
  };
  const measure = () => {
    const base = v.getBoundingClientRect();
    const parts = [];
    for (const el of [v, ...v.querySelectorAll('*')].slice(0, 12)) {
      parts.push([grow(el.getBoundingClientRect(), getComputedStyle(el)), el.parentElement]);
      for (const w of ['::before', '::after']) { const r = pseudo(el, w); if (r) parts.push([r, el]); }
    }
    let worst = 0, by = null;
    for (const [r, from] of parts) { if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue; const [o, p] = cut(r, from, base); if (o > worst) { worst = o; by = p; } }
    return [worst, by];
  };
  const [rest] = measure();
  let worst = rest, by = measure()[1];
  const t0 = performance.now();
  const tick = () => {
    const [o, p] = measure();
    if (o > worst) { worst = o; by = p; }
    if (performance.now() - t0 < ms) return requestAnimationFrame(tick);
    done({ label: v.getAttribute('data-uibh-tl'), rest: Math.round(rest), worst: Math.round(worst), settled: Math.round(o), by: by ? name(by) : 'the screen edge' });
  };
  requestAnimationFrame(tick);
})`;
async function togglePass(page) {
  const out = { checked: 0, skipped: 0, unclickable: 0, cropped: [], notRestored: [] };
  const url = page.url();
  const { kinds, skipped } = await page.evaluate(`(${TOGGLE_MARK})(${TOGGLE_MAX}, ${JSON.stringify(arg('--storage') ? `\\b(${ACTIONS})\\b` : '')})`);
  out.skipped = skipped;
  const state = (i) => page.evaluate(`(() => { const e = document.querySelector('[data-uibh-ti="${i}"]'); return e ? String(e.checked ?? e.getAttribute('aria-checked')) : null; })()`);
  // The box is clicked in its middle; a label only near its left edge (its text may hold links). Clicked only when
  // that point really is the control (or the invisible input laid over it): never something covering it.
  const click = async (i) => {
    const pt = await page.evaluate(`(() => { const v = document.querySelector('[data-uibh-t="${i}"]'), e = document.querySelector('[data-uibh-ti="${i}"]');
      v.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = v.getBoundingClientRect();
      const x = ${kinds[i] === 'label' ? 'r.left + Math.min(8, r.width / 2)' : 'r.left + r.width / 2'}, y = r.top + r.height / 2, at = document.elementFromPoint(x, y);
      return at && !at.closest('a[href]') && (v.contains(at) || at === e || (e.closest('label') || e).contains(at)) ? { x, y } : null; })()`);
    if (!pt) throw new Error('covered');
    await page.mouse.click(pt.x, pt.y);
  };
  for (let i = 0; i < kinds.length; i++) {
    try {
      const before = await state(i);
      if (before === null) continue;
      await page.evaluate(`document.querySelector('[data-uibh-t="${i}"]').scrollIntoView({ block: 'center', inline: 'nearest' })`);
      const watch = page.evaluate(`(${TOGGLE_WATCH})(${i}, 650)`);
      watch.catch(() => {});
      await click(i);
      const w = await watch;
      if (page.url() !== url) { out.navigated = true; break; }   // the click went somewhere: stop clicking on this page
      out.checked++;
      if (w && w.worst > 1) out.cropped.push(`"${w.label}" cut ${w.worst}px by ${w.by}${w.rest > 1 ? ' (already at rest)' : w.settled > 1 ? ' once checked' : ' during the click animation'}`);
      if (await state(i) === before) continue;   // the click changed nothing: nothing to put back
      await click(i); await page.waitForTimeout(150);
      if (await state(i) !== before) out.notRestored.push(`"${w?.label || ''}"`);
    } catch { out.unclickable++; }   // covered by something, or moved
  }
  return out;
}

// --menus: open each menu button, measure what opened, close it. Never a menu item, never a link.
const MENU_MARK = `(max, skipSrc) => {
  const skip = skipSrc ? new RegExp(skipSrc, 'i') : null; let n = 0, skipped = 0;
  for (const e of document.querySelectorAll('button[aria-haspopup]:not([aria-haspopup="false"]),[role=button][aria-haspopup]:not([aria-haspopup="false"]),button[aria-expanded="false"],summary')) {
    if (n >= max) break;
    if (e.tagName === 'INPUT' || e.disabled || e.type === 'submit' && e.form || e.getAttribute('aria-disabled') === 'true' || e.closest('a[href],[aria-hidden="true"],[inert],dialog:not([open])') || !(e.checkVisibility?.() ?? true)) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || r.top > innerHeight * 3) continue;
    const text = (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    if (skip && skip.test(text)) { skipped++; continue; }
    e.setAttribute('data-uibh-m', n++); e.setAttribute('data-uibh-ml', text);
  }
  return { n, skipped };
}`;
const MENU_CAND = '[role=menu],[role=listbox],[role=dialog],dialog[open],[popover],[data-radix-popper-content-wrapper] > *';
// Before the click: scroll the button to the middle, remember what is already open, return where to click (null = covered).
const MENU_AIM = `(i) => { const e = document.querySelector('[data-uibh-m="' + i + '"]'); if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'nearest' });
  window.__uibhPop = new Set([...document.querySelectorAll('${MENU_CAND}')].filter((x) => (x.checkVisibility?.() ?? true) && x.getBoundingClientRect().width > 0));
  const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, at = document.elementFromPoint(x, y);
  return at && e.contains(at) ? { x, y } : null; }`;
const MENU_FIND = `const e = document.querySelector('[data-uibh-m="' + i + '"]');
  const seen = (x) => x && x.isConnected && (x.checkVisibility?.({ checkVisibilityCSS: true }) ?? true) && x.getBoundingClientRect().width > 1 && x.getBoundingClientRect().height > 1;
  const id = e && e.getAttribute('aria-controls'), det = e && e.tagName === 'SUMMARY' ? e.parentElement : null;
  const pop = !e ? null : det ? (det.open ? [...det.children].find((c) => c !== e && seen(c)) : null)
    : (id && seen(document.getElementById(id)) ? document.getElementById(id) : [...document.querySelectorAll('${MENU_CAND}')].find((x) => !window.__uibhPop.has(x) && seen(x))) || null;`;
const MENU_MEASURE = `(i) => { ${MENU_FIND}
  if (!e) return null;
  ${CUT_LIB}
  const label = e.tagName.toLowerCase() + ' "' + e.getAttribute('data-uibh-ml') + '"';
  if (!pop) return { label, pop: false };
  const r = pop.getBoundingClientRect(), vw = document.documentElement.clientWidth, problems = [];
  if (r.left < -2 || r.right > vw + 2 || r.top < -2) problems.push('opens off the screen (' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + (r.top < -2 ? ', top ' + Math.round(r.top) : '') + ')');
  // an overlay (absolutely positioned) cut by a container; a panel in the normal flow just makes its container taller
  let overlay = false; const [o, by] = cut(r, pop.parentElement, e.getBoundingClientRect());
  for (let p = pop; p && p !== by; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === 'fixed') { overlay = false; break; } if (ps === 'absolute') overlay = true; }
  if (by && o >= 8 && overlay) problems.push('cut ' + Math.round(o) + 'px by ' + name(by));
  if (!problems.length) for (const y of [r.top + Math.min(12, r.height / 2), r.top + r.height / 2, r.bottom - Math.min(12, r.height / 2)]) {
    const x = r.left + r.width / 2; if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
    const at = document.elementFromPoint(x, y);
    if (at && !pop.contains(at) && !at.contains(pop)) { problems.push('covered by ' + name(at)); break; }
  }
  return { label, pop: true, problems }; }`;
const MENU_OPEN = `(i) => { ${MENU_FIND} return !!e && (e.getAttribute('aria-expanded') === 'true' || !!(det && det.open) || !!pop); }`;
async function menuPass(page) {
  const out = { opened: 0, skipped: 0, unclickable: 0, noPopup: 0, broken: [], notClosed: [] };
  const url = page.url();
  const mark = () => page.evaluate(`(${MENU_MARK})(${MENUS_MAX}, ${JSON.stringify(arg('--storage') ? `\\b(${ACTIONS})\\b` : '')})`);
  const { n, skipped } = await mark();
  out.skipped = skipped;
  for (let i = 0; i < n; i++) {
    try {
      const pt = await page.evaluate(`(${MENU_AIM})(${i})`);
      if (!pt) { out.unclickable++; continue; }
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(450);   // the open animation: judging earlier reads a menu mid-flight as cut or invisible
      if (page.url() !== url) { out.navigated = true; await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(WAIT); break; }
      const m = await page.evaluate(`(${MENU_MEASURE})(${i})`);
      if (!m) continue;
      if (m.pop) { out.opened++; for (const p of m.problems) out.broken.push(`${m.label}: its popup ${p}`); } else out.noPopup++;
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      if (await page.evaluate(`(${MENU_OPEN})(${i})`)) { const again = await page.evaluate(`(${MENU_AIM})(${i})`); if (again) { await page.mouse.click(again.x, again.y); await page.waitForTimeout(250); } }
      if (page.url() !== url) { out.navigated = true; await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(WAIT); break; }
      if (await page.evaluate(`(${MENU_OPEN})(${i})`)) {   // left open (a drawer that ignores Escape): every later measurement would be wrong, so start the page again
        out.notClosed.push(m.label);
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(WAIT);
        if (out.notClosed.length >= 3 || (await mark()).n !== n) break;
      }
    } catch { out.unclickable++; }
  }
  out.broken = [...new Set(out.broken)].slice(0, 12);
  return out;
}

const bare = (u) => u.split(/[?#]/)[0].slice(0, 120);   // query strings can carry tokens: never written to the results
async function visit(browser, job) {
  const [w, h, touch] = VIEWPORTS[job.vp];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, userAgent: touch ? PHONE_UA : DESKTOP_UA, isMobile: touch, hasTouch: touch,
    ...(flag('--dark') ? { colorScheme: 'dark' } : {}),
    ...(READ_ONLY ? { serviceWorkers: 'block' } : {}),   // a service worker's own requests would not pass through the read-only filter
    ...(arg('--storage') ? { storageState: arg('--storage') } : {}), ...(job.locale ? { locale: job.locale } : {}) });
  if (job.locale && LOCALE_MODE.startsWith('cookie:')) await ctx.addCookies([{ name: LOCALE_MODE.slice(7), value: job.locale, url: BASE }]);
  if (arg('--init')) await ctx.addInitScript({ content: fs.readFileSync(arg('--init'), 'utf8') });
  const blocked = [];
  if (READ_ONLY) await ctx.route(READ_ONLY, (r) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.request().method()) ? (blocked.push(`${r.request().method()} ${bare(r.request().url())}`), r.abort()) : r.continue()));
  const page = await ctx.newPage();
  const rec = { route: job.route, locale: job.locale, vp: job.vp, ...(flag('--dark') ? { dark: true } : {}), pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on('pageerror', (e) => rec.pageErrors.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400 && ['document', 'image', 'script', 'stylesheet', 'font', 'fetch', 'xhr'].includes(r.request().resourceType())) rec.failedRequests.push(`${r.status()} ${bare(r.url())}`); });
  const pathPart = job.route === '/' ? '' : job.route;
  let url = `${BASE}${job.locale && LOCALE_MODE === 'prefix' ? '/' + job.locale : ''}${pathPart}` || BASE;
  if (job.locale && LOCALE_MODE.startsWith('query:')) url += `${url.includes('?') ? '&' : '?'}${LOCALE_MODE.slice(6)}=${encodeURIComponent(job.locale)}`;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    rec.status = res ? res.status() : null;
    await page.waitForTimeout(WAIT);
    rec.finalUrl = page.url();
    rec.title = await page.title();
    // Sent somewhere else (an expired session, a router guard): the page under test was never measured.
    const want = new URL(url), got = new URL(rec.finalUrl);
    const norm = (u) => (u.pathname.replace(/\/+$/, '') || '/') + (u.hash.startsWith('#/') ? u.hash.replace(/\/+$/, '') : '');
    if (norm(want) !== norm(got)) rec.redirectedTo = norm(got);
    if (/(log-?in|sign-?in|auth)([/?#]|$)/i.test(got.pathname + got.hash) && !/(log-?in|sign-?in|auth)/i.test(job.route)) rec.loginWall = true;
    rec.errorScreen = (rec.status >= 400) || await page.evaluate(([src, flags]) => new RegExp(src, flags).test(document.body.innerText.slice(0, 1500)), [ERROR_TEXT.source, ERROR_TEXT.flags]);
    rec.skeletons = await page.evaluate(() => document.querySelectorAll('.animate-pulse,[data-skeleton],.skeleton').length);
    rec.rawKeys = await page.evaluate(() => (document.body.innerText.match(/\b[a-z][a-zA-Z]+\.[a-z][a-zA-Z]+(\.[a-zA-Z_]+)+\b/g) || []).filter((s) => !/\.(com|net|org|info|io|dev|app|ai|co|[a-z]{2}|m?js|css|html?|png|jpe?g|gif|svg|webp|pdf)$/.test(s)).slice(0, 8));   // "orders.new.title" yes; "site.co.uk", "app.js" no
    rec.placeholderText = await page.evaluate(([src, flags]) => [...new Set(document.body.innerText.match(new RegExp(src, flags + 'g')) || [])].slice(0, 3), [PLACEHOLDER_TEXT.source, PLACEHOLDER_TEXT.flags]);
    rec.visual = await page.evaluate(`(${PROBE})(${touch})`);
    if (!touch && flag('--hover') && !rec.errorScreen) rec.hover = await hoverPass(page);
    if (!touch && flag('--resize') && !rec.errorScreen) {
      rec.resize = {};
      for (const [rw, rh] of [[768, 1024], [390, 844], [320, 700]]) {
        await page.setViewportSize({ width: rw, height: rh }); await page.waitForTimeout(700);
        rec.resize[rw] = await page.evaluate(`(${PROBE})(true)`);
        if (flag('--shots')) await page.screenshot({ path: path.join(OUT, 'shots', slug(job, `_resized${rw}`)) });
      }
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(700);   // back: the vp's own shot is at its size
    }
    if (flag('--shots')) await page.screenshot({ path: path.join(OUT, 'shots', slug(job)) });
    if (flag('--focus') && !rec.errorScreen && !rec.loginWall) rec.focus = await focusPass(page, touch);
    if (flag('--toggle') && !rec.errorScreen && !rec.loginWall) rec.toggle = await togglePass(page);   // after the shot: it clicks
    if (flag('--menus') && !rec.errorScreen && !rec.loginWall && !rec.toggle?.navigated) rec.menus = await menuPass(page);
    if (flag('--stretch') && !rec.errorScreen && !rec.loginWall) rec.stretch = await stretchPass(page, touch);   // last: it rewrites the page's text
  } catch (e) { rec.fatal = String(e).slice(0, 200); }
  rec.blockedWrites = blocked;
  await ctx.close();
  return rec;
}

let T0 = Date.now();
let browser;
const CHANNEL = arg('--channel', 'chrome');
try { browser = await playwright.chromium.launch({ headless: true, ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }) }); }
catch (e) {
  console.log(`no ${CHANNEL} browser (${String(e).split(/\r?\n/)[0].slice(0, 80)}); trying Playwright's chromium`);
  try { browser = await playwright.chromium.launch({ headless: true }); }
  catch { console.error(`no browser to run: install Google Chrome, or run "npx playwright install chromium" in ${HERE} (Linux: add --with-deps)`); process.exit(2); }
}

// Routes: --routes file | --discover (Next.js source) | --sitemap (sitemap.xml) | --crawl N (follow the site's own
// links from --base in the browser, so links a single-page app renders are found too). Saved to <out>/routes.txt.
// Same site = same host, "www." ignored (a sitemap listing https://www.x.com for --base https://x.com still counts).
const B = new URL(BASE.includes('://') ? BASE : 'https://' + BASE);
const host = (h) => h.replace(/^www\./, '');
const basePath = B.pathname.replace(/\/+$/, '');   // --base https://x.com/blog: routes are relative to /blog
const sameSite = (u) => { try { const x = new URL(u, BASE); return host(x.hostname) === host(B.hostname) && x.pathname.startsWith(basePath) ? x : null; } catch { return null; } };
const routeOf = (x) => (x.pathname.slice(basePath.length).replace(/\/+$/, '') || '/') + (x.hash.startsWith('#/') ? x.hash : '');
// Opening a link can itself DO something in some apps (/orders/42/cancel): action-looking links are never followed
// by the crawl, and are dropped from a sitemap when the scan is signed in.
const SKIP = new RegExp(arg('--crawl-skip', String.raw`(${ACTIONS})([-_/.?#]|$)|\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|xml|csv|json)$`), 'i');
async function fromSitemap(url) {
  const seen = new Set(), out = new Set(), queue = [url];
  while (queue.length && seen.size < 50) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const xml = await fetch(u).then((r) => r.text()).catch(() => '');
    for (const [, loc] of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      // a nested sitemap is fetched only from the site's own host (a sitemap must not point the scanner elsewhere)
      if (/\.xml(\?|$)/.test(loc)) { try { if (host(new URL(loc).hostname) === host(B.hostname)) queue.push(loc); } catch { /* not a URL */ } } else { const x = sameSite(loc); if (x) out.add(routeOf(x)); }
    }
  }
  if (!arg('--storage')) return [...out];
  const kept = [...out].filter((r) => !SKIP.test(r));
  if (kept.length < out.size) console.log(`signed in: ${out.size - kept.length} action-looking sitemap page(s) left out (--crawl-skip REGEX changes the list; --routes FILE scans exactly what you list)`);
  return kept;
}
async function crawl(limit) {
  if (arg('--storage') && !flag('--crawl-signed-in')) {
    console.error('refusing to crawl signed in: following every link of a signed-in app can trigger actions. Crawl the public\n'
      + 'pages, give the signed-in pages with --routes, or (a TEST account only) add --crawl-signed-in.');
    process.exit(2);
  }
  const ctx = await browser.newContext({ userAgent: DESKTOP_UA, ...(READ_ONLY ? { serviceWorkers: 'block' } : {}), ...(arg('--storage') ? { storageState: arg('--storage') } : {}) });
  if (READ_ONLY) await ctx.route(READ_ONLY, (r) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.request().method()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  const found = ['/'], seen = new Set(['/']);
  for (let k = 0; k < found.length && found.length < limit; k++) {
    try { await page.goto(BASE + (found[k] === '/' ? '' : found[k]), { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(2500); } catch { continue; }
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href)).catch(() => []);
    for (const h of hrefs) { const x = sameSite(h); if (!x) continue; const r = routeOf(x); if (!seen.has(r) && !SKIP.test(r)) { seen.add(r); found.push(r); } if (found.length >= limit) break; }
  }
  await ctx.close();
  return found;
}
// A sitemap or crawl is resolved once and saved; a resumed chunk reuses <out>/routes.txt (--refresh-routes redoes it).
const savedRoutes = path.join(OUT, 'routes.txt');
// A page source on the command line beats the config's (calibrating with --routes on a config that says crawl).
const SOURCES = ['--routes', '--discover', '--sitemap', '--crawl'];
const cliSource = SOURCES.find((k) => argv.includes(k));
const src = (k) => (cliSource ? (k === cliSource ? arg(k) : undefined) : arg(k));
const reuse = (src('--sitemap') || src('--crawl')) && !flag('--refresh-routes') && fs.existsSync(savedRoutes);
const readList = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
let ROUTES = reuse ? { routes: readList(savedRoutes), skipped: [] }
  : src('--discover') ? discover(src('--discover'))
  : src('--sitemap') ? { routes: await fromSitemap(src('--sitemap')), skipped: [] }
  : src('--crawl') ? { routes: await crawl(+src('--crawl')), skipped: [] }
  : src('--routes') ? { routes: readList(src('--routes')), skipped: [] }
  : (console.error('give the pages: --routes FILE | --discover DIR | --sitemap URL | --crawl N'), process.exit(2));
if (ROUTES.skipped.length) console.log(`skipped (no --ids entry): ${ROUTES.skipped.join(', ')}`);
if (!ROUTES.routes.length) { console.error(`0 routes found (sitemap/crawl on another host than --base ${BASE}? a login wall?)`); process.exit(2); }
const MAX = +arg('--max-routes', 0);
if (MAX && ROUTES.routes.length > MAX) {   // a 3000-post blog: an even spread, not the first N
  const step = ROUTES.routes.length / MAX;
  console.log(`${ROUTES.routes.length} routes, keeping ${MAX} spread evenly (--max-routes)`);
  ROUTES = { ...ROUTES, routes: Array.from({ length: MAX }, (_, k) => ROUTES.routes[Math.floor(k * step)]) };
}
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
if (!reuse) fs.writeFileSync(savedRoutes, ROUTES.routes.join('\n') + '\n');
const outJson = path.join(OUT, `${TAG}.json`);
// A page that failed to load (timeout) is not done: it is retried on the next run.
const rows = (fs.existsSync(outJson) ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : []).filter((r) => !r.fatal);
if (rows.length && rows.some((r) => !!r.dark !== flag('--dark'))) { console.error(`${outJson} holds a ${flag('--dark') ? 'light' : 'dark'} scan: give this one its own --out`); process.exit(2); }
const doneKeys = new Set(rows.map((r) => `${r.route}|${r.locale}|${r.vp}`));
T0 = Date.now();   // the budget counts scanning time, not the crawl
const jobs = [];
for (const route of ROUTES.routes) for (const [locale, vps] of MATRIX) for (const vp of vps) if (!doneKeys.has(`${route}|${locale}|${vp}`)) jobs.push({ route, locale, vp });
console.log(`${ROUTES.routes.length} routes, ${MATRIX.map(([l, v]) => `${l || '-'}:${v.join(',')}`).join(' ')}: ${jobs.length} page loads to do (${rows.length} already done)`);
let next = 0, done = 0;
await Promise.all(Array.from({ length: Math.max(1, WORKERS) }, async () => {
  while (next < jobs.length && !(BUDGET_MS && Date.now() - T0 > BUDGET_MS)) {
    const job = jobs[next++];
    const rec = await visit(browser, job);
    rows.push(rec);
    fs.writeFileSync(outJson, JSON.stringify(rows, null, 1));
    done++;
    const v = rec.visual || {};
    console.log(`${String(done).padStart(4)}/${jobs.length} ${job.route} [${job.locale || '-'}/${job.vp}] ${rec.fatal ? 'FATAL ' + rec.fatal.slice(0, 60) : ''}${rec.errorScreen ? 'ERROR-SCREEN ' : ''}visual=${v.count ?? '-'}${rec.hover ? ` hover:none=${rec.hover.noFeedback.length} shift=${rec.hover.layoutShift.length}` : ''}${rec.focus ? ` focus:none=${rec.focus.noIndicator.length} cut=${rec.focus.cropped.length} hidden=${rec.focus.hidden.length} covered=${rec.focus.covered.length}` : ''}${rec.menus ? ` menus:broken=${rec.menus.broken.length}/${rec.menus.opened}` : ''}${rec.toggle ? ` toggle:cut=${rec.toggle.cropped.length}/${rec.toggle.checked}` : ''}${rec.stretch ? ` stretch:broke=${rec.stretch.broke.length}` : ''}`);
  }
}));
await browser.close();
console.log(next < jobs.length ? `budget reached: ${jobs.length - next} page loads left, run the same command again to continue` : 'all page loads done');
const failed = rows.filter((r) => r.fatal).length;
if (failed) console.log(`${failed} page load(s) failed (timeout, network): run the same command again to retry them`);
console.log(`-> ${outJson}`);
