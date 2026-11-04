// ============================================================
//  PHONE GATE - the landscape iPhone, measured
// ------------------------------------------------------------
//  Opens a production preview in a phone-shaped headless Chrome (notch insets on),
//  walks every menu screen and HUD state, and measures the ten rules of
//  spec/phone-landscape-standard.md. Exits 1 on any failure; one line per failure:
//    FAIL <window> <screen> R<n> <rule> "<element text>" <measured number>
//
//    bunx vite build --outDir /tmp/x && bunx vite preview --outDir /tmp/x --port 5220 --strictPort
//    bun scripts/phone-gate.ts --port 5220 [--only title,settings:audio,hud] [--window pwa,safari,small,portrait,desktop]
//                              [--out /tmp/sr2/phone/shots/gate] [--break <rule 1-11>] [--list]
//
//  --break <n> injects CSS/JS into the page (never the UI source) that breaks rule n on purpose, so
//  a gate nobody has seen fail is never trusted.
//  --break 11 injects `.sr-ui[data-touch] .pause-panel, .settings-panel {height: 80vh !important}`: fits in pwa, too tall in the safari window once vh is Safari's 402. Proofs are in /tmp/sr2/phone/gate-report.md.
//  Rules 5 and 6 run only in the three landscape windows; `portrait` runs the reach rule (R1) only;
//  `desktop` (1920x1080, no touch) runs the desktop guard (R10) only.
// ============================================================

import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { findChrome } from './chrome'

// ---------------------------------------------------------------- exceptions
// An unavoidable exception is named here with its reason. Two lead rulings, both for the road band only.
// rule: rule number; screen: step name or prefix; text: regex on the element text.
const EXCEPTIONS: { rule: number; screen: string; text: RegExp; detail?: RegExp; reason: string }[] = [
  {
    rule: 7,
    screen: 'hud',
    text: /^countdown /,
    detail: /road band/,
    reason: 'Ruling (lead, 5 Nov 2026): the 3-2-1-GO countdown may sit mid-screen, because Hud.tsx says it is the one thing allowed there and only while nobody can move. Overlap with other panels still fails.',
  },
  {
    rule: 7,
    screen: 'hud',
    text: /^turnscard /,
    detail: /road band/,
    reason: 'Ruling (lead, 5 Nov 2026): Hunt Turns\' between-turns card, same reason as the countdown. Overlap with other panels still fails.',
  },
]

const RULE_NAME: Record<number, string> = {
  1: 'reach',
  2: 'target-size',
  3: 'obscured',
  4: 'safe-area',
  5: 'first-screen',
  6: 'tap-and-swipe',
  7: 'hud-overlap',
  8: 'key-words',
  9: 'text',
  10: 'desktop-guard',
  11: 'vh-units',
}

