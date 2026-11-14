#!/usr/bin/env node
/**
 * ui-bug-hunt report: merge scan JSON files into one Markdown report. Findings are grouped by ELEMENT (the same
 * component broken on 40 routes is one finding listing 40 routes), most widespread first.
 *
 *   node report.mjs <out.md> <scan folder | scan.json ...> [--baseline <earlier scan folder>]
 *
 * --baseline: after fixes, scan again into a NEW folder and pass the earlier one here: the report opens with what
 * is fixed, what is new and what is still there (compared by element, not by pixel numbers).
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const bi = args.indexOf('--baseline');
const baseline = bi >= 0 ? args.splice(bi, 2)[1] : null;   // an earlier scan: the report starts with what is fixed, new, still there
const [outMd, ...files] = args;
if (!outMd || !files.length) { console.error('usage: node report.mjs <out.md> <scan folder | scan.json ...> [--baseline <earlier scan folder>]'); process.exit(2); }
// Scan results: files, or folders whose *.json are read; anything that is not an array of scan rows
// (scan-config.json, picked.json, recon output) is skipped. No shell glob needed (PowerShell/cmd do not expand them).
function loadRows(inputs) {
  const files = inputs.flatMap((a) => (fs.existsSync(a) && fs.statSync(a).isDirectory()
    ? fs.readdirSync(a).filter((f) => f.endsWith('.json')).map((f) => path.join(a, f)) : [a]));
  const rows = [];
  for (const f of files) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(d) && d.every((r) => r && r.route)) rows.push(...d); } catch { /* not a scan file */ }
  }
  return rows;
}
const rows = loadRows(files);
if (!rows.length) { console.error('no scan rows found in ' + files.join(', ')); process.exit(2); }

