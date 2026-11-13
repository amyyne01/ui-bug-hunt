# Recon: 3 Haiku agents gather what the scan needs (send all three in ONE message)

Nothing about the target is hard-coded in this skill: these agents find it. Each one is read-only (no edits, no
browsers, no installs), works from files and harmless commands (`ls`, `git ls-files`, `cat`, `node -v`, `curl -s`),
and writes ONE JSON file into `<OUT>/recon/`. Fill `<SKILL>` (this skill's folder), `<URL>` (the site or app),
`<REPO>` (its source folder, or "none"), `<WORKSPACE>` (the folder around it, or "none") and `<OUT>`.

**No source code (`<REPO>` = none)**: agent 1 only looks for a sitemap; agent 2 reads the live HTML with `curl -s`
(`<html lang dir>`, hreflang links, `?lang=` links, the login link, script hosts); agent 3 skips the project parts.

## Agent 1: pages (`<OUT>/recon/routes.json`)

No source: does `<URL>/sitemap.xml` (or a `Sitemap:` line in `<URL>/robots.txt`) exist? Write
`{"sitemap": "<its url>"}`, else `{"crawl": 200}`, and stop. With source, find every page of the app in <REPO>:
- Framework and where pages live (Next.js app router `app/**/page.*`, pages router `pages/**`, a router file for
  React Router / Vue Router / Angular / SvelteKit `src/routes`, static `*.html`, a CMS: its sitemap).
- The URL of each page: drop route groups `(x)`, note a locale segment separately, keep `[dynamic]` / `:id` as is.
- For EVERY dynamic route, one real value that exists on the target host (seed data, a sitemap, fixtures, a public
  catalogue, tests). None found: list it under `unresolved`.
- Pages that need a signed-in user vs public pages.
Write: `{"framework": "", "routes": ["/", "/pricing"], "ids": {"/products/[id]": "/products/42"},
"unresolved": ["/orders/[id]"], "signedIn": ["/account"], "public": ["/"]}` (or `{"sitemap": ""}` / `{"crawl": 200}`).

## Agent 2: how to reach the app (`<OUT>/recon/run.json`)

- Production URL and local dev command + port (package.json scripts, config, README, env examples; never print
  secret values).
- Locales: the list, the default, which are right-to-left, and HOW a locale reaches the app: a URL prefix
  (`/fr/...`), a query parameter (`?lang=fr`), a cookie (its name), or only the browser language.
- The app's own error-screen titles in every locale (error boundary / 404 / 500 pages), from source or the live
  site. None found: an empty list.
- Sign-in: does any page need it? How a session is held (cookies, a token in localStorage or sessionStorage, SSO),
  and whether a mocked-API harness already exists (search `scripts/`, `e2e/`, `tests/`, `audit/` in <REPO> and
  <WORKSPACE> for Playwright code that routes API calls or signs in): its path and how to run it.
- Where the app's API is: a host (`api.example.com`) or a same-origin path (`/api/`, `/graphql`). The read-only
  pattern must match ONLY that, never the site's own pages, a CDN, analytics or a bot check. Note any read made
  with POST (GraphQL, search).
- Anything that blocks a headless browser: a bot gate, a cookie/consent or welcome modal (and the localStorage
  key or click that dismisses it).
Write: `{"prodUrl": "", "devCommand": "", "devUrl": "", "locales": ["en","ar"], "rtl": ["ar"],
"localeMode": "prefix | query:lang | cookie:NAME | none", "errorTexts": [], "auth": {"needed": false, "how": "",
"harness": ""}, "readOnlyPattern": "api\\.example\\.com", "postReads": false, "initScript": "", "botGate": ""}`.

## Agent 3: tools and house rules (`<OUT>/recon/tools.json`)

- Whether `<SKILL>/scripts/node_modules/playwright` exists (else a project under <WORKSPACE> with
  `node_modules/playwright/package.json`), and whether Google Chrome is installed (chrome.exe / google-chrome /
  "Google Chrome.app" in the usual places).
- Is `<OUT>` git-ignored (or is there a screenshots convention in the project's CLAUDE.md / rules / .gitignore)?
- The project's visual rules a reviewer must check, quoted briefly from CLAUDE.md, `.claude/rules/*`, design docs or
  a style guide: contrast, RTL handling of numbers and units, money and date formats, imagery rules, minimum tap
  size, placeholder content, anything else visual. None: an empty list.
- Known by-design elements that look like bugs (floating help or chat buttons, bottom navigation, banners).
- The machine: total RAM in GB (`free -g`, `vm_stat`, or PowerShell `Get-CimInstance Win32_OperatingSystem`).
Write: `{"pwFrom": "" (empty = the skill's own install), "chrome": true, "outIgnored": false, "rules": [],
"byDesign": [], "ramGb": 0}`.

## Then (main session): write `<OUT>/scan-config.json` with a JSON encoder

- `base`: run.prodUrl (or run.devUrl when scanning local dev).
- The pages, ONE of: `sitemap` / `crawl` (copied from routes.json), or `routes`: `<OUT>/routes.txt` written as
  routes.json `routes` WITHOUT any entry containing `[` or `:`, plus every value of `ids`.
- `matrix`: `"<main>:d,m,x;<rtl>:m"` (no RTL locale: `"<main>:d,m,x"`; no locale in URLs: `"-:d,m,x"`);
  `locale-mode`: run.localeMode.
- `error-text`: only if run.errorTexts is not empty: the non-empty titles, regex-escaped, joined with `|`, followed by
  `|Something went wrong|Application error|Internal Server Error|This page could not be found|Page not found`.
- `read-only`: run.readOnlyPattern when scanning production with real data; `storage`: `<OUT>/state.json` when
  auth is needed (made with `npx playwright codegen --channel chrome --save-storage=<OUT>/state.json <login url>`);
  `init`: `<OUT>/init.js` when run.initScript is set.
- `pw-from`: tools.pwFrom when not empty; `channel`: `"chrome"` if tools.chrome else `"chromium"`.
- `out`: `<OUT>/scan`, `hover`/`resize`/`shots`: true, `budget`: 600, `workers`: 2 (1 if ramGb < 8).
- If tools.outIgnored is false: add `<OUT>/` to the project's `.gitignore` (tell the user).
- Put tools.rules and tools.byDesign into the reviewer brief; report `unresolved` routes as not scanned.