type Insets = { l: number; r: number; t: number; b: number }
interface Win {
  w: number
  h: number
  ins: Insets
  touch: boolean
  rules: number[]
}
const LAND = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]
const WINS: Record<string, Win> = {
  pwa: { w: 874, h: 402, ins: { l: 62, r: 62, t: 0, b: 20 }, touch: true, rules: LAND },
  safari: { w: 874, h: 292, ins: { l: 62, r: 62, t: 0, b: 20 }, touch: true, rules: LAND },
  small: { w: 667, h: 331, ins: { l: 0, r: 0, t: 0, b: 0 }, touch: true, rules: LAND },
  portrait: { w: 390, h: 844, ins: { l: 0, r: 0, t: 47, b: 34 }, touch: true, rules: [1] },
  desktop: { w: 1920, h: 1080, ins: { l: 0, r: 0, t: 0, b: 0 }, touch: false, rules: [10] },
}

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}
const PORT = arg('port', '5220')!
const OUT = arg('out', '/tmp/sr2/phone/shots/gate')!
const ONLY = (arg('only') ?? '').split(',').filter(Boolean)
const WINDOWS = (arg('window') ?? 'pwa,safari,small,portrait,desktop').split(',').filter(Boolean)
const BREAK = Number(arg('break', '0'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

// ---------------------------------------------------------------- in the page
// Plain JS, installed as window.__gate after every load.
const PAGE = String.raw`(() => {
const SEL_TAP = 'button, a, [data-nav], [role=tab], [role=radio], [role=button], input, textarea, select, .touch-pedal, .touch-stick, .touch-top, .touch-pulse'
const R = (e) => e.getBoundingClientRect()
const rd = (n) => Math.round(n * 10) / 10
const vis = (e) => { try { return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) } catch (_) { return true } }
const desc = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '')
const label = (e) => {
  const t = (e.getAttribute('aria-label') || e.innerText || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 36)
  return t ? t + ' [' + desc(e) + ']' : desc(e)
}
let W = innerWidth, H = innerHeight
function clipsFrom(from) {
  const out = []
  for (let a = from; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a)
    const ox = cs.overflowX, oy = cs.overflowY
    // a fixed box answers to the screen, not to what it sits inside: nothing above it clips it
    const fixedHere = cs.position === 'fixed'
    if (ox === 'visible' && oy === 'visible') { if (fixedHere) break; continue }
    out.push({
      a,
      cx: ox !== 'visible', cy: oy !== 'visible',
      sx: (ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth + 1,
      sy: (oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1,
    })
    if (fixedHere) break
  }
  return out
}
// Where a finger can bring this box to: scrollers shift it into their window, anything else clips it.
function reachRect(self, includeSelf) {
  const b = R(self)
  const r = { l: b.left, t: b.top, r: b.right, b: b.bottom }
  const chain = !includeSelf && getComputedStyle(self).position === 'fixed' ? [] : clipsFrom(includeSelf ? self : self.parentElement)
  for (const c of chain) {
    const ar = R(c.a)
    if (c.cx && (r.l < ar.left - 1 || r.r > ar.right + 1)) {
      if (!c.sx) return { r, fail: 'clipped by ' + desc(c.a) + ' (x ' + rd(r.l) + '..' + rd(r.r) + ' in ' + rd(ar.left) + '..' + rd(ar.right) + ')' }
      const dx = (r.r - r.l > ar.width || r.l < ar.left - 1) ? ar.left - r.l : ar.right - r.r
      r.l += dx; r.r += dx
    }
    if (c.cy && (r.t < ar.top - 1 || r.b > ar.bottom + 1)) {
      if (!c.sy) return { r, fail: 'clipped by ' + desc(c.a) + ' (y ' + rd(r.t) + '..' + rd(r.b) + ' in ' + rd(ar.top) + '..' + rd(ar.bottom) + ')' }
      const dy = (r.b - r.t > ar.height || r.t < ar.top - 1) ? ar.top - r.t : ar.bottom - r.b
      r.t += dy; r.b += dy
    }
  }
  if (r.l < -1 || r.t < -1 || r.r > W + 1 || r.b > H + 1) return { r, fail: 'off screen (x ' + rd(r.l) + '..' + rd(r.r) + ', y ' + rd(r.t) + '..' + rd(r.b) + ' in ' + W + 'x' + H + ')' }
  return { r, fail: null }
}
function bring(e, saved) {
  for (const c of clipsFrom(e.parentElement)) {
    if (!c.sx && !c.sy) continue
    if (!saved.has(c.a)) saved.set(c.a, [c.a.scrollTop, c.a.scrollLeft])
    const ar = R(c.a)
    if (c.sy) {
      let er = R(e)
      if (er.bottom > ar.bottom) c.a.scrollTop += er.bottom - ar.bottom
      er = R(e)
      if (er.top < ar.top) c.a.scrollTop -= ar.top - er.top
    }
    if (c.sx) {
      let er = R(e)
      if (er.right > ar.right) c.a.scrollLeft += er.right - ar.right
      er = R(e)
      if (er.left < ar.left) c.a.scrollLeft -= ar.left - er.left
    }
  }
}
const inside = (hit, e) => !!hit && (e.contains(hit) || (hit.closest && hit.closest('label') && hit.closest('label').control === e))
function run(e, cx, cy, dx, dy) {
  let n = 0
  for (let i = 1; i <= 50; i++) { if (!inside(document.elementFromPoint(cx + dx * i, cy + dy * i), e)) break; n = i }
  return n
}
const KEYWORDS = /\b(Esc|Escape|Enter|Return|Space|Spacebar|Backspace|Tab|Shift|Ctrl|Control|Alt|Cmd|WASD|arrow keys?|LB|RB|LT|RT|L1|R1|L2|R2|LS|RS|D-?pad|keyboard|mouse|click|hover|any key)\b|Press /i

// ---------- one pass over the screen
function measure(o) {
  W = innerWidth; H = innerHeight
  const ins = o.ins
  const fails = []
  const add = (rule, text, detail) => fails.push({ rule, text, detail })
  const saved = new Map()
  const badReach = new Set(), badSafe = new Set()
  const root = document.querySelector('.sr-ui') || document.body

  // page must not scroll under a finger
  scrollTo(0, 60); scrollTo(60, 0)
  if (scrollY > 0 || scrollX > 0 || document.scrollingElement.scrollTop > 0) add(1, 'page', 'the page itself scrolls (scrollY ' + scrollY + ', scrollX ' + scrollX + ')')
  scrollTo(0, 0)

  const taps = [...root.querySelectorAll(SEL_TAP)].filter((e) => vis(e) && getComputedStyle(e).pointerEvents !== 'none' && !e.closest('.focus-ring') && R(e).width >= 2 && R(e).height >= 2 && e.type !== 'hidden')
  for (const e of taps) {
    const text = label(e)
    const rr = reachRect(e, false)
    if (rr.fail) { badReach.add(e); add(1, text, rr.fail); continue }
    const r = rr.r
    if (r.l < ins.l - 0.5 || r.r > W - ins.r + 0.5 || r.t < ins.t - 0.5 || r.b > H - ins.b + 0.5) {
      badSafe.add(e)
      add(4, text, 'tappable x ' + rd(r.l) + '..' + rd(r.r) + ', y ' + rd(r.t) + '..' + rd(r.b) + ' vs safe x ' + ins.l + '..' + (W - ins.r) + ', y ' + ins.t + '..' + (H - ins.b))
    }
    bring(e, saved)
    const nr = R(e)
    const cx = nr.left + nr.width / 2, cy = nr.top + nr.height / 2
    if (cx < 0 || cy < 0 || cx > W || cy > H) continue
    const hit = document.elementFromPoint(cx, cy)
    if (!inside(hit, e)) { add(3, text, 'centre is covered by ' + (hit ? label(hit) : 'nothing')); continue }
    const hw = run(e, cx, cy, -1, 0) + run(e, cx, cy, 1, 0) + 1
    const hh = run(e, cx, cy, 0, -1) + run(e, cx, cy, 0, 1) + 1
    if (hw < 43.5 || hh < 43.5) add(2, text, 'hit area ' + (hw > 100 ? '100+' : hw) + 'x' + (hh > 100 ? '100+' : hh) + ' px (box ' + rd(nr.width) + 'x' + rd(nr.height) + '), need 44x44')
  }
  for (const [a, p] of saved) { a.scrollTop = p[0]; a.scrollLeft = p[1] }
  saved.clear()

  // ---------- text
  const seen = new Set()
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textOwners = new Set()
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const s = (n.nodeValue || '').replace(/\s+/g, ' ').trim()
    const p = n.parentElement
    if (!s || !p || /^(SCRIPT|STYLE|CANVAS)$/.test(p.tagName) || !vis(p)) continue
    const range = document.createRange(); range.selectNodeContents(n)
    const b = range.getBoundingClientRect()
    if (b.width < 2 || b.height < 2) continue
    textOwners.add(p)
    const key = s + '|' + Math.round(b.left) + '|' + Math.round(b.top)
    if (seen.has(key)) continue
    seen.add(key)
    const tag = '"' + s.slice(0, 40) + '"'
    const fs = parseFloat(getComputedStyle(p).fontSize)
    if (fs < 9 - 0.01) add(9, tag, 'font ' + rd(fs) + ' px, need 9 or more')
    if (KEYWORDS.test(s)) add(8, tag, 'names a key or button')
    // reach of the words
    const owner = p.closest(SEL_TAP)
    const rr = reachTextRect(p, b)
    if (rr.fail) {
      if (owner && badReach.has(owner)) continue
 add(9, tag, 'text ' + rr.fail); continue }
    const r = rr.r
    if ((r.l < ins.l - 0.5 || r.r > W - ins.r + 0.5 || r.t < ins.t - 0.5 || r.b > H - ins.b + 0.5) && !(owner && badSafe.has(owner)))
      add(4, tag, 'text x ' + rd(r.l) + '..' + rd(r.r) + ', y ' + rd(r.t) + '..' + rd(r.b) + ' vs safe x ' + ins.l + '..' + (W - ins.r) + ', y ' + ins.t + '..' + (H - ins.b))
  }
  for (const p of textOwners) {
    const cs = getComputedStyle(p)
    const hx = cs.overflowX !== 'visible' && !(cs.overflowX === 'auto' || cs.overflowX === 'scroll')
    const hy = cs.overflowY !== 'visible' && !(cs.overflowY === 'auto' || cs.overflowY === 'scroll')
    if (hx && p.scrollWidth > p.clientWidth + 1) add(9, label(p), 'text overflows its box: scrollWidth ' + p.scrollWidth + ' > clientWidth ' + p.clientWidth)
    if (hy && p.scrollHeight > p.clientHeight + 1) add(9, label(p), 'text overflows its box: scrollHeight ' + p.scrollHeight + ' > clientHeight ' + p.clientHeight)
  }
  for (const g of root.querySelectorAll('.glyph')) if (vis(g) && R(g).width > 0) add(8, 'glyph ' + (g.textContent || g.getAttribute('aria-label') || '').trim().slice(0, 20), 'a .glyph shows while touch is the device')
  for (const i of root.querySelectorAll('input[placeholder], textarea[placeholder]')) if (vis(i) && KEYWORDS.test(i.getAttribute('placeholder'))) add(8, '"' + i.getAttribute('placeholder').slice(0, 40) + '"', 'placeholder names a key')

  // ---------- HUD, and on menus the same "nothing sits on top of anything else" rule
  if (o.hud) hud(o, add)
  else menuOverlap(taps, root, add)
  vhUse(root, add)
  return fails
}
function reachTextRect(p, b) {
  const r = { l: b.left, t: b.top, r: b.right, b: b.bottom }
  for (const c of clipsFrom(p)) {
    const ar = R(c.a)
    if (c.cx && (r.l < ar.left - 1 || r.r > ar.right + 1)) {
      if (!c.sx) return { r, fail: 'clipped by ' + desc(c.a) }
      const dx = r.l < ar.left - 1 ? ar.left - r.l : ar.right - r.r; r.l += dx; r.r += dx
    }
    if (c.cy && (r.t < ar.top - 1 || r.b > ar.bottom + 1)) {
      if (!c.sy) return { r, fail: 'clipped by ' + desc(c.a) }
      const dy = r.t < ar.top - 1 ? ar.top - r.t : ar.bottom - r.b; r.t += dy; r.b += dy
    }
  }
  if (r.l < -1 || r.t < -1 || r.r > W + 1 || r.b > H + 1) return { r, fail: 'off screen (x ' + rd(r.l) + '..' + rd(r.r) + ', y ' + rd(r.t) + '..' + rd(r.b) + ')' }
  return { r, fail: null }
}

// ---------- rule 11: no layout on vh/vmin/vmax. Real Safari's 100vh is the tallest-bar height (402 at a 292 page);
// headless Chrome reports the visible height, so a vh bug can't be seen by measuring. Flag the CSS itself.
const VH = /\d\s*(vh|vmin|vmax)\b/
function vhUse(root, add) {
  const seen = new Set()
  const walk = (rules, sheetName) => {
    for (const r of rules) {
      if (r.cssRules && r.media && !matchMedia(r.media.mediaText).matches) continue
      if (r.cssRules && !r.selectorText) { walk(r.cssRules, sheetName); continue }
      if (!r.style || !r.selectorText) continue
      for (let i = 0; i < r.style.length; i++) {
        const prop = r.style[i], val = r.style.getPropertyValue(prop)
        if (!VH.test(val)) continue
        let hit = null
        try { hit = [root, ...root.querySelectorAll(r.selectorText)].find((e) => e.matches(r.selectorText) && vis(e)) } catch (_) {}
        if (!hit) continue
        const key = r.selectorText + prop
        if (seen.has(key)) continue
        seen.add(key)
        add(11, r.selectorText.slice(0, 80) + ' {' + prop + ': ' + val.slice(0, 60) + '}', 'uses vh/vmin/vmax: Safari measures it against the tallest-bar height (402 on a 292 page); use dvh or dvmin')
      }
    }
  }
  for (const sh of document.styleSheets) { try { walk(sh.cssRules, sh.href || 'inline') } catch (_) {} }
  for (const e of [root, ...root.querySelectorAll('[style]')]) if (VH.test(e.getAttribute('style') || '') && vis(e)) add(11, desc(e) + ' [style]', 'inline style uses vh/vmin/vmax: ' + e.getAttribute('style').slice(0, 80))
}

// ---------- Safari units shim (safari window only). Real Safari's 100vh was measured on the iPhone 17 Pro Simulator (iOS 27.2 Safari) at 402 on a 292 page,
// so 1vh = 1lvh = 4.02px, 1vmin = 4.02px (smaller side of 874 x 402), 1vmax = 8.74px [doc: follows from the measured 100vh and the CSS definition].
// Headless Chrome uses the visible 292, so every such unit is rewritten to px; dvh, svh, dvmin, svmin and vw already agree.
const UNIT = /(-?\d*\.?\d+)(lvh|vh|vmin|vmax)\b/g
const PX = { vh: 4.02, lvh: 4.02, vmin: 4.02, vmax: 8.74 }
const rewrite = (v) => v.replace(UNIT, (_, n, u) => Math.round(parseFloat(n) * PX[u] * 1000) / 1000 + 'px')
function shim() {
  let changed = 0
  const fix = (st) => {
    for (let i = 0; i < st.length; i++) {
      const prop = st[i], val = st.getPropertyValue(prop)
      UNIT.lastIndex = 0
      if (!UNIT.test(val)) continue
      UNIT.lastIndex = 0
      st.setProperty(prop, rewrite(val), st.getPropertyPriority(prop))
      changed++
    }
  }
  const walk = (rules) => { for (const r of rules) { if (r.style) fix(r.style); if (r.cssRules) walk(r.cssRules) } }
  for (const sh of document.styleSheets) { try { walk(sh.cssRules) } catch (_) {} }
  for (const e of document.querySelectorAll('[style]')) fix(e.style)
  return changed
}

// ---------- rule 7 on menus: tappables, panels, Back and notices never sit on one another
function visibleBox(e) {
  const b = R(e)
  const v = { l: Math.max(0, b.left), t: Math.max(0, b.top), r: Math.min(W, b.right), b: Math.min(H, b.bottom) }
  for (const c of clipsFrom(e.parentElement)) {
    const ar = R(c.a)
    if (c.cx) { v.l = Math.max(v.l, ar.left); v.r = Math.min(v.r, ar.right) }
    if (c.cy) { v.t = Math.max(v.t, ar.top); v.b = Math.min(v.b, ar.bottom) }
  }
  return v
}
function menuOverlap(taps, root, add) {
  const blocks = [...root.querySelectorAll('.panel, .touch-back, .hintbar--touch, .notice, .hud-toast')].filter((e) => vis(e) && R(e).width > 2)
  const all = [...new Set([...taps, ...blocks])].map((e) => ({ e, v: visibleBox(e) })).filter((x) => x.v.r - x.v.l > 2 && x.v.b - x.v.t > 2)
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j]
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue
    const w = Math.min(a.v.r, b.v.r) - Math.max(a.v.l, b.v.l), h = Math.min(a.v.b, b.v.b) - Math.max(a.v.t, b.v.t)
    if (w > 1.5 && h > 1.5) add(7, label(a.e) + ' / ' + label(b.e), 'sit on each other: overlap ' + rd(w) + 'x' + rd(h) + ' px')
  }
}

// ---------- rule 7: HUD panels never overlap, nothing covers the road's middle band
const HUD_SEL = [
  ['panel', '.hud-panel'], ['speed', '.hud-speed'], ['toast', '.hud-toast'], ['pop', '.hud-pop'], ['countdown', '.hud-count'],
  ['cue', '.hud-cue'], ['trap', '.hud-trap'], ['turnscard', '.hud-turnscard'], ['hint', '.hud-hint'], ['rewind', '.hud-rewind'],
  ['rewind-tag', '.hud-rewind-refused, .hud-refused'], ['fps', '.hud-fps'], ['sound', '.sound-hint'],
  ['top', '.touch-top'], ['pulse', '.touch-pulse'],
]
const HUD_ROUND = [['pedal', '.touch-pedal'], ['stick', '.touch-stick']]
function hud(o, add) {
  const items = []
  const seenEl = new Set()
  const take = (kind, sel, round) => {
    for (const e of document.querySelectorAll(sel)) {
      if (seenEl.has(e) || !e.closest('.sr-ui') || !vis(e)) continue
      const b = R(e)
      if (b.width < 2 || b.height < 2) continue
      seenEl.add(e)
      const nm = kind + ' ' + label(e).replace(/\s*\[.*$/, '').slice(0, 24) + ' [' + desc(e) + ']'
      items.push({ e, name: nm, round, l: b.left, t: b.top, r: b.right, b: b.bottom, cx: b.left + b.width / 2, cy: b.top + b.height / 2, rad: Math.min(b.width, b.height) / 2 })
    }
  }
  for (const [k, s] of HUD_SEL) take(k, s, false)
  for (const [k, s] of HUD_ROUND) take(k, s, true)
  // a container never "overlaps" what it holds, but it does overlap its neighbours: its own text (a trick score) is covered
  // by a chip even when no child of it is. Containers join the pair test; a pair where one holds the other is skipped.
  const leaf = items
  const hit = (a, b) => {
    if (a.round && b.round) return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.rad + b.rad - 0.5
    if (a.round || b.round) {
      const c = a.round ? a : b, q = a.round ? b : a
      const nx = Math.max(q.l, Math.min(c.cx, q.r)), ny = Math.max(q.t, Math.min(c.cy, q.b))
      return Math.hypot(c.cx - nx, c.cy - ny) < c.rad - 0.5
    }
    return a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
  }
  for (let i = 0; i < leaf.length; i++) for (let j = i + 1; j < leaf.length; j++) {
    if (leaf[i].e.contains(leaf[j].e) || leaf[j].e.contains(leaf[i].e)) continue
    if (hit(leaf[i], leaf[j])) add(7, leaf[i].name + ' / ' + leaf[j].name, 'overlap: ' + rd(leaf[i].l) + ',' + rd(leaf[i].t) + ',' + rd(leaf[i].r) + ',' + rd(leaf[i].b) + ' vs ' + rd(leaf[j].l) + ',' + rd(leaf[j].t) + ',' + rd(leaf[j].r) + ',' + rd(leaf[j].b))
  }
  // a panel's own content stays inside it: a row too wide for its panel pushes a score out past the edge, where the next
  // chip sits on it (sound still locked with a trick score up), and nothing above counts that text as part of the panel
  for (const p of items.filter((x) => x.e.matches('.hud-panel'))) {
    for (const d of p.e.querySelectorAll('*')) {
      if (!vis(d) || d.closest('svg') !== null && d.tagName !== 'svg') continue
      const q = R(d)
      if (q.width < 2 || q.height < 2) continue
      if (q.right > p.r + 1 || q.left < p.l - 1 || q.bottom > p.b + 1 || q.top < p.t - 1) {
        const under = items.find((o) => !o.e.contains(d) && !d.contains(o.e) && q.left < o.r - 1 && o.l < q.right - 1 && q.top < o.b - 1 && o.t < q.bottom - 1)
        add(7, p.name + ' / ' + label(d), 'spills out of its panel: ' + rd(q.left) + ',' + rd(q.top) + ',' + rd(q.right) + ',' + rd(q.bottom) + ' vs panel ' + rd(p.l) + ',' + rd(p.t) + ',' + rd(p.r) + ',' + rd(p.b) + (under ? ', and sits under ' + under.name : ''))
        break
      }
    }
  }
  // middle band: centre third wide, from the horizon (30% down) to the car's roof (51% down). Read off the 874x402 shot: horizon at 230/780, car top at 395/780 (chase camera, same in every window)
  const bx0 = W / 3, bx1 = (2 * W) / 3, by0 = H * 0.30, by1 = H * 0.51
  for (const a of items.filter((a) => !items.some((b) => b !== a && a.e.contains(b.e)))) {
    if (a.l < bx1 && a.r > bx0 && a.t < by1 && a.b > by0)
      add(7, a.name, 'covers the road band x ' + rd(bx0) + '..' + rd(bx1) + ', y ' + rd(by0) + '..' + rd(by1) + ' (box ' + rd(a.l) + ',' + rd(a.t) + ',' + rd(a.r) + ',' + rd(a.b) + ')')
  }
}

// ---------- rule 5: the primary action is on the first screen, whole
function primary(sel) {
  W = innerWidth; H = innerHeight
  const e = [...document.querySelectorAll(sel)].find((x) => vis(x))
  if (!e) return { missing: true }
  const b = R(e)
  const ins = window.__gateIns
  if (b.left < ins.l - 0.5 || b.right > W - ins.r + 0.5 || b.top < ins.t - 0.5 || b.bottom > H - ins.b + 0.5)
    return { text: label(e), detail: 'not fully visible: x ' + rd(b.left) + '..' + rd(b.right) + ', y ' + rd(b.top) + '..' + rd(b.bottom) + ' vs safe x ' + ins.l + '..' + (W - ins.r) + ', y ' + ins.t + '..' + (H - ins.b) }
  for (const c of clipsFrom(e.parentElement)) {
    const ar = R(c.a)
    if ((c.cx && (b.left < ar.left - 1 || b.right > ar.right + 1)) || (c.cy && (b.top < ar.top - 1 || b.bottom > ar.bottom + 1)))
      return { text: label(e), detail: 'sits outside ' + desc(c.a) + ' until it scrolls (y ' + rd(b.top) + '..' + rd(b.bottom) + ' in ' + rd(ar.top) + '..' + rd(ar.bottom) + ')' }
  }
  return {}
}

// ---------- scrollers, for the swipe test
let scrollers = []
function findScrollers() {
  scrollers = []
  const root = document.querySelector('.sr-ui') || document.body
  const out = []
  for (const a of root.querySelectorAll('*')) {
    if (!vis(a)) continue
    const cs = getComputedStyle(a)
    const sy = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && a.scrollHeight > a.clientHeight + 1
    const sx = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1
    if (!sy && !sx) continue
    const ar = R(a)
    if (ar.width < 4 || ar.height < 4) continue
    const axis = sy ? 'y' : 'x'
    const nearest = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { const c = getComputedStyle(n); if (axis === 'y' ? ((c.overflowY === 'auto' || c.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1) : ((c.overflowX === 'auto' || c.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1)) return n } return null }
    const cands = []
    for (const t of a.querySelectorAll(SEL_TAP)) { const b = R(t); if (vis(t) && b.width > 2 && b.height > 2) cands.push([b.left + b.width / 2, b.top + b.height / 2, t]) }
    cands.sort((p, q) => Math.abs(p[1] - (ar.top + ar.height / 2)) - Math.abs(q[1] - (ar.top + ar.height / 2)))
    for (let gx = 1; gx <= 5; gx++) for (let gy = 1; gy <= 5; gy++) cands.push([ar.left + (ar.width * gx) / 6, ar.top + (ar.height * gy) / 6, null])
    let pick = null
    for (const c of cands) {
      const px = Math.max(1, Math.min(W - 1, c[0])), py = Math.max(1, Math.min(H - 1, c[1]))
      const h = document.elementFromPoint(px, py)
      if (h && nearest(h) === a && (axis === 'x' ? true : py > ar.top + 12 && py < ar.bottom - 12)) { pick = [px, py, c[2] ? label(c[2]) : 'empty space']; break }
    }
    const idx = scrollers.push(a) - 1
    const max = axis === 'y' ? a.scrollHeight - a.clientHeight : a.scrollWidth - a.clientWidth
    const pos = axis === 'y' ? a.scrollTop : a.scrollLeft
    out.push({ idx, axis, name: desc(a), x: pick ? pick[0] : null, y: pick ? pick[1] : null, on: pick ? pick[2] : null, forward: pos < max - 1, w: ar.width, h: ar.height })
  }
  return out
}
const pos = (i) => [scrollers[i].scrollTop, scrollers[i].scrollLeft]
const setPos = (i, p) => { scrollers[i].scrollTop = p[0]; scrollers[i].scrollLeft = p[1] }
function state() {
  const host = document.querySelector('.screen-host') || document.body
  const g = window.__game.get('ui')
  return JSON.stringify({
    stack: g.stack, tab: g.settingsTab, mode: g.pendingMode,
    vals: [...host.querySelectorAll('.row__value, input, .toggle, [aria-checked], .tab')].map((e) => (typeof e.className === 'string' ? e.className.replace(/is-focused/g, '') : '') + '|' + (e.value ?? '') + '|' + (e.getAttribute('aria-checked') ?? '') + '|' + (e.tagName === 'INPUT' ? '' : (e.textContent || '').slice(0, 20))),
  })
}
window.__clicks = []
document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.sr-ui')) window.__clicks.push(performance.now()) }, true)
const accepts = (t0) => window.__clicks.filter((t) => t >= t0).length
window.__gate = { shim, measure, primary, findScrollers, pos, setPos, state, accepts }
})()`

// ---------------------------------------------------------------- break injections (--break <rule>)
const BREAKS: Record<number, string> = {
  // scrollers stop scrolling, so what overflows is clipped for good
  1: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui .screen-host *{overflow:hidden !important}.sr-ui .screen-host{height:60% !important}'})()`,
  // every button shrinks to 40%
  2: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui button,.sr-ui [data-nav],.sr-ui [role=tab],.sr-ui .touch-top,.sr-ui .touch-pedal{transform:scale(.4) !important}'})()`,
  // a see-through sheet over the middle of the screen
  3: `(()=>{if(document.getElementById('gate-cover'))return;const d=document.createElement('div');d.id='gate-cover';d.style.cssText='position:fixed;left:25%;top:10%;width:50%;height:80%;z-index:2147483000;background:transparent;pointer-events:auto';document.body.append(d)})()`,
  // everything slides 40 px left, into the notch
  4: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui .screen-host>*,.sr-ui .hud,.sr-ui .touch{transform:translate(-40px,0) !important}'})()`,
  // the primary action drops off the first screen
  5: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='[data-nav="play"],[data-nav="resume"],.mode-list>:first-child,.track-card:first-child{position:relative;top:400px}'})()`,
  // every click lands twice, and a touch-scroll presses its row
  6: `(()=>{if(window.__gateBreak6)return;window.__gateBreak6=1;document.addEventListener('click',(e)=>{if(e.__d)return;const c=new MouseEvent('click',{bubbles:true,cancelable:true});c.__d=1;e.target.dispatchEvent(c)},true);document.addEventListener('pointermove',(e)=>{if(e.pointerType==='touch'&&!window.__gateMv){window.__gateMv=1;e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));setTimeout(()=>{window.__gateMv=0},400)}},true)})()`,
  // panels (and on menus, the Back button) pile onto the middle of the screen
  7: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui .hud-panel,.sr-ui .hud-speed{position:fixed !important;left:40% !important;top:45% !important;right:auto !important;bottom:auto !important .sr-ui .touch-back{position:fixed !important;left:30% !important;top:40% !important}'})()`,
  // a key glyph and "Press Enter" appear
  8: `(()=>{if(document.getElementById('gate-words'))return;const d=document.createElement('div');d.id='gate-words';d.style.cssText='position:fixed;left:30%;top:2%;z-index:99999;color:#fff;pointer-events:none';d.innerHTML='<span class="glyph glyph--key">Esc</span> Press Enter to go';(document.querySelector('.sr-ui')||document.body).append(d)})()`,
  // words shrink to 7 px and one label is cut off
  9: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui .eyebrow,.sr-ui .hud-label,.sr-ui .hint__label{font-size:7px !important}.sr-ui .menu-btn,.sr-ui .screen-title,.sr-ui .hud-speed__num{display:inline-block;width:1.2em !important;overflow:hidden !important;white-space:nowrap !important}'})()`,
  // touch shows up on the desktop
  // a panel 80vh tall: fits when vh is the visible height (pwa), too tall once vh is Safari's tallest-bar height (safari)
  11: `(()=>{let s=document.getElementById('gate-break');if(!s){s=document.createElement('style');s.id='gate-break';document.head.append(s)}s.textContent='.sr-ui[data-touch] .pause-panel,.sr-ui[data-touch] .settings-panel{height:80vh !important;max-height:none !important}'})()`,
  10: `(()=>{const r=document.querySelector('.sr-ui');if(!r)return;r.setAttribute('data-touch','1');if(!document.getElementById('gate-touch')){const d=document.createElement('div');d.id='gate-touch';d.className='touch';r.append(d)}})()`,
}