// Numbers that change per page (positions, sizes) must not split one element into many findings.
const norm = (s) => s.replace(/\(-?\d+\.\.-?\d+\)|\d+×\d+|w=\d+|\d+\/\d+[wh]|×\d+|-?\d+\.\.-?\d+ of \d+/g, '#').replace(/\d+/g, '#');   // also digits in labels: one price element, not one group per price
const KINDS = ['overflow', 'coveredAtEnd', 'unitSplit', 'overlapControls', 'offscreen', 'fixedOverlap', 'bigDialog', 'clipped', 'brokenImg', 'lowContrast', 'squeezed', 'small', 'misaligned', 'sizeMismatch', 'iconSize', 'styleMismatch', 'colourDrift', 'wordBroken', 'sepStart', 'textSpill', 'scrollNoCue', 'rtlAlign', 'kbdHint', 'placeholderCut'];
const ORDER = ['overflow', 'coveredAtEnd', 'unitSplit', 'overlapControls', 'offscreen', 'fixedOverlap', 'bigDialog', 'clipped', 'wordBroken', 'textSpill', 'brokenImg', 'menu', 'focusCovered', 'toggleCrop', 'focusHidden', 'focusCrop', 'lowContrast', 'focusNone', 'hoverShift', 'squeezed', 'sepStart', 'placeholderCut', 'scrollNoCue', 'rtlAlign', 'misaligned', 'sizeMismatch', 'iconSize', 'styleMismatch', 'colourDrift', 'small', 'kbdHint', 'hoverNone', 'stretch'];
const WHAT = {
  overflow: 'page scrolls sideways (element wider than the screen)',
  coveredAtEnd: 'scrolled to the end, a control is still under a fixed bottom bar',
  unitSplit: 'a number split from its unit/currency across two lines',
  overlapControls: 'two controls drawn on top of each other',
  offscreen: 'a control sticks out past the screen edge',
  fixedOverlap: 'two fixed/sticky bars on top of each other',
  bigDialog: 'dialog/menu taller or wider than the screen with no scroll',
  clipped: 'text cut off with no ellipsis',
  brokenImg: 'image failed to load',
  lowContrast: 'text too faint on its background (ratio, colours)',
  squeezed: 'long text squeezed into a sliver',
  small: 'tap target under 44 px (phone)',
  hoverShift: 'hovering moves the neighbours',
  hoverNone: 'no hover feedback (pointer only or nothing)',
  focusHidden: 'keyboard focus lands on something not visible (a closed menu, an off-screen link)',
  focusCrop: 'the focus ring is cut off by a container',
  focusNone: 'no visible focus indicator when reached with Tab',
  stretch: 'fine today, breaks when its text is 40% longer (a translation, a long name)',
  toggleCrop: 'a checkbox or switch cut off by its container when clicked',
  misaligned: 'an item a few px off its neighbours, or an icon off its label',
  sizeMismatch: 'controls side by side with different heights',
  iconSize: 'one icon of a set drawn at another size',
  styleMismatch: 'same component, one drawn with another colour or font',
  colourDrift: 'two text colours that are almost, but not, the same',
  wordBroken: 'a short word broken across lines (one letter or half a word per line)',
  sepStart: 'a separator (· : » |) starts a line instead of staying with what precedes it',
  textSpill: 'a label wider than its box, drawn over its neighbour',
  scrollNoCue: 'a tab or chip strip scrolls sideways with nothing to show it, or its active item is out of view',
  rtlAlign: 'right-to-left text pinned to the left (a physical text-align: left)',
  kbdHint: 'a keyboard hint (Esc, Ctrl K) shown on a touch screen',
  placeholderCut: 'a placeholder longer than its field (cut mid-word)',
  menu: 'a menu or popup that opens off the screen, cut by a container, or under another layer',
  focusCovered: 'a focused field or button left under a fixed bar',
};
function collect(rows) {
const groups = new Map();
const pages = {};
const page = (k, v) => (pages[k] ||= []).push(v);
const add = (kind, item, route, where) => {
  const key = `${kind}|${norm(item)}`;
  const g = groups.get(key) || { kind, routes: new Set(), where: new Set(), sample: '' };
  g.routes.add(route); g.where.add(where); g.sample = item; groups.set(key, g);
};
for (const r of rows) {
  const where = `${r.locale || '-'}/${r.vp}${r.dark ? '/dark' : ''}`;
  if (r.fatal) { page('load failed', `${r.route} ${where}: ${r.fatal.slice(0, 90)}`); continue; }
  if (r.loginWall) { page('sent to a sign-in page (session expired or missing --storage): not measured', `${r.route} ${where} -> ${r.redirectedTo || ''}`); continue; }
  if (r.redirectedTo) page('redirected (findings below are for the page it landed on)', `${r.route} ${where} -> ${r.redirectedTo}`);
  if (r.errorScreen) { page('error screen (trace it: a real crash, or test data the scan could not provide?)', `${r.route} ${where}`); continue; }
  if (r.pageErrors?.length) page('uncaught JS errors', `${r.route} ${where}: ${r.pageErrors[0].slice(0, 90)}`);
  const cons = (r.consoleErrors || []).filter((e) => !/Failed to load resource/.test(e));   // those are the failed requests below
  const dup = cons.find((e) => /same key/i.test(e));
  if (dup) page('duplicate list keys (rows can be doubled or dropped)', `${r.route} ${where}: ${dup.slice(0, 110)}`);
  else if (cons.length) page('console errors', `${r.route} ${where}: ${cons[0].slice(0, 110)}`);
  if (r.placeholderText?.length) page('placeholder text on a shipped page', `${r.route} ${where}: ${r.placeholderText.join(', ')}`);
  if (r.skeletons) page('loading skeleton still on screen', `${r.route} ${where}`);
  const keys = r.rawKeys;
  if (keys?.length) page('untranslated keys on screen', `${r.route} ${where}: ${keys.slice(0, 3).join(', ')}`);
  for (const fr of (r.failedRequests || []).slice(0, 3)) page('failed requests (4xx/5xx)', `${r.route} ${where}: ${fr}`);
  const probes = [['', r.visual || {}], ...Object.entries(r.resize || {}).map(([w, v]) => [` resized${w}`, v || {}])];
  for (const [tag, v] of probes) for (const kind of KINDS) for (const item of v[kind] || []) add(kind, item, r.route, where + tag);
  for (const [kind, key] of [['hoverShift', 'layoutShift'], ['hoverNone', 'noFeedback']]) for (const item of r.hover?.[key] || []) add(kind, item, r.route, where);
  for (const item of r.toggle?.cropped || []) add('toggleCrop', item, r.route, where);
  for (const item of r.stretch?.broke || []) add('stretch', item.replace(/"[^"]*"/, ''), r.route, where);   // the lengthened label is not the real one
  for (const [kind, key] of [['focusHidden', 'hidden'], ['focusCrop', 'cropped'], ['focusNone', 'noIndicator'], ['focusCovered', 'covered']]) for (const item of r.focus?.[key] || []) add(kind, item, r.route, where);
  for (const item of r.toggle?.notRestored || []) page('checkbox left changed by the click test (it did not switch back)', `${r.route} ${where}: ${item}`);
  if (r.toggle?.skipped || r.toggle?.unclickable) page('checkboxes NOT tested by the click test (do not read them as clean)', `${r.route} ${where}: ${r.toggle.checked} clicked, ${r.toggle.skipped} skipped for an action-looking label (signed in), ${r.toggle.unclickable} covered or not clickable`);
  for (const item of r.menus?.broken || []) add('menu', item, r.route, where);
  for (const item of r.menus?.notClosed || []) page('a menu or drawer that Escape does not close', `${r.route} ${where}: ${item}`);
  if (r.menus?.skipped) page('menus NOT opened by the menu test (do not read them as clean)', `${r.route} ${where}: ${r.menus.opened} opened, ${r.menus.skipped} skipped for an action-looking label (signed in), ${r.menus.unclickable} covered or not clickable`);
  if (r.toggle?.navigated) page('a checkbox click opened another page (click test stopped there)', `${r.route} ${where}`);
}
return { groups, pages };
}
const { groups, pages } = collect(rows);
const routes = new Set(rows.map((r) => r.route));
const lines = [`# UI bug hunt — ${rows.length} page loads, ${routes.size} routes`, '',
  'Measured findings. Screenshot-review findings (agents) go in their own tables, deduplicated by component.', ''];
const diff = {};
if (baseline) {
  const old = collect(loadRows([baseline])).groups;
  if (!old.size && !loadRows([baseline]).length) { console.error('no scan rows found in the baseline ' + baseline); process.exit(2); }
  const show = (g) => `- \`${g.kind}: ${g.sample.slice(0, 160)}\` — ${[...g.routes].sort().slice(0, 4).join(', ')}`;
  const gone = [...old].filter(([k]) => !groups.has(k)).map(([, g]) => g);
  const fixed = gone.filter((g) => [...g.routes].some((r) => routes.has(r)));   // its page was scanned again and it is no longer there
  const fresh = [...groups].filter(([k]) => !old.has(k)).map(([, g]) => g);
  Object.assign(diff, { fixed: fixed.length, new: fresh.length, still: groups.size - fresh.length, notRescanned: gone.length - fixed.length });
  lines.push(`## Since the last scan: ${diff.fixed} fixed, ${diff.new} new, ${diff.still} still there${diff.notRescanned ? `, ${diff.notRescanned} on pages not scanned this time` : ''}`, '',
    `### Fixed (${fixed.length})`, ...fixed.slice(0, 80).map(show), '', `### New (${fresh.length})`, ...fresh.slice(0, 80).map(show), '');
}
for (const [k, v] of Object.entries(pages)) lines.push(`## ${k} (${v.length})`, ...[...new Set(v)].sort().slice(0, 80).map((x) => `- ${x}`), '');
const counts = {};
for (const kind of ORDER) {
  const items = [...groups.values()].filter((g) => g.kind === kind).sort((a, b) => b.routes.size - a.routes.size);
  counts[kind] = items.length;
  if (!items.length) continue;
  lines.push(`## ${kind}: ${WHAT[kind]} — ${items.length} distinct elements`, '');
  for (const g of items.slice(0, 60)) {
    const rs = [...g.routes].sort();
    lines.push(`- **${rs.length} route(s)** \`${g.sample.slice(0, 180)}\` — ${[...g.where].sort().join(', ').slice(0, 100)} — ${rs.slice(0, 6).join(', ')}${rs.length > 6 ? ' …' : ''}`);
  }
  lines.push('');
}
fs.writeFileSync(outMd, lines.join('\n'));
console.log(`${outMd}: ${rows.length} loads, ${routes.size} routes`, counts, ...(baseline ? [diff] : []), Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.length])));
