#!/usr/bin/env node
/**
 * ui-bug-hunt report: merge scan JSON files into one Markdown report. Findings are grouped by ELEMENT (the same
 * component broken on 40 routes is one finding listing 40 routes), most widespread first.
 *
 *   node report.mjs <out.md> <scan folder | scan.json ...>
 */
import fs from 'node:fs';
import path from 'node:path';

const [outMd, ...files] = process.argv.slice(2);
if (!outMd || !files.length) { console.error('usage: node report.mjs <out.md> <scan folder | scan.json ...>'); process.exit(2); }
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
const KINDS = ['overflow', 'coveredAtEnd', 'unitSplit', 'overlapControls', 'offscreen', 'fixedOverlap', 'bigDialog', 'clipped', 'brokenImg', 'lowContrast', 'squeezed', 'small', 'misaligned', 'sizeMismatch', 'iconSize', 'styleMismatch', 'colourDrift'];
const ORDER = ['overflow', 'coveredAtEnd', 'unitSplit', 'overlapControls', 'offscreen', 'fixedOverlap', 'bigDialog', 'clipped', 'brokenImg', 'toggleCrop', 'lowContrast', 'hoverShift', 'squeezed', 'misaligned', 'sizeMismatch', 'iconSize', 'styleMismatch', 'colourDrift', 'small', 'hoverNone'];
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
  toggleCrop: 'a checkbox or switch cut off by its container when clicked',
  misaligned: 'an item a few px off its neighbours, or an icon off its label',
  sizeMismatch: 'controls side by side with different heights',
  iconSize: 'one icon of a set drawn at another size',
  styleMismatch: 'same component, one drawn with another colour or font',
  colourDrift: 'two text colours that are almost, but not, the same',
};
const groups = new Map();
const pages = {};
const page = (k, v) => (pages[k] ||= []).push(v);
const add = (kind, item, route, where) => {
  const key = `${kind}|${norm(item)}`;
  const g = groups.get(key) || { kind, routes: new Set(), where: new Set(), sample: '' };
  g.routes.add(route); g.where.add(where); g.sample = item; groups.set(key, g);
};
for (const r of rows) {
  const where = `${r.locale || '-'}/${r.vp}`;
  if (r.fatal) { page('load failed', `${r.route} ${where}: ${r.fatal.slice(0, 90)}`); continue; }
  if (r.loginWall) { page('sent to a sign-in page (session expired or missing --storage): not measured', `${r.route} ${where} -> ${r.redirectedTo || ''}`); continue; }
  if (r.redirectedTo) page('redirected (findings below are for the page it landed on)', `${r.route} ${where} -> ${r.redirectedTo}`);
  if (r.errorScreen) { page('error screen (trace it: a real crash, or test data the scan could not provide?)', `${r.route} ${where}`); continue; }
  if (r.pageErrors?.length) page('uncaught JS errors', `${r.route} ${where}: ${r.pageErrors[0].slice(0, 90)}`);
  if (r.skeletons) page('loading skeleton still on screen', `${r.route} ${where}`);
  const keys = r.rawKeys;
  if (keys?.length) page('untranslated keys on screen', `${r.route} ${where}: ${keys.slice(0, 3).join(', ')}`);
  for (const fr of (r.failedRequests || []).slice(0, 3)) page('failed requests (4xx/5xx)', `${r.route} ${where}: ${fr}`);
  const probes = [['', r.visual || {}], ...Object.entries(r.resize || {}).map(([w, v]) => [` resized${w}`, v || {}])];
  for (const [tag, v] of probes) for (const kind of KINDS) for (const item of v[kind] || []) add(kind, item, r.route, where + tag);
  for (const [kind, key] of [['hoverShift', 'layoutShift'], ['hoverNone', 'noFeedback']]) for (const item of r.hover?.[key] || []) add(kind, item, r.route, where);
  for (const item of r.toggle?.cropped || []) add('toggleCrop', item, r.route, where);
  for (const item of r.toggle?.notRestored || []) page('checkbox left changed by the click test (it did not switch back)', `${r.route} ${where}: ${item}`);
  if (r.toggle?.navigated) page('a checkbox click opened another page (click test stopped there)', `${r.route} ${where}`);
}
const routes = new Set(rows.map((r) => r.route));
const lines = [`# UI bug hunt — ${rows.length} page loads, ${routes.size} routes`, '',
  'Measured findings. Screenshot-review findings (agents) go in their own tables, deduplicated by component.', ''];
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
console.log(`${outMd}: ${rows.length} loads, ${routes.size} routes`, counts, Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.length])));