// ---------------------------------------------------------------- steps
interface Ctx {
  page: any
  cdp: any
  win: Win
  wname: string
  fail: (rule: number, text: string, detail: string) => void
}
interface Step {
  name: string
  hud?: boolean
  mode?: string
  /** Boot with the game's music on (no nomusic=1), so the sound chip and the song panel can show */
  music?: boolean
  /** This step gets a page of its own. Steps with the same mode and music otherwise share one, so a tap in one carries into the next */
  ownPage?: boolean
  primary?: string
  setup: (c: Ctx) => Promise<void>
  extra?: (c: Ctx) => Promise<void>
  /** Only these windows (default: all) */
  only?: string[]
}

const call = (c: Ctx, expr: string) => c.page.evaluate(expr)
const ui = (c: Ctx, s: string, a?: string) => c.page.evaluate((s: string, a?: string) => (window as any).__dev.ui(s, a), s, a)
const uiState = (c: Ctx) => c.page.evaluate(() => (window as any).__game.get('ui'))
const demo = (c: Ctx, scene: string) => c.page.evaluate((s: string) => (window as any).__dev.uiHudDemo(s), scene)

async function toHud(c: Ctx) {
  await ui(c, 'hud')
  await c.page.waitForFunction(() => !!document.querySelector('.hud.is-visible'), { timeout: 30000 }).catch(() => {})
  await sleep(500)
}
async function tapAt(c: Ctx, x: number, y: number) {
  const t = (type: string, pts: any[]) => c.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
  await t('touchStart', [{ x, y, id: 1 }])
  await sleep(60)
  await t('touchEnd', [])
  await sleep(350)
}
async function tapSel(c: Ctx, sel: string): Promise<boolean> {
  const p = await c.page.evaluate((s: string) => {
    const e = [...document.querySelectorAll(s)].find((x) => (x as any).checkVisibility?.()) as HTMLElement | undefined
    if (!e) return null
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const r = e.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, sel)
  if (!p) return false
  await tapAt(c, p.x, p.y)
  return true
}

const SETTINGS_TABS = ['car', 'handling', 'camera', 'audio', 'world', 'racing', 'track', 'graphics', 'fun', 'multiplayer']

const STEPS: Step[] = [
  {
    name: 'title',
    primary: '[data-nav="play"]',
    setup: async (c) => void (await ui(c, 'title')),
    extra: async (c) => {
      await ui(c, 'title')
      await sleep(600)
      const t0 = await c.page.evaluate(() => performance.now())
      if (!(await tapSel(c, '[data-nav="play"]'))) return c.fail(6, 'Play', 'not found to tap')
      const s = await uiState(c)
      const n = await c.page.evaluate((t: number) => (window as any).__gate.accepts(t), t0)
      if (s.screen !== 'mode') c.fail(6, 'Play', `a tap did not open the mode screen (screen is ${s.screen})`)
      else if (n !== 1) c.fail(6, 'Play', `one tap acted ${n} times`)
    },
  },
  {
    name: 'mode',
    primary: '.mode-list [data-nav]',
    setup: async (c) => void (await ui(c, 'mode')),
    extra: async (c) => {
      await ui(c, 'mode')
      await sleep(600)
      const t0 = await c.page.evaluate(() => performance.now())
      if (!(await tapSel(c, '.mode-list [data-nav]'))) return c.fail(6, 'first mode row', 'not found to tap')
      const s = await uiState(c)
      const n = await c.page.evaluate((t: number) => (window as any).__gate.accepts(t), t0)
      if (s.screen !== 'track') c.fail(6, 'first mode row', `a tap did not open the track screen (screen is ${s.screen})`)
      else if (n !== 1) c.fail(6, 'first mode row', `one tap acted ${n} times`)
    },
  },
  { name: 'track', primary: '.track-card', setup: async (c) => void (await ui(c, 'track')) },
  { name: 'garage', setup: async (c) => void (await ui(c, 'garage')) },
  ...SETTINGS_TABS.map(
    (tab): Step => ({
      name: `settings:${tab}`,
      setup: async (c) => void (await ui(c, 'settings', tab)),
      extra:
        tab === 'graphics'
          ? async (c) => {
              await ui(c, 'settings', 'graphics')
              await sleep(600)
              // a tap on a toggle row flips it exactly once
              const read = () => c.page.evaluate(() => [...document.querySelectorAll('.row--toggle .toggle')].map((e) => e.classList.contains('is-on')))
              const before = await read()
              if (!before.length) return c.fail(6, 'toggle', 'no toggle row on the graphics tab to tap')
              const t0 = await c.page.evaluate(() => performance.now())
              await tapSel(c, '.row--toggle')
              const after = await read()
              const n = await c.page.evaluate((t: number) => (window as any).__gate.accepts(t), t0)
              if (after[0] === before[0]) c.fail(6, 'toggle row', `a tap flipped it ${n === 0 ? 'no' : 'an even number of'} times (acted ${n})`)
              else if (n !== 1) c.fail(6, 'toggle row', `one tap acted ${n} times`)
              if (after[0] !== before[0]) await tapSel(c, '.row--toggle') // put it back
              // a tap on another tab opens it
              const tab0 = (await uiState(c)).settingsTab
              await c.page.evaluate(() => (document.querySelectorAll('[role=tab]')[2] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest', inline: 'center' }))
              const p = await c.page.evaluate(() => {
                const e = document.querySelectorAll('[role=tab]')[2]
                if (!e) return null
                const r = e.getBoundingClientRect()
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
              })
              if (!p) return c.fail(6, 'tab', 'no tabs found to tap')
              await tapAt(c, p.x, p.y)
              const tab1 = (await uiState(c)).settingsTab
              if (tab1 === tab0) c.fail(6, 'third tab', `a tap did not switch the tab (still ${tab0})`)
            }
          : undefined,
    }),
  ),
  { name: 'report', setup: async (c) => void (await ui(c, 'report')) },
  {
    name: 'pause',
    primary: '[data-nav="resume"]',
    setup: async (c) => {
      await toHud(c)
      await ui(c, 'pause')
    },
    extra: async (c) => {
      await toHud(c)
      await ui(c, 'pause')
      await sleep(600)
      const t0 = await c.page.evaluate(() => performance.now())
      if (!(await tapSel(c, '[data-nav="resume"]'))) return c.fail(6, 'Resume', 'not found to tap')
      await sleep(400)
      const s = await uiState(c)
      const n = await c.page.evaluate((t: number) => (window as any).__gate.accepts(t), t0)
      if (s.stack.length) c.fail(6, 'Resume', `a tap did not return to the road (stack ${s.stack})`)
      else if (n !== 1) c.fail(6, 'Resume', `one tap acted ${n} times`)
    },
  },
  ...(['free', 'race', 'stunt', 'hunt', 'tag', 'turns', 'countdown', 'tricks', 'toasts', 'trap'] as const).map(
    (scene): Step => ({
      name: `hud-${scene}`,
      hud: true,
      setup: async (c) => {
        await toHud(c)
        await demo(c, 'clear')
        // toasts and pops from the last scene fade first, so each state is measured on its own
        await c.page.waitForFunction(() => ![...document.querySelectorAll('.hud-toast,.hud-pop,.hud-turnscard,.hud-count,.hud-trap,.hud-cue')].some((e) => (e as any).checkVisibility?.({ checkOpacity: true }) && e.getBoundingClientRect().width > 0), { timeout: 12000 }).catch(() => {})
        if (scene !== 'free') await demo(c, scene)
        await sleep(scene === 'tricks' ? 350 : 500)
      },
    }),
  ),
  {
    name: 'results',
    setup: async (c) => {
      await toHud(c)
      await demo(c, 'clear')
      await ui(c, 'results')
    },
  },
  {
    name: 'favourite-songs',
    setup: async (c) => {
      await toHud(c)
      await ui(c, 'pause')
      await sleep(600)
      if (!(await tapSel(c, '[data-nav="fav-songs"]'))) c.fail(1, 'Favourite songs', 'no button to open the list from the pause menu')
    },
  },
  {
    name: 'map',
    setup: async (c) => {
      await toHud(c)
      await ui(c, 'pause')
      await sleep(600)
      if (!(await tapSel(c, '[data-nav="map"]'))) c.fail(1, 'Map', 'no button to open the map from the pause menu')
      await sleep(1500)
    },
  },
  {
    // music on: the "Tap for sound" chip shows until the first touch
    name: 'hud-sound-chip',
    hud: true,
    music: true,
    setup: async (c) => {
      await toHud(c)
      await c.page.waitForFunction(() => [...document.querySelectorAll('.sound-hint')].some((e) => (e as any).checkVisibility?.({ checkOpacity: true })), { timeout: 8000 }).catch(() => c.fail(7, 'sound chip', 'the sound chip never showed with music on'))
    },
  },
  {
    // after a touch unlocks sound, the song's name panel slides in
    name: 'hud-song',
    hud: true,
    music: true,
    // its tap unlocks sound for good, and the steps below need sound still locked; and it needs a song that has only just started
    ownPage: true,
    setup: async (c) => {
      await toHud(c)
      await tapAt(c, c.win.w / 2, c.win.h * 0.3)
      // the panel only stays up a few seconds: catch it the moment it shows, then measure
      await c.page.waitForFunction(() => [...document.querySelectorAll('.hud-song')].some((e) => (e as any).checkVisibility?.({ checkOpacity: true }) && e.getBoundingClientRect().width > 0), { timeout: 15000, polling: 100 }).catch(() => c.fail(7, 'song panel', 'the song panel never showed with music on'))
    },
  },
  // sound still locked with a trick score up: the chip shares the top row with the cores, Tricks and mode panels.
  // Each mode panel that can sit in that row is shown with the trick score, so the row is measured full.
  ...([['tricks', []], ['hunt', ['hunt']], ['stunt', ['stunt']], ['race', ['race']], ['tag', ['tag']], ['turns', ['turns']]] as [string, string[]][]).map(
    ([name, first]): Step => ({
      name: `hud-sound-${name}`,
      hud: true,
      music: true,
      setup: async (c) => {
        await toHud(c)
        await c.page.waitForFunction(() => [...document.querySelectorAll('.sound-hint')].some((e) => (e as any).checkVisibility?.({ checkOpacity: true })), { timeout: 8000 }).catch(() => c.fail(7, 'sound chip', 'the sound chip never showed with music on'))
        // the first panel's own toasts and countdown fade before the trick score goes up: each state is measured on its own
        for (const scene of first) {
          await demo(c, scene)
          await c.page.waitForFunction(() => ![...document.querySelectorAll('.hud-toast,.hud-turnscard,.hud-count,.hud-trap,.hud-cue')].some((e) => (e as any).checkVisibility?.({ checkOpacity: true }) && e.getBoundingClientRect().width > 0), { timeout: 12000 }).catch(() => {})
        }
        await demo(c, 'tricks')
        await sleep(350)
      },
    }),
  ),
  { name: 'hud-timetrial', hud: true, mode: 'timetrial', setup: async (c) => void (await toHud(c)) },
]

// A page.evaluate'd function is serialised by its source, so the shapes above stay plain.
const wanted = (name: string) => !ONLY.length || ONLY.some((o) => name === o || name.startsWith(o + ':') || name.startsWith(o + '-'))

// ---------------------------------------------------------------- run
if (argv.includes('--list')) {
  console.log(STEPS.map((s) => s.name).join('\n'))
  process.exit(0)
}
mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required', '--window-size=2000,1200'],
})
const failures: { win: string; screen: string; rule: number; text: string; detail: string }[] = []
const seenKeys = new Set<string>()
const infos: { win: string; text: string }[] = []
let current = ''

async function boot(wname: string, win: Win, mode: string, music = false): Promise<Ctx> {
  const page = await browser.newPage()
  page.on('pageerror', (e: Error) => console.error(`PAGEERROR ${wname}: ${e.message}`))
  if (win.touch) await page.setUserAgent(UA)
  await page.setViewport({ width: win.w, height: win.h, deviceScaleFactor: win.touch ? 2 : 1, isMobile: win.touch, hasTouch: win.touch })
  // Headless Chrome never locks sound, a real phone does until the first touch. For the music steps, lock it the same way:
  // the context starts suspended and only a touch (pointerdown) lets resume() through.
  if (music)
    await page.evaluateOnNewDocument(() => {
      const A = (window as any).AudioContext
      ;(window as any).AudioContext = class extends A {
        constructor(...a: any[]) {
          super(...a)
          this.suspend()
        }
        resume() {
          return (window as any).__gateUnlocked ? super.resume() : Promise.resolve()
        }
      }
      document.addEventListener('pointerdown', () => ((window as any).__gateUnlocked = true), true)
    })
  const cdp = await page.createCDPSession()
  if (win.touch) await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: win.ins.t, left: win.ins.l, bottom: win.ins.b, right: win.ins.r } })
  const ctx: Ctx = { page, cdp, win, wname, fail: (rule, text, detail) => record(wname, current, rule, text, detail) }
  await page.goto(`http://localhost:${PORT}/?${win.touch ? 'touch=1&' : ''}${music ? '' : 'nomusic=1&'}quality=low&track=afterglow&mode=${mode}`, { waitUntil: 'load' })
  await page.waitForFunction(() => !!(window as any).__dev?.ui && !!(window as any).__game?.get, { timeout: 60000 })
  await sleep(1500)
  await page.evaluate(PAGE)
  await page.evaluate((i: Insets) => ((window as any).__gateIns = i), win.ins)
  // the window and the notch really are what we asked for
  const real = await page.evaluate(() => {
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.append(d)
    const c = getComputedStyle(d)
    const v = [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].map(parseFloat)
    d.remove()
    return { w: innerWidth, h: innerHeight, env: v }
  })
  if (real.w !== win.w || real.h !== win.h) throw new Error(`${wname}: window is ${real.w}x${real.h}, wanted ${win.w}x${win.h}`)
  const want = [win.ins.t, win.ins.r, win.ins.b, win.ins.l]
  if (win.touch && real.env.some((v: number, i: number) => Math.abs(v - want[i]) > 0.5)) throw new Error(`${wname}: safe-area insets did not take effect: env() gave ${real.env} (top,right,bottom,left), wanted ${want}`)
  return ctx
}

