// Visual bugs on the page as drawn (ui-bug-hunt). Passed to page.evaluate(`(${src})(touch)`): self-contained, no imports.
// touch = phone/tablet viewport (tap-target sizes are checked only then). Returns lists per check + a total `count`.
(touch) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const sel = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).filter((c) => !c.includes('[')).slice(0, 3).join('.') : '';
    const sec = el.closest('main,header,nav,aside,footer,[role=dialog],dialog,section');
    const lab = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${sec ? sec.tagName.toLowerCase() + ' > ' : ''}${el.tagName.toLowerCase()}${id}${cls}${lab ? ` "${lab}"` : ''}`.slice(0, 150);
  };
  const visible = (el) => (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
  const inView = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh * 3;
  const clipsX = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false; };
  const out = { vw, scrollWidth: document.documentElement.scrollWidth, overflow: [], clipped: [], squeezed: [], brokenImg: [],
    overlapControls: [], offscreen: [], small: [], fixedOverlap: [], lowContrast: [], bigDialog: [] };

  // 1. horizontal overflow of the page
  if (out.scrollWidth > vw + 1) {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || (r.right <= vw + 1 && r.left >= -1) || clipsX(el) || !visible(el)) continue;
      out.overflow.push(`${sel(el)} (${Math.round(r.left)}..${Math.round(r.right)})`);
      if (out.overflow.length >= 6) break;
    }
  }
  // 2. text cut off with no ellipsis / clamp (a word or a label that loses its end)
  for (const el of document.querySelectorAll('h1,h2,h3,h4,p,span,a,button,label,td,th,li,dt,dd,div')) {
    if (el.children.length > 2 || !visible(el)) continue;
    const t = (el.textContent || '').trim();
    if (t.length < 3 || el.clientWidth <= 2 || el.clientHeight <= 2) continue;   // screen-reader-only text
    if (el.closest('[aria-hidden="true"]') || getComputedStyle(el).pointerEvents === 'none') continue;   // decoration (tickers, marquees)
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r)) continue;
    const cutX = el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll';
    const cutY = el.scrollHeight > el.clientHeight + 3 && cs.overflowY === 'hidden' && el.clientHeight > 0;
    if (cutX || cutY) out.clipped.push(`${sel(el)} ${cutX ? 'x' : ''}${cutY ? 'y' : ''} ${el.clientWidth}/${el.scrollWidth}w ${el.clientHeight}/${el.scrollHeight}h`);
    if (out.clipped.length >= 15) break;
  }
  // 3. long text squeezed into a sliver
  for (const el of document.querySelectorAll('p,h1,h2,h3,h4,li,dd,td,label')) {
    const t = (el.textContent || '').trim();
    if (t.length < 25 || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (inView(r) && r.width > 2 && r.width < 90) out.squeezed.push(`${sel(el)} w=${Math.round(r.width)}`);
    if (out.squeezed.length >= 10) break;
  }
  // 4. images that failed or have no size
  for (const img of document.images) {
    if (!visible(img)) continue;
    const r = img.getBoundingClientRect();
    if (!inView(r)) continue;
    if (img.complete && img.naturalWidth === 0) out.brokenImg.push(`${sel(img)} ${(img.currentSrc || img.src).slice(0, 90)}`);
  }
  // 5. controls: overlapping each other, cut by the viewport edge, too small to tap (touch)
  const controls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=switch],[role=checkbox],summary')]
    .filter((el) => visible(el) && !el.closest('[aria-hidden="true"],[inert],dialog:not([open])'))
    .filter((el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === 'fixed' || ps === 'sticky') return false; } return true; })
    .map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => inView(r));
  for (let i = 0; i < controls.length && out.overlapControls.length < 10; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 4 && h > 4 && w * h > 0.25 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) {
      // the one on top must be one of them, else something else covers both (a menu)
      const top = document.elementFromPoint(Math.max(a.r.left, b.r.left) + w / 2, Math.max(a.r.top, b.r.top) + h / 2);
      if (top && (a.el.contains(top) || b.el.contains(top))) out.overlapControls.push(`${sel(a.el)} ⨯ ${sel(b.el)} (${Math.round(w)}×${Math.round(h)})`);
    }
  }
  const seen = new Map();
  for (const { el, r } of controls) {
    if (r.top < vh * 3 && (r.right > vw + 2 || r.left < -2) && !clipsX(el)) out.offscreen.push(`${sel(el)} (${Math.round(r.left)}..${Math.round(r.right)})`);
    if (!touch || Math.min(r.width, r.height) >= 44) continue;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;   // links in running text
    if (['checkbox', 'radio'].includes(el.type) && el.closest('label')) continue;     // the label is the target
    const k = sel(el);
    const s = seen.get(k) || { n: 0, w: Math.round(r.width), h: Math.round(r.height) };
    s.n++; seen.set(k, s);
  }
  out.small = [...seen.entries()].map(([k, s]) => `${s.w}×${s.h} ×${s.n} ${k}`).slice(0, 20);
  out.smallCount = [...seen.values()].reduce((n, s) => n + s.n, 0);
  out.offscreen = out.offscreen.slice(0, 8);
  // 5b. scrolled to the very end: is the last content still under a fixed bottom bar (bottom nav, AI button)?
  out.coveredAtEnd = [];
  {
    const sc = [...document.querySelectorAll('main, main *')].filter((e) => e.scrollHeight > e.clientHeight + 40 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).sort((a, b) => b.clientHeight - a.clientHeight)[0];
    const prev = sc ? sc.scrollTop : window.scrollY;
    if (sc) sc.scrollTop = sc.scrollHeight; else window.scrollTo(0, document.documentElement.scrollHeight);
    const bars = [...document.body.querySelectorAll('*')].filter((el) => { const cs = getComputedStyle(el); if (cs.position !== 'fixed' || !visible(el) || cs.pointerEvents === 'none') return false; const r = el.getBoundingClientRect(); return r.height > 20 && r.height < vh * 0.4 && r.bottom >= vh - 2 && r.top > vh * 0.5; });
    for (const { el } of controls.length ? controls : []) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom <= 0 || r.top >= vh) continue;
      for (const b of bars) {
        const rb = b.getBoundingClientRect();
        const w = Math.min(r.right, rb.right) - Math.max(r.left, rb.left), h = Math.min(r.bottom, rb.bottom) - Math.max(r.top, rb.top);
        if (w > 8 && h > 8 && h >= r.height * 0.5) {
          const at = document.elementFromPoint(Math.max(r.left, rb.left) + w / 2, Math.max(r.top, rb.top) + h / 2);
          if (at && b.contains(at)) { out.coveredAtEnd.push(`${sel(el)} under ${sel(b)} (${Math.round(w)}×${Math.round(h)})`); break; }
        }
      }
      if (out.coveredAtEnd.length >= 6) break;
    }
    if (sc) sc.scrollTop = prev; else window.scrollTo(0, prev);
  }
  // 6. fixed / sticky bars on top of each other
  const fixed = [...document.body.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    if (!visible(el) || (cs.pointerEvents === 'none' && !(el.textContent || '').trim())) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && !(r.width >= vw * 0.95 && r.height >= vh * 0.9);
  });
  for (let i = 0; i < fixed.length; i++) for (let j = i + 1; j < fixed.length; j++) {
    const a = fixed[i], b = fixed[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2) out.fixedOverlap.push(`${sel(a)} ⨯ ${sel(b)} (${Math.round(w)}×${Math.round(h)})`);
  }
  out.fixedOverlap = out.fixedOverlap.slice(0, 6);
  // 7. text barely readable on its own background (light on light, dark on dark)
  const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') return null; const c = rgb(cs.backgroundColor); if (c && c.a > 0.85) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const done = new Set();
  for (const el of document.querySelectorAll('h1,h2,h3,h4,p,span,a,button,label,td,th,li,small,strong')) {
    if (out.lowContrast.length >= 12) break;
    const t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (t.length < 2 || !visible(el) || el.closest('[disabled],[aria-disabled="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || r.top > vh * 2) continue;
    const cs = getComputedStyle(el), fg = rgb(cs.color), bg = bgOf(el);
    if (!fg || !bg || fg.a < 0.5) continue;
    const l1 = lum(fg), l2 = lum(bg), ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.6 && +cs.fontWeight >= 700);
    if (ratio < (big ? 3 : 3.5)) {   // below AA-large for big text, a little below AA (4.5) for body: real misses only
      const k = `${cs.color}|${bg.r},${bg.g},${bg.b}`;
      if (done.has(k)) continue; done.add(k);
      out.lowContrast.push(`${ratio.toFixed(2)} ${sel(el)} ${cs.color} on rgb(${bg.r},${bg.g},${bg.b})`);
    }
  }
  // 7b. a number split from its unit/currency across two lines ("1,250" / "USD", "10:30" / "PM", "12" / "mo"):
  //     the commonest right-to-left defect, and wrong in any language. Measured on the text's own line boxes.
  out.unitSplit = [];
  {
    const re = /(\d[\d.,   ]*\d|\d)[   ]?([A-Za-z֐-׿؀-ۿ$€£¥₺%.]{1,5})(?![A-Za-z؀-ۿ])/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.unitSplit.length < 10; n = walker.nextNode()) {
      const t = n.textContent;
      // labels only (a price, a time, a count): in running prose a number may wrap away from its word legitimately
      if (!t || t.trim().length > 40 || !/\d/.test(t) || !n.parentElement || !visible(n.parentElement)) continue;
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const range = document.createRange();
        range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        const box = range.getBoundingClientRect();
        if (tops.size > 1 && box.bottom > 0 && box.top < vh * 2) { out.unitSplit.push(`${sel(n.parentElement)} "${m[0].trim()}" on ${tops.size} lines`); break; }
      }
    }
  }
  // 8. a dialog / sheet / menu taller or wider than the screen with no scroll inside
  for (const d of document.querySelectorAll('[role=dialog],dialog[open],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]')) {
    if (!visible(d)) continue;
    const r = d.getBoundingClientRect();
    const scrolls = d.scrollHeight > d.clientHeight + 2 || [...d.querySelectorAll('*')].some((e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
    if ((r.bottom > vh + 2 || r.top < -2) && !scrolls) out.bigDialog.push(`${sel(d)} ${Math.round(r.top)}..${Math.round(r.bottom)} of ${vh}`);
    if (r.right > vw + 2 || r.left < -2) out.bigDialog.push(`${sel(d)} x ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
  }
  out.count = ['overflow', 'coveredAtEnd', 'unitSplit', 'clipped', 'squeezed', 'brokenImg', 'overlapControls', 'offscreen', 'fixedOverlap', 'lowContrast', 'bigDialog']
    .reduce((n, k) => n + out[k].length, 0) + (touch ? out.small.length : 0);
  return out;
}
