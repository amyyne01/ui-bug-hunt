---
name: ui-bug-hunt
description: Use when asked to scan, sweep or hunt a website's or web app's whole UI for visual bugs, including tiny ones - text cut off, overlapping elements, things off the screen edge, layouts breaking at phone/tablet/desktop widths or on window resize, missing hover states, low-contrast text, numbers split from their unit, RTL/Arabic/Hebrew order, small tap targets, sticky bars covering content - on every page, mobile and web, any framework, with or without source code. Also for "scan all the ui", "test resize / hover / mobile", "find the teeny tiny bugs".
---

# UI bug hunt

A browser measures every page; agents look only at the screenshots the measurements point to; one report groups
everything by component. **Report first, fix on the owner's go.** Nothing about the target is hard-coded: a recon
step finds it.

## Files (`<SKILL>` = this skill's folder)

| File | Use |
|---|---|
| `recon-brief.md` | 3 Haiku agents: pages, how to reach the app, tools + house rules -> `scan-config.json` |
| `scripts/scan.mjs` | `node <SKILL>/scripts/scan.mjs --config <OUT>/scan-config.json` (every flag at its top) |
| `scripts/visual_probe.js` | the measurements, run inside each page |
| `scripts/pick.mjs` | which screenshots reviewers open (the cost control) -> `batch-N.md` file lists |
| `scripts/report.mjs` | `node <SKILL>/scripts/report.mjs <OUT>/report.md <OUT>/scan` |
| `review-brief.md` | the screenshot reviewer brief, one agent per `batch-N.md` |

Setup once per machine: `npm install` in `<SKILL>/scripts` (Node 18+). It uses the installed Google Chrome; with
none it falls back to Playwright's Chromium (`npx playwright install chromium`; Linux: `--with-deps`).

## Steps

1. **Recon**: the 3 agents of `recon-brief.md`, in one message. Merge their JSON into `<OUT>/scan-config.json`
   as the brief's last section says. `<OUT>` (e.g. `ui-hunt/`) goes into the project's `.gitignore` before
   anything is written: screenshots and saved sessions are private.
2. **Data source.** Real data at stake (a signed-in app): a mocked API if the project has one; else production
   with `read-only` matching the API host or path, never clicking actions. Public site: production or local dev.
   Signed in: `npx playwright codegen --channel chrome --save-storage=<OUT>/state.json <login url>`, then `storage`.
3. **Coverage pass** in its own folder: `--config ... --out <OUT>/coverage --matrix "<main>:d" --no-hover
   --no-resize --no-shots`. Trace every error screen, failed request, redirect and login wall: a real bug, test
   data the scan cannot provide (grep the fixtures), or a missing session? Fix the setup or mark the page not
   reviewable. Then delete `<OUT>/coverage`.
4. **Calibrate on 2 pages** (`--routes` a 2-line file, `--out <OUT>/calib`). Read the JSON and 2-3 shots yourself;
   anything by design (decoration, a widening sidebar, a lifting card) is noise: tighten `visual_probe.js` before
   the wide run.
5. **Wide run in chunks**: the config's `budget` (seconds) ends a chunk; the same command resumes. Matrix: main
   locale desktop (hover + resize) + phone 390 + 320, RTL locale phone 390. Low RAM: `workers` 2, one scan at a time.
6. **Pick, then review.** `node <SKILL>/scripts/pick.mjs --shots <OUT>/scan/shots [--main <loc>] [--rtl <loc>] --out <OUT>/review <OUT>/scan`,
   then one Sonnet-tier agent per `batch-N.md`, at most 2 at a time, brief = `review-brief.md`. Each brief lists
   what earlier batches found ("already known") and the recon's by-design elements.
7. **Verify, then report.** Spot-check shot sizes and that a shot shows the page under test; trace anything that
   could be test data. `report.mjs` + the agents' tables, deduplicated by component.
8. **Deliver**: findings by component (high / medium / low) with route, locale/viewport, screenshot, likely source
   file; then what was NOT covered (unresolved routes, not-reviewable pages, one data state, untested
   interactions, clean pages not sampled).

## Cost

The browser pass is cheap; reading images is not (about 100-180k tokens per reviewer that opens 60-95 shots).
`pick.mjs` opens a size only where the probe flagged it (320 and the resized widths only when they show
something the phone and desktop shots do not), plus 1 in `--sample` clean pages (default 5) and the
`--key` pages: about 1.2 images per route instead of 3-4. Raise `--sample` for a quick sweep; for a
release-blocking audit set it to 1 and add `--all-sizes` (every flagged size is opened: the same element can
break differently at 320). Right-to-left order bugs are mostly seen by eye, so RTL phone shots are sampled densely
(`--rtl-sample`, default every 2nd page; 1 = all, for an RTL-first app). Contrast ratios, tap sizes and hover
feedback never trigger a read: the numbers report them fully.

## What the measurements catch

| Check | Meaning |
|---|---|
| overflow / offscreen | page scrolls sideways; a control past the screen edge |
| clipped / squeezed | text cut with no ellipsis; long text in a < 90 px sliver |
| overlapControls | two controls drawn on each other (fixed bars excluded) |
| coveredAtEnd | scrolled to the very end, a control still under a fixed bottom bar / floating button |
| unitSplit | a number split from its unit or currency across two lines ("1,250" / "USD", "10:30" / "PM") |
| fixedOverlap / bigDialog | fixed bars on each other; dialog or menu bigger than the screen with no scroll |
| lowContrast | text ratio < 3.5 (3 for large) on its real background |
| brokenImg / small | failed images; tap targets < 44 px on phone |
| hover (desktop) | no feedback; neighbours move (layout boxes; transforms ignored) |
| resize (desktop) | the same loaded page shrunk to 768 / 390 / 320, probed + shot at each |
| page level | error screen, login wall, redirect, uncaught JS errors, skeleton left on, raw i18n keys, 4xx/5xx |

Reviewers catch what numbers cannot: awkward wrapping, RTL order of numbers and dates, contradictory states,
mixed component styles, untranslated words, placeholder content.

## Mistakes that cost a run

| Mistake | Fix |
|---|---|
| Coverage pass and wide run in the same `out` (the wide run skips those pages) | separate folders (step 3) |
| Desktop shot taken after the resize pass (it is 320 wide) | the scanner restores the size first; spot-check sizes |
| Measuring after clicking a main action (the shot shows another page) | the scanner never clicks |
| Windows Git Bash turns `/route`, `--key /`, `--crawl-skip` args into paths | `export MSYS_NO_PATHCONV=1`, files as `C:/...` |
| `read-only` matching the site's own pages blocks its bot check / analytics | match the API host or `/api/` path only |
| Every page "clean" because each one bounced to the login | read the report's "sent to a sign-in page"; renew `state.json` |
| A mock answers unknown calls with an empty list: pages crash | coverage pass first; those crashes are not bugs |
| Odd or foreign-language text that is in the test fixtures | grep the fixtures before reporting |
| One long background run killed for memory | `budget` chunks; 2 workers |
| `scan-config.json` hand-written with `"api\.host"` | write it with a JSON encoder |
| Reviewers opening every size of every page | `pick.mjs` batches; the brief says "only these files" |
| The same bug reported once per page | `report.mjs` groups by element; dedupe agent rows by component |