function record(win: string, screen: string, rule: number, text: string, detail: string) {
  // the same control or font on every HUD state is one finding, not eleven
  if (rule === 11) {
    // informational only: the Safari shim measures what vh really does, so the source list is not a failure
    const k = `${win}|${rule}|${text}`
    if (!seenKeys.has(k)) {
      seenKeys.add(k)
      infos.push({ win, text })
    }
    return
  }
  if (screen.startsWith('hud-') && rule !== 7 && ((rule === 9 && detail.startsWith('font')) || /\[(button|div)\.touch-/.test(text))) screen = 'hud'
  const ex = EXCEPTIONS.find((e) => e.rule === rule && (screen === e.screen || screen.startsWith(e.screen)) && e.text.test(text) && (!e.detail || e.detail.test(detail)))
  if (ex) return
  const key = `${win}|${screen}|${rule}|${text}`
  if (seenKeys.has(key)) return
  seenKeys.add(key)
  failures.push({ win, screen, rule, text, detail })
}

async function swipeAll(c: Ctx, screen: string) {
  const list: any[] = await c.page.evaluate(() => (window as any).__gate.findScrollers())
  for (const s of list) {
    const tag = `${s.name} (${s.axis === 'y' ? 'up/down' : 'left/right'})`
    if (s.x === null) {
      c.fail(1, tag, 'no point inside this scroller that a finger can start a swipe on (something else takes the touch)')
      continue
    }
    const p0 = await c.page.evaluate((i: number) => (window as any).__gate.pos(i), s.idx)
    const st0 = await c.page.evaluate(() => (window as any).__gate.state())
    const t0 = await c.page.evaluate(() => performance.now())
    const d = Math.min(90, (s.axis === 'y' ? s.h : s.w) * 0.4) * (s.forward ? -1 : 1)
    const x2 = s.axis === 'x' ? s.x + d : s.x
    const y2 = s.axis === 'y' ? s.y + d : s.y
    const tt = (type: string, pts: any[]) => c.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
    await tt('touchStart', [{ x: s.x, y: s.y, id: 1 }])
    for (let i = 1; i <= 8; i++) {
      await sleep(16)
      await tt('touchMove', [{ x: s.x + ((x2 - s.x) * i) / 8, y: s.y + ((y2 - s.y) * i) / 8, id: 1 }])
    }
    await tt('touchEnd', [])
    await sleep(500)
    const p1 = await c.page.evaluate((i: number) => (window as any).__gate.pos(i), s.idx)
    const st1 = await c.page.evaluate(() => (window as any).__gate.state())
    const acts = await c.page.evaluate((t: number) => (window as any).__gate.accepts(t), t0)
    const pg = await c.page.evaluate(() => ({ y: scrollY, x: scrollX, d: document.scrollingElement!.scrollTop }))
    const moved = Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1])
    if (moved < 4) c.fail(1, tag, `a swipe starting on "${s.on}" did not scroll it (moved ${moved} px)`)
    if (pg.y || pg.x || pg.d) c.fail(1, tag, `the page itself scrolled (scrollY ${pg.y})`)
    if (acts || st0 !== st1) c.fail(6, `${tag} on "${s.on}"`, `a swipe that starts on a row pressed something (${acts} presses, state ${st0 === st1 ? 'same' : 'changed'})`)
    await c.page.evaluate((i: number, p: number[]) => (window as any).__gate.setPos(i, p), s.idx, p0)
    await c.page.evaluate(() => scrollTo(0, 0))
    await sleep(100)
  }
}

for (const wname of WINDOWS) {
  const win = WINS[wname]
  if (!win) {
    console.error(`unknown window ${wname}`)
    process.exit(2)
  }
  let ctx: Ctx | null = null
  let ctxMode = ''
  try {
    const steps = STEPS.filter((s) => wanted(s.name)).filter((s) => (wname === 'desktop' ? ['title', 'pause', 'hud-free'].includes(s.name) : true))
    for (const step of steps) {
      current = step.name
      const mode = step.mode ?? 'free'
      const key = mode + (step.music ? '+music' : '') + (step.ownPage ? `+${step.name}` : '')
      if (!ctx || ctxMode !== key) {
        await ctx?.page.close()
        ctx = await boot(wname, win, mode, !!step.music)
        ctxMode = key
      }
      const c = ctx
      try {
        await step.setup(c)
        await sleep(step.hud ? 200 : 700)
        const now = await uiState(c)
        if (!step.hud && step.name !== 'map' && step.name !== 'favourite-songs' && now.screen !== step.name.split(':')[0] && !(step.name === 'favourite-songs')) {
          c.fail(1, step.name, `screen did not open (screen is ${now.screen})`)
        }
        if (BREAK && BREAKS[BREAK]) {
          await c.page.evaluate(BREAKS[BREAK])
          await sleep(200)
        }
        if (wname === 'safari') {
          await c.page.evaluate(() => (window as any).__gate.shim())
          await sleep(250)
          await c.page.evaluate(() => (window as any).__gate.shim())
        }
        await c.page.screenshot({ path: `${OUT}/${wname}-${step.name.replace(':', '-')}.png` })
        if (wname === 'desktop') {
          const d = await c.page.evaluate(() => ({
            touchAttr: !!document.querySelector('.sr-ui[data-touch]'),
            touchEl: !!document.querySelector('.touch'),
            hint: [...document.querySelectorAll('.hintbar')].some((e) => (e as any).checkVisibility?.() && e.getBoundingClientRect().width > 0),
          }))
          if (d.touchAttr) c.fail(10, 'data-touch', 'a desktop page carries data-touch')
          if (d.touchEl) c.fail(10, '.touch', 'a desktop page has a .touch element')
          if (step.name === 'title' && !d.hint) c.fail(10, 'hint bar', 'the desktop title has no visible hint bar')
          continue
        }
        const fails: { rule: number; text: string; detail: string }[] = await c.page.evaluate((o: any) => (window as any).__gate.measure(o), { ins: win.ins, hud: !!step.hud })
        for (const f of fails) if (win.rules.includes(f.rule)) c.fail(f.rule, f.text, f.detail)
        if (!step.hud && win.rules.includes(5) && step.primary) {
          const p = await c.page.evaluate((s: string) => (window as any).__gate.primary(s), step.primary)
          if (p.missing) c.fail(5, step.primary, 'primary action not found')
          else if (p.detail) c.fail(5, p.text, p.detail)
        }
        if (!step.hud && step.name !== 'map') await swipeAll(c, step.name)
        if (win.rules.includes(6) && step.extra) await step.extra(c)
      } catch (e: any) {
        c.fail(1, 'SETUP', `${step.name}: ${e.message}`)
      }
    }
  } catch (e: any) {
    record(wname, current || 'boot', 1, 'SETUP', e.message)
  } finally {
    await ctx?.page.close().catch(() => {})
  }
}
await browser.close()

// windows were asked for rules; filter portrait to reach only, desktop to guard only
const shown = failures.filter((f) => f.text === 'SETUP' || (f.rule !== 11 && WINS[f.win].rules.includes(f.rule)))
shown.sort((a, b) => a.screen.localeCompare(b.screen) || a.win.localeCompare(b.win) || a.rule - b.rule)
for (const f of shown) console.log(`FAIL ${f.win} ${f.screen} R${f.rule} ${RULE_NAME[f.rule]} ${f.text.startsWith('"') ? f.text : `"${f.text}"`} ${f.detail}`)
for (const i of infos) console.log(`INFO ${i.win} css vh-units ${i.text}`)
console.log(shown.length ? `\n${shown.length} FAILED` : '\nALL PASS')
process.exit(shown.length ? 1 : 0)
