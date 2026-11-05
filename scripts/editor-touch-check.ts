// ============================================================
//  EDITOR TOUCH CHECK - real fingers on the Road Editor's map
// ------------------------------------------------------------
//  Opens a production preview in a phone-shaped headless Chrome,
//  notch insets on, and proves the gesture layer (src/editor/
//  mapGestures.ts) with several fingers at once through CDP touch
//  events. Every scenario asserts on the editor's real state (the
//  view, the Undo count, the road), never on "nothing threw". The
//  layout's panels are hidden from the fingers, because this checks
//  the map's gestures; scenario 10 uses the real tool button and tray
//  (layout C), 9 a real mouse at 1920x1080, 12 both; 24 opens from the
//  title and really loses the WebGL context under real presses; 25 reads every
//  word the editor shows on a phone (and, on a computer, that none changed).
//
//    bunx vite build --outDir /tmp/x && bunx vite preview --outDir /tmp/x --port 5212 --strictPort
//    bun run editor:touch -- --port 5212 [--window pwa,safari] [--only 1,2,3] [--out /tmp/sr2/editor-touch]
//
//  Exits 1 on any failure. The last lines say which scenarios went red.
//  Never take a screenshot mid-gesture: puppeteer's capture resizes the page for a moment,
//  and a line being drawn picks up a wild point.
// ============================================================

import puppeteer, { type CDPSession, type Page } from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { findChrome } from './chrome'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const port = arg('port', '5212')
const OUT = arg('out', '/tmp/sr2/editor-touch')
const only = arg('only', '').split(',').filter(Boolean)
const windowNames = arg('window', 'pwa,safari').split(',')
/** Scenario 25 on a computer writes every line it saw here (JSON), to diff one build against another. */
const dumpTo = arg('dump', '')
mkdirSync(OUT, { recursive: true })

const WINDOWS: Record<string, { w: number; h: number; insets: { top: number; left: number; bottom: number; right: number } }> = {
  pwa: { w: 874, h: 402, insets: { top: 0, left: 62, bottom: 20, right: 62 } },
  safari: { w: 874, h: 292, insets: { top: 0, left: 62, bottom: 20, right: 62 } },
}
const TOOLS = ['select', 'pencil', 'straight', 'curve', 'bend', 'bank', 'height', 'width', 'place'] as const
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
/** The spot between the fingers stays under them to within this, pixels. */
const SPOT_PX = 2
/** The view follows two fingers dragged to within this, pixels. */
const DRAG_PX = 1.5
/** A line through the gesture layer matches the same line through the mouse (or without a second finger) to within this, pixels. */
const LINE_PX = 2
/** How long the check waits between landing two fingers, ms. Each check prints the gap the page measured. */
const LAND_MS = [20, 30, 40]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Spot = { x: number; y: number }
type Finger = Spot & { id: number }

let fails = 0
let scenario = ''
let windowName = ''
const red = new Set<string>()
const ok = (cond: boolean, what: string, detail?: unknown) => {
  const extra = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${cond ? 'PASS' : 'FAIL'} [${windowName}] ${scenario}: ${what}${extra}`)
  if (!cond) {
    fails++
    red.add(scenario.split(' ')[0])
  }
}
const close = (a: number, b: number, within: number) => Math.abs(a - b) <= within
type World = { x: number; z: number }
/** How far the worst point of `line` is from the line `to` (not from its points: they are a few pixels apart), metres. */
const worstOff = (line: readonly World[], to: readonly World[]) =>
  Math.max(
    ...line.map((q) => {
      let best = Infinity
      for (let i = 0; i + 1 < to.length; i++) {
        const [a, b] = [to[i], to[i + 1]]
        const vx = b.x - a.x
        const vz = b.z - a.z
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / (vx * vx + vz * vz || 1)))
        best = Math.min(best, Math.hypot(q.x - (a.x + vx * t), q.z - (a.z + vz * t)))
      }
      return best
    }),
  )
const round = (v: number, k = 100) => Math.round(v * k) / k

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'],
})

/** One page, and everything a scenario asks of it. */
class Phone {
  constructor(
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly w: number,
    readonly h: number,
  ) {}
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ed = (cmd: string, a?: unknown) => this.page.evaluate((c: string, x: unknown) => (window as any).__dev.editor(c, x), cmd, a as never)
  look = (cmd: string, a?: unknown) => this.page.evaluate((c: string, x: unknown) => (window as any).__dev.look3d(c, x), cmd, a as never)
  sum = () => this.page.evaluate(() => (window as any).__game.get('editor'))
  g = () => this.page.evaluate(() => (window as any).__game.get('editorGesture'))
  /* eslint-enable @typescript-eslint/no-explicit-any */
  /** The whole draft: any change at all to the road or what is on it shows here. */
  road = async () => JSON.stringify(await this.ed('file'))
  roadPoints = async () => ((await this.ed('file')) as { road: { points: { x: number; z: number }[] } }).road.points
  // CDP's fingers: touchStart names the fingers already down (where they are) and the new one; touchMove names those that
  // moved (a finger left out just stays put); touchEnd lifts the fingers it names, or every finger if it names none.
  private send = (type: string, pts: Finger[]) => this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts } as never)
  down = (...pts: Finger[]) => this.send('touchStart', pts)
  move = (...pts: Finger[]) => this.send('touchMove', pts)
  lift = () => this.send('touchEnd', [])
  liftOne = (f: Finger) => this.send('touchEnd', [f])
  cancel = () => this.send('touchCancel', [])
  async tap(s: Spot, holdMs = 40) {
    await this.down({ ...s, id: 1 })
    await sleep(holdMs)
    await this.lift()
    await sleep(60)
  }
  /** One finger along a path. */
  async drag(path: Spot[], stepMs = 12) {
    await this.down({ ...path[0], id: 1 })
    await sleep(stepMs)
    for (const p of path.slice(1)) {
      await this.move({ ...p, id: 1 })
      await sleep(stepMs)
    }
    await this.lift()
    await sleep(80)
  }
  /** Is the spot really on the map (the panels are hidden from the fingers)? */
  onMap = (s: Spot) => this.page.evaluate((x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains('sre-overlay') ?? false, s.x, s.y)
  /** The road spot nearest a spot on screen. */
  async roadNear(x: number, y: number): Promise<Spot & { at: number }> {
    const n = (await this.sum()).points
    let best: Spot & { at: number } = { x, y, at: 0 }
    let bestD = Infinity
    for (let i = 0; i < n * 4; i++) {
      const at = i / 4
      const s = (await this.ed('screen', at)) as { sx: number; sy: number }
      const d = Math.hypot(s.sx - x, s.sy - y)
      if (d < bestD) {
        bestD = d
        best = { x: s.sx, y: s.sy, at }
      }
    }
    return best
  }
  async hidePanels(hide: boolean) {
    await this.page.evaluate((on: boolean) => {
      document.getElementById('check-hide')?.remove()
      if (!on) return
      const style = document.createElement('style')
      style.id = 'check-hide'
      style.textContent = '.sre > :not(.sre-overlay), .sre > :not(.sre-overlay) * { pointer-events: none !important; } .sre > :not(.sre-overlay) { opacity: 0 !important; }'
      document.head.append(style)
    }, hide)
  }
  /** A road to work on, framed, with every tool's last state gone. The same road whatever ran before: the dice keep the world they find. */
  async freshRoad() {
    if ((await this.sum()).baseWorld !== 'neon-valley') {
      await this.ed('newTrackNow', 'neon-valley')
      await sleep(800)
    }
    await this.ed('random', 7)
    await sleep(1500)
    await this.ed('fit')
    await this.ed('tool', 'select')
    await sleep(100)
  }
  async undoTo(steps: number) {
    for (let i = 0; i < 60 && (await this.sum()).undoSteps > steps; i++) await this.ed('undo')
    await sleep(150)
  }
}

/**
 * Runs in the page before it loads (scenario 25): remembers every piece of text that ever enters the page, and what it went
 * into. Text that is on screen for a moment (a status line, a hint under a finger) is gone by the time a check looks, so a
 * check that only reads the screen would miss it.
 */
function watchWords() {
  const seen = new Map<string, string>()
  ;(window as unknown as { __wordsSeen: Map<string, string> }).__wordsSeen = seen
  const note = (el: Element | null, raw: string | null) => {
    const t = (raw ?? '').replace(/\s+/g, ' ').trim()
    if (t && t.length < 2000 && !seen.has(t)) seen.set(t, el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` : '')
  }
  const take = (n: Node) => {
    if (n.nodeType === 3) note(n.parentElement, n.nodeValue)
    else if (n.nodeType === 1) {
      const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT)
      for (let x = w.nextNode(); x; x = w.nextNode()) note(x.parentElement, x.nodeValue)
    }
  }
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') take(m.target)
      else m.addedNodes.forEach(take)
    }
  }).observe(document, { subtree: true, childList: true, characterData: true })
}

/** A step that crashes the game on purpose: the error reaches the page's error event even though the boundary catches it. */
let crashOnPurpose = false

async function openPhone(name: string, query: string, ready = '[data-testid=editor-ui], .touch'): Promise<Phone> {
  const { w, h, insets } = WINDOWS[name]
  const page = await browser.newPage()
  await page.bringToFront()
  page.on('pageerror', (e) => {
    if (!crashOnPurpose) ok(false, 'page error', String((e as Error).stack ?? (e as Error).message).slice(0, 600))
  })
  await page.setUserAgent(UA)
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets } as never)
  // Each window starts on an empty map, not on whatever the last one left in the working copy. Only its first load
  // forgets it: a reload further on is there to see it kept (scenario 24).
  await page.evaluateOnNewDocument(watchWords)
  await page.evaluateOnNewDocument(() => {
    if (sessionStorage.getItem('check-fresh')) return
    sessionStorage.setItem('check-fresh', '1')
    localStorage.removeItem('sr2.editor.working.v1')
  })
  await page.goto(`http://localhost:${port}/?${query}`, { waitUntil: 'load' })
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate((s: string) => !!document.querySelector(s), ready).catch(() => false)) break
    await sleep(250)
  }
  await sleep(2500)
  return new Phone(page, cdp, w, h)
}

/** Two fingers land `landMs` apart and move as told: `move(i, steps)` gives both fingers at step i. */
async function twoFingers(p: Phone, a0: Spot, b0: Spot, landMs: number, steps: number, at: (t: number) => [Spot, Spot], stepMs = 12) {
  // (Not waiting for CDP to answer about the first finger: it can take 30 ms, and the gap is what is being tested.)
  const first = p.down({ ...a0, id: 1 })
  await sleep(landMs)
  await Promise.all([first, p.down({ ...a0, id: 1 }, { ...b0, id: 2 })])
  await sleep(stepMs)
  for (let i = 1; i <= steps; i++) {
    const [a, b] = at(i / steps)
    await p.move({ ...a, id: 1 }, { ...b, id: 2 })
    await sleep(stepMs)
  }
  await p.lift()
  await sleep(80)
}

/** Spread (or squeeze) two level fingers about (cx, cy), the middle drifting by (dx, dy). */
function pinchPath(cx: number, cy: number, d0: number, d1: number, dx = 0, dy = 0) {
  const a0 = { x: cx - d0 / 2, y: cy }
  const b0 = { x: cx + d0 / 2, y: cy }
  const at = (t: number): [Spot, Spot] => {
    const d = d0 + (d1 - d0) * t
    const mx = cx + dx * t
    const my = cy + dy * t
    return [
      { x: mx - d / 2, y: my },
      { x: mx + d / 2, y: my },
    ]
  }
  return { a0, b0, at }
}

// ---------------------------------------------------------------- the scenarios

/** 1. A Pencil loop by one finger: a road, one Undo step, and as much of the line's start as the mouse draws. */
async function pencilLoop(p: Phone) {
  const loop: Spot[] = []
  for (let i = 0; i <= 80; i++) {
    const t = (i / 80) * Math.PI * 2
    loop.push({ x: p.w / 2 + (p.w * 0.3) * Math.cos(t), y: p.h / 2 + (p.h * 0.35) * Math.sin(t) })
  }
  const empty = async () => {
    await p.ed('newTrackNow')
    await p.ed('fit')
    await p.ed('tool', 'pencil')
    await sleep(300)
  }
  // The same path through the real mouse first.
  await empty()
  const m = p.page.mouse
  await m.move(loop[0].x, loop[0].y)
  await m.down()
  for (const s of loop.slice(1)) {
    await m.move(s.x, s.y)
    await sleep(12)
  }
  await m.up()
  await sleep(400)
  const mouseLine = (await p.g()).line as { x: number; z: number }[]
  const mouseRoad = await p.sum()
  ok(mouseRoad.points > 10 && mouseLine.length > 20, 'the mouse draws the loop', { points: mouseRoad.points, line: mouseLine.length })
  await empty()
  const undo0 = (await p.sum()).undoSteps
  const started0 = (await p.g()).toolStarts
  await p.drag(loop)
  await sleep(400)
  const s = await p.sum()
  const g = await p.g()
  const line = g.line as { x: number; z: number }[]
  ok(s.points > 10, 'a road', { points: s.points })
  ok(s.undoSteps - undo0 === 1, 'one Undo step', { added: s.undoSteps - undo0 })
  ok(g.toolStarts - started0 === 1 && g.handedOver > 0, 'the tool heard one finger and was handed what it missed', { toolStarts: g.toolStarts - started0, handedOver: g.handedOver })
  const mpp = g.view.mpp
  const off = Math.hypot(line[0].x - mouseLine[0].x, line[0].z - mouseLine[0].z) / mpp
  ok(off < 0.5, 'the line starts exactly where the mouse line does', { px: round(off) })
  ok(line.length >= mouseLine.length - 3, 'no fewer points than the mouse, near enough', { touch: line.length, mouse: mouseLine.length })
  // The first 40 px of the line, spot by spot: nothing went missing while the finger was armed.
  const firstBit = (l: { x: number; z: number }[]) => l.filter((q) => Math.hypot(q.x - l[0].x, q.z - l[0].z) / mpp < 40)
  const a = firstBit(line)
  const b = firstBit(mouseLine)
  ok(a.length >= b.length - 1, 'the start of the line has as many points as the mouse', { touch: a.length, mouse: b.length })
  const worst = worstOff(a, mouseLine) / mpp
  ok(worst <= LINE_PX, 'and they lie on the mouse line', { worstPx: round(worst) })
  await p.page.screenshot({ path: `${OUT}/${windowName}-1-pencil.png` })

  // The steady hand hides a lost start (its line only begins once the string is taut), so again with it off. The first move
  // (3.2 px, past the pencil's 3 px step and under the 6 to start the tool) always arrives while the finger is armed: a line that lost it starts its second point at 6.4.
  const slow: Spot[] = []
  for (let i = 0; i <= 30; i++) slow.push({ x: p.w * 0.3 + i * 3.2, y: p.h / 2 + i * 0.2 })
  await empty()
  const steady0 = (await p.sum()).steady
  await p.ed('steady', 0)
  await m.move(slow[0].x, slow[0].y)
  await m.down()
  for (const q of slow.slice(1)) {
    await m.move(q.x, q.y)
    await sleep(20)
  }
  await m.up()
  await sleep(300)
  const slowMouse = (await p.g()).line as World[]
  await empty()
  await p.ed('steady', 0)
  await p.drag(slow, 20)
  await sleep(300)
  const g2 = await p.g()
  const slowLine = g2.line as World[]
  const px = (a: World, b: World) => Math.hypot(a.x - b.x, a.z - b.z) / g2.view.mpp
  ok(px(slowLine[0], slowMouse[0]) < 0.5, 'steady hand off: starts where the mouse line starts', { px: round(px(slowLine[0], slowMouse[0])) })
  ok(px(slowLine[1], slowLine[0]) <= px(slowMouse[1], slowMouse[0]) + 1, 'and has its first few pixels, not a jump to where the tool heard', { nextPointPx: round(px(slowLine[1], slowLine[0])), mouse: round(px(slowMouse[1], slowMouse[0])) })
  ok(close(slowLine.length, slowMouse.length, 2), 'as many points as the mouse', { touch: slowLine.length, mouse: slowMouse.length })
  await p.ed('steady', steady0)
}

/** 2. A pinch with the fingers landing 20-40 ms apart, on each of the nine tools. */
async function pinchEveryTool(p: Phone) {
  await p.freshRoad()
  await p.page.screenshot({ path: `${OUT}/${windowName}-2-before.png` })
  const gaps = LAND_MS
  for (const [i, tool] of TOOLS.entries()) {
    await p.ed('fit')
    await p.ed('tool', tool)
    await sleep(50)
    const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
    ok(await p.onMap(spot), `${tool}: the fingers land on the map`)
    const before = await p.sum()
    const road0 = await p.road()
    const g0 = await p.g()
    const { a0, b0, at } = pinchPath(spot.x + 60, spot.y, 120, 240, 15, -5)
    const W = { x: g0.view.cx + (spot.x + 60 - p.w / 2) * g0.view.mpp, z: g0.view.cz + (spot.y - p.h / 2) * g0.view.mpp }
    await twoFingers(p, a0, b0, gaps[i % 3], 14, at)
    await sleep(150)
    const after = await p.sum()
    const g1 = await p.g()
    const ratio = g1.view.mpp / g0.view.mpp
    ok(close(ratio, 0.5, 0.02), `${tool}: zoom follows the fingers`, { ratio: round(ratio, 1000), landedMsApart: round(g1.secondFingerMs) })
    const sx = (W.x - g1.view.cx) / g1.view.mpp + p.w / 2
    const sy = (W.z - g1.view.cz) / g1.view.mpp + p.h / 2
    const off = Math.hypot(sx - (spot.x + 75), sy - (spot.y - 5))
    ok(off <= SPOT_PX, `${tool}: the spot between the fingers stays under them`, { px: round(off) })
    ok(after.undoSteps === before.undoSteps && (await p.road()) === road0, `${tool}: no Undo step, road unchanged`, { undo: after.undoSteps - before.undoSteps })
    ok(JSON.stringify(after.selection) === JSON.stringify(before.selection) && JSON.stringify(after.shaping) === JSON.stringify(before.shaping), `${tool}: nothing picked`)
    ok(g1.secondFingerMs >= 80 || g1.toolStarts === g0.toolStarts, `${tool}: the tool never heard about it`, { toolStarts: g1.toolStarts - g0.toolStarts })
    ok(g1.phase === 'idle', `${tool}: all fingers gone, back to idle`, g1.phase)
  }
  await p.page.screenshot({ path: `${OUT}/${windowName}-2-after.png` })
}

/** 3. Two fingers dragged on each tool: the view moves, no mark. */
async function dragEveryTool(p: Phone) {
  await p.freshRoad()
  for (const [i, tool] of TOOLS.entries()) {
    await p.ed('fit')
    await p.ed('tool', tool)
    await sleep(50)
    const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
    const before = await p.sum()
    const road0 = await p.road()
    const g0 = await p.g()
    const a0 = { x: spot.x, y: spot.y }
    const b0 = { x: spot.x + 110, y: spot.y + 20 }
    const dx = 80
    const dy = -30
    await twoFingers(p, a0, b0, LAND_MS[i % 3], 12, (t) => [
      { x: a0.x + dx * t, y: a0.y + dy * t },
      { x: b0.x + dx * t, y: b0.y + dy * t },
    ])
    await sleep(150)
    const after = await p.sum()
    const g1 = await p.g()
    const movedX = (g0.view.cx - g1.view.cx) / g0.view.mpp
    const movedY = (g0.view.cz - g1.view.cz) / g0.view.mpp
    ok(close(movedX, dx, DRAG_PX) && close(movedY, dy, DRAG_PX), `${tool}: the view moves with the fingers`, { movedX: round(movedX), movedY: round(movedY) })
    ok(close(g1.view.mpp, g0.view.mpp, g0.view.mpp * 0.005), `${tool}: no zoom`, { ratio: round(g1.view.mpp / g0.view.mpp, 1000) })
    ok(after.undoSteps === before.undoSteps && (await p.road()) === road0, `${tool}: no mark`, { undo: after.undoSteps - before.undoSteps })
    ok(g1.secondFingerMs >= 80 || g1.toolStarts === g0.toolStarts, `${tool}: the tool never heard about it`, { toolStarts: g1.toolStarts - g0.toolStarts, landedMsApart: round(g1.secondFingerMs) })
  }
}

/** 4. A second finger after the tool has started, within 24 px of its start: tool cancelled, no Undo step, carries on as a pinch. */
async function secondFingerEarly(p: Phone) {
  await p.freshRoad()
  const press = async (label: string, spot: Spot) => {
    const before = await p.sum()
    const road0 = await p.road()
    const g0 = await p.g()
    const held = { x: spot.x, y: spot.y }
    await p.down({ ...held, id: 1 })
    await sleep(120)
    const armedOut = await p.g()
    ok(armedOut.toolStarts - g0.toolStarts === 1 && armedOut.phase === 'tool', `${label}: the tool started after the arm time`, { toolStarts: armedOut.toolStarts - g0.toolStarts, phase: armedOut.phase })
    held.x += 10
    await p.move({ ...held, id: 1 })
    await sleep(30)
    const second = { x: Math.min(p.w - 20, held.x + 100), y: held.y }
    await p.down({ ...held, id: 1 }, { ...second, id: 2 })
    await sleep(20)
    const d0 = second.x - held.x
    for (let i = 1; i <= 12; i++) {
      await p.move({ x: held.x - i * 5, y: held.y, id: 1 }, { x: second.x + i * 5, y: held.y, id: 2 })
      await sleep(12)
    }
    const during = await p.g()
    await p.lift()
    await sleep(200)
    const after = await p.sum()
    const g1 = await p.g()
    ok(g1.takeBacks - g0.takeBacks === 1, `${label}: the press was taken back`, { takeBacks: g1.takeBacks - g0.takeBacks })
    ok(during.phase === 'map', `${label}: carries on as a pinch`, during.phase)
    ok(close(g1.view.mpp / g0.view.mpp, d0 / (d0 + 120), 0.03), `${label}: the zoom follows the fingers`, { ratio: round(g1.view.mpp / g0.view.mpp, 1000), expect: round(d0 / (d0 + 120), 1000) })
    ok(after.undoSteps === before.undoSteps && after.redoSteps === before.redoSteps, `${label}: no Undo step, Redo kept`, { undo: after.undoSteps - before.undoSteps, redo: after.redoSteps - before.redoSteps })
    ok((await p.road()) === road0, `${label}: road unchanged`)
    ok(JSON.stringify(after.selection) === JSON.stringify(before.selection), `${label}: selection as it was`, { was: before.selection, now: after.selection })
    ok(JSON.stringify(after.shaping) === JSON.stringify(before.shaping), `${label}: half-made shape as it was`, { was: before.shaping, now: after.shaping })
    ok(after.tool === before.tool, `${label}: same tool`, after.tool)
    ok(after.dirty === before.dirty, `${label}: saved state as it was`, { was: before.dirty, now: after.dirty })
  }
  for (const tool of TOOLS) {
    await p.ed('fit')
    await p.ed('tool', tool)
    await sleep(50)
    await press(tool, await p.roadNear(p.w / 2 - 60, p.h / 2))
  }
  // Tools that act on the press itself, part way through what they do.
  const n = (await p.sum()).points
  await p.ed('fit')
  await p.ed('tool', 'straight')
  const s1 = await p.roadNear(p.w / 2 - 110, p.h / 2)
  const s2 = await p.roadNear(p.w / 2 - 30, p.h / 2)
  await p.tap(s1)
  ok((await p.sum()).shaping?.tool === 'straight', 'straight half made: the first tap is in')
  await press('straight, its finishing press', s2)
  await p.ed('tool', 'select')
  await p.ed('fit')
  await p.ed('tool', 'curve')
  const c1 = { ...s1 }
  await p.tap(c1)
  // A spot far enough along the road for Curve (30 m).
  let c2 = await p.ed('screen', (s1.at + 3) % n) as { sx: number; sy: number }
  await p.tap({ x: c2.sx, y: c2.sy })
  if ((await p.sum()).shaping?.b == null) {
    c2 = await p.ed('screen', (s1.at + 6) % n) as { sx: number; sy: number }
    await p.tap({ x: c2.sx, y: c2.sy })
  }
  ok((await p.sum()).shaping?.b != null, 'curve half made: two taps are in')
  await press('curve, its finishing press', { x: c2.sx + 25, y: c2.sy + 15 })
  await p.ed('tool', 'select')
  // Place with something to Redo: the press must not eat it.
  await p.ed('fit')
  await p.ed('tool', 'place')
  const pl = await p.roadNear(p.w / 2 - 60, p.h / 2)
  await p.tap(pl)
  await sleep(100)
  await p.ed('undo')
  await sleep(100)
  ok((await p.sum()).redoSteps >= 1, 'place: something to Redo')
  await press('place, Redo waiting', pl)
  await p.ed('redo')
  await sleep(80)
  await p.undoTo((await p.sum()).undoSteps - 1)
  // Select on a road point: it goes back where it was.
  const point = (await p.roadPoints())[3]
  await p.ed('tool', 'select')
  await p.ed('view', [point.x, point.z, 0.5])
  await sleep(80)
  const ps = (await p.ed('screen', [point.x, point.z])) as { sx: number; sy: number }
  await press('select, a road point', { x: ps.sx, y: ps.sy })
  await p.ed('fit')
}

/** A long Pencil line that starts and ends on the road and bulges between: letting go redraws that stretch. */
async function redrawLine(p: Phone, steps: number): Promise<Spot[]> {
  const start = await p.roadNear(p.w / 2 - 110, p.h / 2)
  const end = await p.roadNear(p.w / 2 + 40, p.h / 2)
  const path: Spot[] = []
  const nx = -(end.y - start.y)
  const ny = end.x - start.x
  const nl = Math.hypot(nx, ny) || 1
  const sign = start.y + (ny / nl) * 30 < p.h / 2 ? 1 : -1
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const bulge = Math.sin(t * Math.PI) * 28 * sign
    path.push({ x: start.x + (end.x - start.x) * t + (nx / nl) * bulge, y: start.y + (end.y - start.y) * t + (ny / nl) * bulge })
  }
  return path
}

/** 5. A second finger late in a long Pencil line: the line carries on unchanged. */
async function secondFingerLate(p: Phone) {
  await p.freshRoad()
  await p.ed('tool', 'pencil')
  const steps = 60
  const path = await redrawLine(p, steps)
  const base = await p.sum()
  const road0 = await p.road()
  await p.drag(path, 10)
  await sleep(300)
  const alone = await p.sum()
  const gAlone = await p.g()
  const lineAlone = gAlone.line as { x: number; z: number }[]
  ok(alone.undoSteps - base.undoSteps === 1 && lineAlone.length > 20, 'the line alone redraws the stretch', { undo: alone.undoSteps - base.undoSteps, line: lineAlone.length, msg: await p.page.evaluate(() => (window as unknown as { __game: { get(k: string): unknown } }).__game.get('editorMsg')) })
  const roadAlone = await p.road()
  await p.undoTo(base.undoSteps)
  ok((await p.road()) === road0, 'and undo puts it back')

  // The same line, with a thumb coming down part way, wandering, and lifting before the line ends.
  const g0 = await p.g()
  const thumb = { x: 40, y: p.h - 40 }
  await p.down({ ...path[0], id: 1 })
  await sleep(10)
  for (let i = 1; i <= steps; i++) {
    const f = { ...path[i], id: 1 }
    if (i === 30) await p.down({ ...path[29], id: 1 }, { ...thumb, id: 2 })
    else if (i > 30 && i < 45) await p.move(f, { x: thumb.x + (i - 30) * 3, y: thumb.y - (i - 30) * 2, id: 2 })
    else if (i === 45) await p.liftOne({ x: thumb.x + 42, y: thumb.y - 28, id: 2 })
    else await p.move(f)
    await sleep(10)
  }
  await p.lift()
  await sleep(300)
  const after = await p.sum()
  const g1 = await p.g()
  const line = g1.line as { x: number; z: number }[]
  ok(g1.ignored - g0.ignored === 1, 'the late finger was ignored', { ignored: g1.ignored - g0.ignored })
  ok(after.undoSteps - base.undoSteps === 1, 'the line still lands, one Undo step', { undo: after.undoSteps - base.undoSteps })
  ok(g1.view.cx === g0.view.cx && g1.view.cz === g0.view.cz && g1.view.mpp === g0.view.mpp, 'the view never moved')
  ok(close(line.length, lineAlone.length, Math.max(3, lineAlone.length * 0.15)), 'the same length of line', { withThumb: line.length, alone: lineAlone.length })
  const mpp = g1.view.mpp
  const worst = worstOff(line, lineAlone) / mpp
  ok(worst <= LINE_PX, 'the same line', { worstPx: round(worst) })
  const a = JSON.parse(roadAlone).road.points as { x: number; z: number }[]
  const b = await p.roadPoints()
  const roadOff = worstOff(b, a) / mpp
  ok(roadOff <= LINE_PX, 'the same road', { worstPx: round(roadOff), points: [a.length, b.length] })
  await p.undoTo(base.undoSteps)

  // A thumb still resting when the line ends, and then a new line drawn beside it: the thumb does nothing.
  await p.down({ ...path[0], id: 1 })
  await sleep(10)
  for (let i = 1; i <= steps; i++) {
    if (i === 30) await p.down({ ...path[29], id: 1 }, { ...thumb, id: 2 })
    else if (i > 30) await p.move({ ...path[i], id: 1 })
    else await p.move({ ...path[i], id: 1 })
    await sleep(10)
  }
  await p.liftOne({ ...path[steps], id: 1 })
  await sleep(300)
  const lifted = await p.sum()
  ok(lifted.undoSteps - base.undoSteps === 1, 'the line lands when its finger lifts, the thumb still down', { undo: lifted.undoSteps - base.undoSteps })
  const v0 = (await p.g()).view
  await p.move({ x: thumb.x + 40, y: thumb.y - 30, id: 2 })
  await sleep(30)
  const v1 = (await p.g()).view
  ok(v0.cx === v1.cx && v0.cz === v1.cz, 'the resting thumb moves nothing', { v0, v1 })
  await p.lift()
  await sleep(100)
  ok((await p.g()).phase === 'idle', 'all fingers gone, back to idle')
  await p.undoTo(base.undoSteps)
  await p.ed('tool', 'select')
}

/** 6. A touch the system takes away commits nothing. */
async function cancelled(p: Phone) {
  await p.freshRoad()
  await p.ed('tool', 'pencil')
  const start = await p.roadNear(p.w / 2 - 110, p.h / 2)
  const line = (n: number) => Array.from({ length: n }, (_, i) => ({ x: start.x + i * 3, y: start.y + Math.sin(i / 4) * 12 }))
  const nothing = async (label: string, before: Awaited<ReturnType<Phone['sum']>>, road0: string) => {
    await sleep(200)
    const after = await p.sum()
    ok(after.undoSteps === before.undoSteps, `${label}: no Undo step`, { undo: after.undoSteps - before.undoSteps })
    ok((await p.road()) === road0, `${label}: road unchanged`)
    ok((await p.g()).phase === 'idle', `${label}: back to idle`)
  }
  let before = await p.sum()
  let road0 = await p.road()
  let g0 = await p.g()
  const path = line(40)
  // A line that would land if it were lifted here (scenario 5 proves that): the system takes the touch away right at its end.
  const whole = await redrawLine(p, 50)
  await p.down({ ...whole[0], id: 1 })
  for (const s of whole.slice(1)) {
    await p.move({ ...s, id: 1 })
    await sleep(8)
  }
  await p.cancel()
  await nothing('mid-line', before, road0)
  ok((await p.g()).takeBacks - g0.takeBacks === 1, 'mid-line: taken back')

  // Mid-drag of a road point.
  const point = (await p.roadPoints())[3]
  await p.ed('tool', 'select')
  await p.ed('view', [point.x, point.z, 0.5])
  await sleep(80)
  const ps = (await p.ed('screen', [point.x, point.z])) as { sx: number; sy: number }
  before = await p.sum()
  road0 = await p.road()
  await p.down({ x: ps.sx, y: ps.sy, id: 1 })
  await sleep(100)
  for (let i = 1; i < 12; i++) {
    await p.move({ x: ps.sx + i * 4, y: ps.sy + i * 2, id: 1 })
    await sleep(10)
  }
  ok((await p.road()) !== road0, 'mid-drag: the point really was moving')
  await p.cancel()
  await nothing('mid-drag', before, road0)
  await p.ed('fit')

  // Inside the arm window: the tool never hears.
  await p.ed('tool', 'pencil')
  before = await p.sum()
  road0 = await p.road()
  g0 = await p.g()
  await p.down({ ...start, id: 1 })
  await sleep(20)
  await p.cancel()
  await nothing('while armed', before, road0)
  await sleep(120)
  ok((await p.g()).toolStarts === g0.toolStarts, 'while armed: the tool never heard')

  // Mid-pinch: the view stays where it got to, and the next finger is a tool's finger again, not a third.
  g0 = await p.g()
  await p.down({ x: start.x, y: start.y, id: 1 })
  await sleep(25)
  await p.down({ x: start.x, y: start.y, id: 1 }, { x: start.x + 100, y: start.y, id: 2 })
  for (let i = 1; i < 8; i++) {
    await p.move({ x: start.x - i * 4, y: start.y, id: 1 }, { x: start.x + 100 + i * 4, y: start.y, id: 2 })
    await sleep(10)
  }
  await p.cancel()
  await nothing('mid-pinch', before, road0)
  await p.ed('fit')
  const g2 = await p.g()
  await p.tap(start)
  ok((await p.g()).toolStarts - g2.toolStarts === 1, 'mid-pinch: the next finger is the tool again', { toolStarts: (await p.g()).toolStarts - g2.toolStarts })

  // The window loses the page mid-line.
  before = await p.sum()
  await p.down({ ...path[0], id: 1 })
  for (const s of path.slice(1, 25)) {
    await p.move({ ...s, id: 1 })
    await sleep(8)
  }
  await p.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await p.lift()
  await nothing('window blur', before, road0)

  // A lift that never arrives: the next finger must not be taken for a second finger.
  before = await p.sum()
  g0 = await p.g()
  await p.page.evaluate(() => window.addEventListener('pointerup', (e) => e.stopImmediatePropagation(), { capture: true, once: true }))
  await p.down({ ...path[0], id: 1 })
  for (const s of path.slice(1)) {
    await p.move({ ...s, id: 1 })
    await sleep(8)
  }
  await p.lift()
  await sleep(250)
  await nothing('a lost lift', before, road0)
  const g3 = await p.g()
  await p.tap(start)
  const g4 = await p.g()
  ok(g4.toolStarts - g3.toolStarts === 1 && g4.mapGestures === g3.mapGestures, 'a lost lift: the next finger is the tool, not a pinch', { toolStarts: g4.toolStarts - g3.toolStarts, mapGestures: g4.mapGestures - g3.mapGestures })
  await p.ed('tool', 'select')
  await p.ed('fit')
}

/** 7. What one finger does today still works: tap to pick, double tap to add a point, drag off the road to pan. */
async function oneFinger(p: Phone) {
  await p.freshRoad()
  const point = (await p.roadPoints())[3]
  for (const [label, hold] of [['quick tap', 40], ['slower tap', 130]] as const) {
    await p.ed('tool', 'select')
    await p.ed('view', [point.x, point.z, 0.5])
    await sleep(80)
    const ps = (await p.ed('screen', [point.x, point.z])) as { sx: number; sy: number }
    await p.tap({ x: ps.sx, y: ps.sy }, hold)
    const sel = (await p.sum()).selection
    ok(sel?.kind === 'point' && sel.index === 3, `${label} picks a road point, Select, zoomed in`, sel)
    await p.ed('tool', 'pencil')
    await sleep(400) // not a double tap on the same spot
  }
  await p.ed('fit')
  await p.ed('tool', 'height')
  await sleep(50)
  for (const [label, hold] of [['quick tap', 40], ['slower tap', 130]] as const) {
    await p.ed('tool', 'pencil')
    await p.ed('tool', 'height')
    const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
    await p.tap(spot, hold)
    const sel = (await p.sum()).selection
    ok(sel?.kind === 'section' && sel.from !== sel.to, `${label} picks a stretch, Height`, sel)
  }

  // Double tap: quick, and with the fingers on the glass long enough to pass the arm time.
  for (const [label, hold, gap] of [['quick', 30, 40], ['slower', 110, 140]] as const) {
    await p.ed('tool', 'select')
    await p.ed('fit')
    await sleep(380)
    const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
    // Half way between two road points: right on one, the editor says there already is one.
    const mid = (await p.ed('screen', Math.floor(spot.at) + 0.5)) as { sx: number; sy: number }
    const between = { x: mid.sx, y: mid.sy }
    const points0 = (await p.sum()).points
    const undo0 = (await p.sum()).undoSteps
    await p.down({ ...between, id: 1 })
    await sleep(hold)
    await p.lift()
    await sleep(gap)
    await p.down({ ...between, id: 1 })
    await sleep(hold)
    await p.lift()
    await sleep(150)
    const s = await p.sum()
    ok(s.points === points0 + 1, `${label} double tap adds a point`, { added: s.points - points0 })
    await p.undoTo(undo0)
  }

  // One finger off the road with Select pans, and by the whole of the finger's path (what it did while armed included).
  await p.ed('fit')
  await p.ed('tool', 'select')
  await sleep(380)
  const off = await offRoad(p)
  ok(off !== null, 'a spot off the road', off)
  if (off) {
    const g0 = await p.g()
    const road0 = await p.road()
    const path = Array.from({ length: 16 }, (_, i) => ({ x: off.x + i * 5, y: off.y + i * 2 }))
    await p.drag(path)
    const g1 = await p.g()
    const movedX = (g0.view.cx - g1.view.cx) / g0.view.mpp
    const movedY = (g0.view.cz - g1.view.cz) / g0.view.mpp
    ok(close(movedX, 75, DRAG_PX) && close(movedY, 30, DRAG_PX), 'one finger off the road pans, all of its path', { movedX: round(movedX), movedY: round(movedY) })
    ok((await p.road()) === road0, 'and leaves the road alone')

    // Panning already, then a second finger, however far the first has come: there is no line to protect, so the map takes it.
    await p.ed('fit')
    await sleep(380)
    const g2 = await p.g()
    let f1 = { x: off.x, y: off.y }
    await p.down({ ...f1, id: 1 })
    await sleep(20)
    for (let i = 1; i <= 16; i++) {
      f1 = { x: off.x + i * 4, y: off.y }
      await p.move({ ...f1, id: 1 })
      await sleep(10)
    }
    const panned = await p.g()
    const f2 = { x: Math.min(p.w - 30, f1.x + 120), y: f1.y }
    const d0 = f2.x - f1.x
    await p.down({ ...f1, id: 1 }, { ...f2, id: 2 })
    for (let i = 1; i <= 10; i++) {
      await p.move({ x: f1.x - i * 4, y: f1.y, id: 1 }, { x: f2.x + i * 4, y: f2.y, id: 2 })
      await sleep(10)
    }
    await p.lift()
    await sleep(120)
    const g3 = await p.g()
    ok(g3.mapGestures - g2.mapGestures === 1 && g3.ignored === g2.ignored, 'a second finger joins a one-finger pan, however far it has come', { mapGestures: g3.mapGestures - g2.mapGestures })
    ok(close(g3.view.mpp / panned.view.mpp, d0 / (d0 + 80), 0.03), 'and pinches', { ratio: round(g3.view.mpp / panned.view.mpp, 1000) })
  }

  // A pinch ended one finger at a time never leaves a mark, and a new finger beside the one left grips the map again.
  await p.ed('fit')
  await p.ed('tool', 'pencil')
  await sleep(50)
  const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const u0 = (await p.sum()).undoSteps
  const road0 = await p.road()
  const g0 = await p.g()
  const a = { ...spot, id: 1 }
  const b = { x: spot.x + 100, y: spot.y, id: 2 }
  await p.down(a)
  await sleep(25)
  await p.down(a, b)
  await sleep(15)
  await p.move({ ...a, x: a.x - 20 }, { ...b, x: b.x + 20 })
  await sleep(15)
  // The second finger lifts, the first goes on moving, far enough to be a line if anybody listened.
  await p.liftOne({ ...b, x: b.x + 20 })
  const v0 = (await p.g()).view
  for (let i = 1; i <= 20; i++) {
    await p.move({ ...a, x: a.x - 20 - i * 4 })
    await sleep(8)
  }
  const v1 = (await p.g()).view
  ok(v0.cx === v1.cx && v0.cz === v1.cz && v0.mpp === v1.mpp, 'the finger left over from a pinch moves nothing')
  await p.down({ ...a, x: a.x - 100 }, { x: a.x + 40, y: a.y, id: 3 })
  await sleep(15)
  await p.move({ ...a, x: a.x - 120 }, { x: a.x + 60, y: a.y, id: 3 })
  await sleep(150) // moves reach the page on its next frame
  const v2 = (await p.g()).view
  ok(v2.mpp !== v1.mpp, 'a new finger beside it grips the map again', { ratio: round(v2.mpp / v1.mpp, 1000) })
  await p.lift()
  await sleep(150)
  const after = await p.sum()
  const g1 = await p.g()
  ok(after.undoSteps === u0 && (await p.road()) === road0 && g1.toolStarts === g0.toolStarts, 'and nothing reached the tool', { undo: after.undoSteps - u0, toolStarts: g1.toolStarts - g0.toolStarts })
  await p.ed('tool', 'select')
  await p.ed('fit')
}

/** A spot on screen well away from the road. */
async function offRoad(p: Phone): Promise<Spot | null> {
  const shown = (await Promise.all((await p.roadPoints()).map((q) => p.ed('screen', [q.x, q.z])))) as { sx: number; sy: number }[]
  let best: Spot | null = null
  let bestD = 0
  for (let x = 90; x < p.w - 170; x += 10) {
    for (let y = 30; y < p.h - 30; y += 10) {
      const d = Math.min(...shown.map((s) => Math.hypot(s.sx - x, s.sy - y)))
      if (d > bestD) {
        bestD = d
        best = { x, y }
      }
    }
  }
  return bestD > 50 ? best : null
}

/** 8. In 3D: pinch goes closer and further, two fingers slide, a twist turns, and no tool fires. */
async function in3d(p: Phone) {
  await p.freshRoad()
  await p.ed('tool', 'pencil')
  await p.look('open')
  for (let i = 0; i < 40; i++) {
    const s = (await p.look('state')) as { mix: number }
    if (s.mix >= 0.999) break
    await sleep(150)
  }
  await sleep(300)
  type Look = { mix: number; target: { x: number; y: number; z: number }; yawDeg: number; pitchDeg: number; dist: number }
  const look = async () => {
    await sleep(900) // the camera glides after the fingers
    return (await p.look('state')) as Look
  }
  const cx = p.w / 2
  const cy = p.h / 2
  const road0 = await p.road()
  const undo0 = (await p.sum()).undoSteps
  const g0 = await p.g()
  const noTool = async (label: string) => {
    const g = await p.g()
    ok(g.toolStarts === g0.toolStarts, `${label}: no tool fired`, { toolStarts: g.toolStarts - g0.toolStarts, landedMsApart: round(g.secondFingerMs) })
    ok((await p.sum()).undoSteps === undo0 && (await p.road()) === road0, `${label}: no mark`)
  }

  let a = await look()
  ok(a.mix >= 0.999, '3D is open', { mix: a.mix })
  await p.page.screenshot({ path: `${OUT}/${windowName}-8-3d.png` })
  // Pinch out: closer.
  let path = pinchPath(cx, cy, 120, 240)
  await twoFingers(p, path.a0, path.b0, 30, 14, path.at)
  let b = await look()
  ok(close(b.dist / a.dist, 0.5, 0.05), 'fingers spread: closer', { dist: [a.dist, b.dist] })
  ok(close(b.yawDeg, a.yawDeg, 0.2) && close(b.pitchDeg, a.pitchDeg, 0.2), 'and no turn', { yaw: [a.yawDeg, b.yawDeg] })
  await noTool('pinch out')
  // Pinch in: further.
  a = b
  path = pinchPath(cx, cy, 240, 120)
  await twoFingers(p, path.a0, path.b0, 25, 14, path.at)
  b = await look()
  ok(close(b.dist / a.dist, 2, 0.15), 'fingers together: further', { dist: [a.dist, b.dist] })
  await noTool('pinch in')
  // A pinch with a little accidental twist in it must not turn the view.
  a = b
  const noisy = (t: number): [Spot, Spot] => {
    const d = 120 + 60 * t
    const ang = ((6 * Math.PI) / 180) * t
    return [
      { x: cx - (Math.cos(ang) * d) / 2, y: cy - (Math.sin(ang) * d) / 2 },
      { x: cx + (Math.cos(ang) * d) / 2, y: cy + (Math.sin(ang) * d) / 2 },
    ]
  }
  await twoFingers(p, { x: cx - 60, y: cy }, { x: cx + 60, y: cy }, 30, 14, noisy)
  b = await look()
  ok(close(b.yawDeg, a.yawDeg, 0.2), 'a pinch with a 6 degree wobble does not turn', { yaw: [a.yawDeg, b.yawDeg] })
  await noTool('wobbly pinch')
  // Two fingers dragged: slides, and the ground follows them.
  a = b
  const a0 = { x: cx - 60, y: cy }
  const b0 = { x: cx + 60, y: cy }
  const spotBefore = (await p.look('project', [a.target.x, a.target.y, a.target.z])) as { sx: number; sy: number }
  await twoFingers(p, a0, b0, 30, 14, (t) => [
    { x: a0.x + 90 * t, y: a0.y + 25 * t },
    { x: b0.x + 90 * t, y: b0.y + 25 * t },
  ])
  b = await look()
  const spotAfter = (await p.look('project', [a.target.x, a.target.y, a.target.z])) as { sx: number; sy: number }
  ok(Math.hypot(b.target.x - a.target.x, b.target.z - a.target.z) > 5, 'two fingers dragged: the view slides', { target: [a.target, b.target] })
  ok(spotAfter.sx - spotBefore.sx > 30, 'and the ground goes with the fingers', { movedPx: round(spotAfter.sx - spotBefore.sx) })
  ok(close(b.yawDeg, a.yawDeg, 0.2) && close(b.dist, a.dist, a.dist * 0.02), 'no turn, no zoom', { yaw: [a.yawDeg, b.yawDeg], dist: [a.dist, b.dist] })
  await noTool('slide')
  // A twist, clockwise on screen: the ground turns the same way.
  a = b
  const R = 80
  const yawRad = (a.yawDeg * Math.PI) / 180
  const side = { x: a.target.x + Math.cos(yawRad) * 40, y: a.target.y, z: a.target.z - Math.sin(yawRad) * 40 }
  const round3d = (s: { sx: number; sy: number }, c: { sx: number; sy: number }) => Math.atan2(s.sy - c.sy, s.sx - c.sx)
  const c0 = (await p.look('project', [a.target.x, a.target.y, a.target.z])) as { sx: number; sy: number }
  const s0 = (await p.look('project', [side.x, side.y, side.z])) as { sx: number; sy: number }
  const turn = (40 * Math.PI) / 180
  await twoFingers(p, { x: cx - R, y: cy }, { x: cx + R, y: cy }, 30, 18, (t) => [
    { x: cx - Math.cos(turn * t) * R, y: cy - Math.sin(turn * t) * R },
    { x: cx + Math.cos(turn * t) * R, y: cy + Math.sin(turn * t) * R },
  ])
  b = await look()
  const yawMoved = b.yawDeg - a.yawDeg
  ok(close(yawMoved, 30, 3), 'a 40 degree twist turns the view, less the 10 it takes to start', { yawMoved: round(yawMoved) })
  ok(close(b.dist, a.dist, a.dist * 0.02), 'and does not zoom', { dist: [a.dist, b.dist] })
  const c1 = (await p.look('project', [a.target.x, a.target.y, a.target.z])) as { sx: number; sy: number }
  const s1 = (await p.look('project', [side.x, side.y, side.z])) as { sx: number; sy: number }
  let turned = round3d(s1, c1) - round3d(s0, c0)
  if (turned > Math.PI) turned -= Math.PI * 2
  if (turned < -Math.PI) turned += Math.PI * 2
  ok(turned > 0.1, 'the ground turns the way the fingers did', { turnedDeg: round((turned * 180) / Math.PI) })
  await noTool('twist')
  await p.page.screenshot({ path: `${OUT}/${windowName}-8-3d-after.png` })
  await p.look('close')
  await sleep(1200)
  await p.ed('tool', 'select')
}

/** A computer's window, with a mouse: no touch, and no touch switch in the address. */
async function openDesktop(): Promise<Phone> {
  const page = await browser.newPage()
  page.on('pageerror', (e) => ok(false, 'page error', String((e as Error).stack ?? (e as Error).message).slice(0, 600)))
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument(watchWords)
  await page.evaluateOnNewDocument(() => localStorage.removeItem('sr2.editor.working.v1'))
  await page.goto(`http://localhost:${port}/?editor=1&nomusic=1&quality=low`, { waitUntil: 'load' })
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid=editor-ui]')).catch(() => false)) break
    await sleep(250)
  }
  await sleep(2000)
  return new Phone(page, await page.createCDPSession(), 1920, 1080)
}

/** 9. A real mouse and a real pen at 1920x1080: the press acts with no delay, right drag and the wheel as before. */
async function mouseAndPen() {
  const p = await openDesktop()
  const { page, cdp } = p
  await p.freshRoad()
  const m = page.mouse
  const spot = await p.roadNear(760, 540)
  ok(await p.onMap(spot), 'the mouse is over the map')
  const g0 = await p.g()
  // Place: the piece is there the moment the button goes down, with no time for any arming.
  await p.ed('tool', 'place')
  await m.move(spot.x, spot.y)
  const pieces0 = (await p.sum()).pieces
  await m.down()
  const piecesNow = (await p.sum()).pieces
  await m.up()
  ok(piecesNow === pieces0 + 1, 'place: the press acts at once', { added: piecesNow - pieces0 })
  await p.ed('undo')
  // Straight: the first press is in at once.
  await p.ed('tool', 'straight')
  await m.move(spot.x, spot.y)
  await m.down()
  const shaping = (await p.sum()).shaping
  await m.up()
  ok(shaping?.tool === 'straight', 'straight: the press acts at once', shaping)
  await p.ed('tool', 'select')
  // Right drag pans, from the first pixel, with every tool.
  for (const tool of ['pencil', 'select', 'bend'] as const) {
    await p.ed('tool', tool)
    const v0 = (await p.g()).view
    await m.move(spot.x, spot.y)
    await m.down({ button: 'right' })
    await m.move(spot.x + 3, spot.y + 1)
    const v1 = (await p.g()).view
    await m.move(spot.x + 60, spot.y + 40)
    await m.up({ button: 'right' })
    const v2 = (await p.g()).view
    ok(close((v0.cx - v1.cx) / v0.mpp, 3, 0.01), `${tool}: right drag pans from the first pixel`, { px: round((v0.cx - v1.cx) / v0.mpp) })
    ok(close((v0.cx - v2.cx) / v0.mpp, 60, 0.01) && close((v0.cz - v2.cz) / v0.mpp, 40, 0.01), `${tool}: and all the way`, { x: round((v0.cx - v2.cx) / v0.mpp), z: round((v0.cz - v2.cz) / v0.mpp) })
  }
  await p.ed('fit')
  // The wheel zooms at the pointer.
  await p.ed('tool', 'select')
  await m.move(spot.x, spot.y)
  const v0 = (await p.g()).view
  const W = { x: v0.cx + (spot.x - 960) * v0.mpp, z: v0.cz + (spot.y - 540) * v0.mpp }
  await m.wheel({ deltaY: -240 })
  await sleep(80)
  const v1 = (await p.g()).view
  const off = Math.hypot((W.x - v1.cx) / v1.mpp + 960 - spot.x, (W.z - v1.cz) / v1.mpp + 540 - spot.y)
  ok(close(v1.mpp / v0.mpp, Math.exp(-240 * 0.0015), 0.01), 'the wheel zooms', { ratio: round(v1.mpp / v0.mpp, 1000) })
  ok(off < 0.5, 'at the pointer', { px: round(off) })
  await p.ed('fit')
  // A pen acts at once too.
  await p.ed('tool', 'straight')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' } as never)
  const penShape = (await p.sum()).shaping
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' } as never)
  ok(penShape?.tool === 'straight', 'a pen: the press acts at once', penShape)
  await p.ed('tool', 'select')
  // A mouse's pointercancel still runs the lift, as it always has.
  await p.ed('tool', 'pencil')
  const undo0 = (await p.sum()).undoSteps
  const startAt = await p.roadNear(700, 540)
  const endAt = await p.roadNear(860, 540)
  await m.move(startAt.x, startAt.y)
  await m.down()
  for (let i = 1; i <= 30; i++) {
    const t = i / 30
    await m.move(startAt.x + (endAt.x - startAt.x) * t, startAt.y + (endAt.y - startAt.y) * t + Math.sin(t * Math.PI) * 40)
    await sleep(8)
  }
  await page.evaluate((x: number, y: number) => document.querySelector('.sre-overlay')!.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true, clientX: x, clientY: y })), endAt.x, endAt.y)
  await m.up()
  await sleep(300)
  ok((await p.sum()).undoSteps - undo0 === 1, "a mouse's pointercancel lands the line, as before", { undo: (await p.sum()).undoSteps - undo0, said: await page.evaluate(() => (window as unknown as { __game: { get(k: string): unknown } }).__game.get('editorMsg')) })
  await p.ed('tool', 'select')
  ok(await page.evaluate(() => document.dispatchEvent(new Event('gesturestart', { cancelable: true }))), "with no fingers, a page pinch (a Mac's trackpad) is left alone")
  // Nothing of all that went through the fingers' side of the layer.
  const g1 = await p.g()
  ok(g1.toolStarts === g0.toolStarts && g1.mapGestures === g0.mapGestures && g1.phase === 'idle', 'none of it went through the arming', { toolStarts: g1.toolStarts - g0.toolStarts })
  await page.close()
}

/**
 * 10. The tool button (layout C) by real fingers on the real layout: it opens the tray, the tray holds the nine
 * tools in the computer's order and View, a tap on the map only closes it, and two fingers are the map with
 * every panel open. The card's slider, Undo and Redo, Cancel for the other thumb, the Menu.
 */
async function toolButton(p: Phone) {
  await p.hidePanels(false)
  await p.freshRoad()
  await p.ed('tool', 'pencil')
  await sleep(200)
  const box = (sel: string) =>
    p.page.evaluate((s: string) => {
      const e = document.querySelector(s)
      if (!e || !(e as HTMLElement).checkVisibility()) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2, text: (e as HTMLElement).innerText }
    }, sel)
  const press = async (sel: string) => {
    const b = await box(sel)
    if (!b) return ok(false, `${sel} is there to press`)
    await p.tap({ x: b.x, y: b.y })
    await sleep(80)
  }
  const tool = async () => (await p.sum()).tool
  const trayUp = async () => !!(await box('[data-testid=phone-tray]'))
  const inset = 62
  const b = (await box('[data-testid=phone-tool]'))!
  ok(!!b, 'the tool button is there')
  ok(b.top >= 0 && b.bottom <= p.h - 20, 'it fits, clear of the home bar', { top: b.top, bottom: b.bottom })
  ok(b.left >= inset, 'and clears the notch', { left: b.left })
  ok(b.h >= 44 && b.w >= 44, 'it is big enough for a thumb', { w: b.w, h: b.h })
  ok(/Pencil/.test(b.text), 'it says the tool in your hand', b.text)
  ok(!(await trayUp()), 'the tray starts shut')

  await p.tap({ x: b.x, y: b.y })
  ok(await trayUp(), 'one tap opens the tray, at once')
  const cells = await p.page.evaluate(() => [...document.querySelectorAll('[data-testid=phone-tray] [data-rail]')].map((e) => (e as HTMLElement).dataset.rail))
  ok(JSON.stringify(cells) === JSON.stringify(TOOLS), "nine tools, in the computer's order", cells)
  const sizes = await p.page.evaluate(() => [...document.querySelectorAll('[data-testid=phone-tray] button')].map((e) => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, top: r.top, bottom: r.bottom, left: r.left } }))
  ok(sizes.every((s) => s.h >= 44 && s.w >= 44), 'every cell and View is big enough for a thumb', sizes.map((s) => Math.round(s.h)))
  ok(sizes.every((s) => s.top >= 0 && s.bottom <= p.h - 20 && s.left >= inset), 'and all of the tray is on screen')
  // Every tool, by its own tap.
  for (const t of TOOLS) {
    if (!(await trayUp())) await press('[data-testid=phone-tool]')
    await press(`[data-testid=phone-tray] [data-rail=${t}]`)
    ok((await tool()) === t, `a tap on ${t} picks it`, await tool())
    ok(!(await trayUp()), 'and folds the tray')
    const name = (await box('[data-testid=phone-tool]'))!.text
    ok(new RegExp(t === 'place' ? 'Boost pad' : t, 'i').test(name), 'and the button says so', name)
    if (t === 'place') {
      ok(!!(await box('.phone-card .sre-palette')), 'Place opens on its palette')
      await press('.phone-card .sre-piece')
      ok(!(await box('.phone-card')), 'picking a piece folds the card')
      const named = (await box('[data-testid=phone-tool]'))!.text
      ok(/Boost pad/.test(named) && (await p.page.evaluate(() => !!document.querySelector('[data-testid=phone-tool] svg'))), 'and the tool button names the piece, with its icon', named)
    }
  }

  // The tool's settings live in the tray, in a row above View, and nothing of them sits on the map (P8).
  const row = () => box('[data-testid=phone-tool-row]')
  await press('[data-testid=phone-tool]')
  ok(/Boost pad/.test((await row())?.text ?? ''), "the tray's row names the piece in hand", (await row())?.text)
  const rowAbove = await p.page.evaluate(() => {
    const r = document.querySelector('[data-testid=phone-tool-row]')!.getBoundingClientRect()
    const v = document.querySelector('[data-testid=phone-tray-view]')!.getBoundingClientRect()
    return { rowBottom: r.bottom, viewTop: v.top, h: r.height }
  })
  ok(rowAbove.rowBottom <= rowAbove.viewTop && rowAbove.h >= 44, 'above the View row, big enough for a thumb', rowAbove)
  await press('[data-testid=phone-tool-row]')
  ok(!!(await box('.phone-card .sre-palette')) && !(await trayUp()), 'and opens the palette to change piece')
  await press('[data-testid=phone-done]')
  for (const [t, words] of [['pencil', /Steady hand: \w+/], ['bend', /Reach: \d+ m/], ['straight', /Step 1 of 2/], ['curve', /Step 1 of 3/], ['height', /Pick a stretch/], ['bank', /Pick a stretch/], ['width', /Pick a stretch/]] as const) {
    await press('[data-testid=phone-tool]')
    await press(`[data-testid=phone-tray] [data-rail=${t}]`)
    ok((await tool()) === t && !(await box('.phone-card')), `${t}: picked, and no card yet`)
    await press('[data-testid=phone-tool]')
    ok(words.test((await row())?.text ?? ''), `${t}: the tray's row says its setting`, (await row())?.text)
    await press('[data-testid=phone-tool-row]')
    ok(!!(await box('.phone-card[data-kind=tool]')) && !(await trayUp()), `${t}: the row opens its card`)
    await press('[data-testid=phone-done]')
    // The tool already in your hand opens the same card.
    await press('[data-testid=phone-tool]')
    await press(`[data-testid=phone-tray] [data-rail=${t}]`)
    ok(!!(await box('.phone-card[data-kind=tool]')) && (await tool()) === t, `${t}: tapping the tool you hold opens it too`)
    await press('[data-testid=phone-done]')
  }
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tray] [data-rail=select]')
  await press('[data-testid=phone-tool]')
  ok(!(await row()), 'Select has no setting, so no row')
  await press('[data-testid=phone-tray] [data-rail=select]')
  ok(!(await box('.phone-card')) && !(await trayUp()), 'and tapping it when held just folds the tray')
  await p.ed('tool', 'place')
  await sleep(150)
  await press('.phone-card .sre-piece')

  // A tap on the map with the tray open only closes it: Place in hand, a real road under the finger.
  const spot = await p.roadNear(p.w * 0.62, p.h * 0.5)
  const road0 = await p.road()
  const g0 = await p.g()
  await press('[data-testid=phone-tool]')
  ok(await trayUp(), 'the tray is open again')
  ok(await p.onMap(spot), 'the road spot is on the map, clear of the tray', spot)
  await p.tap(spot)
  await sleep(150)
  ok(!(await trayUp()), 'a tap on the map closes the tray')
  const g1 = await p.g()
  ok(g1.toolStarts === g0.toolStarts && (await p.road()) === road0, 'and the tool never heard: no piece placed', { toolStarts: g1.toolStarts - g0.toolStarts })
  // The same with a drag: Pencil in hand, nothing drawn.
  await p.ed('tool', 'pencil')
  await sleep(150)
  await press('[data-testid=phone-tool]')
  ok(await p.onMap(spot), 'the map again')
  await p.drag(Array.from({ length: 12 }, (_, i) => ({ x: spot.x - i * 4, y: spot.y + i * 2 })))
  ok(!(await trayUp()), 'a finger dragged on the map closes it too')
  ok((await p.road()) === road0, 'and draws nothing', { undo: (await p.sum()).undoSteps, toolStarts: (await p.g()).toolStarts - g0.toolStarts })

  // Two fingers are always the map: with the tray open.
  await press('[data-testid=phone-tool]')
  const free = async () => p.page.evaluate(() => { const l = document.querySelector('.phone-left')!.getBoundingClientRect(); const c = document.querySelector('.phone-card'); const s = (c ?? document.querySelector('.phone-stack'))!.getBoundingClientRect(); return { left: l.right, right: s.left, bottom: l.bottom } })
  // (Clear of the tray, and of the card to come.)
  const midX = 490
  const midY = p.h * 0.45
  const pinchHere = async (what: string) => {
    const g = await p.g()
    const road = await p.road()
    const w = { x: g.view.cx + (midX - p.w / 2) * g.view.mpp, z: g.view.cz + (midY - p.h / 2) * g.view.mpp }
    const path = pinchPath(midX, midY, 60, 120)
    ok(await p.onMap(path.a0) && await p.onMap(path.b0), `${what}: both fingers land on the map`)
    await twoFingers(p, path.a0, path.b0, 30, 14, path.at)
    await sleep(100)
    const g2 = await p.g()
    ok(close(g2.view.mpp / g.view.mpp, 0.5, 0.03), `${what}: a pinch zooms`, { ratio: round(g2.view.mpp / g.view.mpp, 1000) })
    const off = Math.hypot((w.x - g2.view.cx) / g2.view.mpp + p.w / 2 - midX, (w.z - g2.view.cz) / g2.view.mpp + p.h / 2 - midY)
    ok(off <= SPOT_PX + 1, `${what}: at the fingers`, { px: round(off) })
    ok(g2.toolStarts === g.toolStarts && (await p.road()) === road, `${what}: and the tool never heard`, { toolStarts: g2.toolStarts - g.toolStarts })
    return g2
  }
  const dragHere = async (what: string) => {
    const g = await p.g()
    const a0 = { x: midX - 40, y: midY }
    const b0 = { x: midX + 40, y: midY }
    await twoFingers(p, a0, b0, 30, 12, (t) => [{ x: a0.x + 30 * t, y: a0.y + 12 * t }, { x: b0.x + 30 * t, y: b0.y + 12 * t }])
    await sleep(100)
    const g2 = await p.g()
    const dx = (g.view.cx - g2.view.cx) / g.view.mpp
    ok(close(dx, 30, DRAG_PX + 1) && g2.toolStarts === g.toolStarts, `${what}: two fingers drag the map`, { dx: round(dx) })
  }
  await pinchHere('tray open')
  ok(!(await trayUp()), 'and the pinch closed the tray')
  await p.ed('fit')

  // View.
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tray-view]')
  const mpp0 = (await p.g()).view.mpp
  await press('[data-rail=zoomIn]')
  ok(close((await p.g()).view.mpp / mpp0, 1 / 1.4, 0.01), 'Zoom in zooms in', { mpp: (await p.g()).view.mpp })
  ok(await trayUp(), 'and stays open for another tap')
  await press('[data-rail=zoomOut]')
  ok(close((await p.g()).view.mpp / mpp0, 1, 0.01), 'Zoom out puts it back')
  await press('[data-rail=world]')
  ok(!(await trayUp()), 'Whole world folds the tray')
  const inFree = async (points: World[], what: string) => {
    const fr = await free()
    const seen = (await Promise.all(points.map((q) => p.ed('screen', [q.x, q.z])))) as { sx: number; sy: number }[]
    const worst = seen.reduce((m, q) => Math.max(m, fr.left - q.sx, q.sx - fr.right, -q.sy, q.sy - fr.bottom), -Infinity)
    ok(worst <= 1, `${what} fits the free map`, { past: round(worst), mpp: round((await p.g()).view.mpp) })
  }
  await inFree([{ x: -850, z: -850 }, { x: 850, z: -850 }, { x: -850, z: 850 }, { x: 850, z: 850 }], 'the whole world')
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tray-view]')
  await press('[data-rail=fit]')
  await inFree(await p.roadPoints(), 'Fit track: the whole road')
  // And it uses the room: along its tighter side the road nearly fills the free map.
  const fills = async () => {
    const fr2 = await free()
    const seen = (await Promise.all((await p.roadPoints()).map((q) => p.ed('screen', [q.x, q.z])))) as { sx: number; sy: number }[]
    const xs = seen.map((q) => q.sx)
    const ys = seen.map((q) => q.sy)
    return Math.max((Math.max(...xs) - Math.min(...xs)) / (fr2.right - fr2.left), (Math.max(...ys) - Math.min(...ys)) / (fr2.bottom - 6))
  }
  ok((await fills()) >= 0.85, 'and fills it', { share: round(await fills()) })
  // (Where the scale bar sits: scenario 21.)
  // A square track at the shortest window: Afterglow.
  await p.ed('open', 'afterglow')
  await sleep(2500)
  await p.ed('fit')
  await sleep(100)
  await inFree(await p.roadPoints(), 'Afterglow')
  await p.freshRoad()

  // The card: a stretch picked. The map moves over for it, the second finger still works, Fit reads the smaller map.
  await p.ed('tool', 'width')
  await sleep(100)
  const onRoad = await p.roadNear(p.w * 0.4, p.h * 0.5)
  await p.tap(onRoad)
  await sleep(600)
  ok(!!(await box('.phone-card')), 'a stretch picked by a tap opens the card')
  ok(!(await box('[data-testid=editor-test-drive]')), 'over the stack')
  const card = (await box('.phone-card'))!
  ok(card.right <= p.w - inset && card.bottom <= p.h - 20 && card.top >= 0, 'the card fits, clear of the notch and the home bar', card)
  await pinchHere('card open')
  await dragHere('card open')
  await p.ed('fit')
  await sleep(100)
  await inFree(await p.roadPoints(), 'Fit with the card open: the whole road')
  // Its slider: sideways sets it, one Undo step; a swipe up from it scrolls the card and leaves it alone.
  const slider = await p.page.evaluate(() => {
    const r = document.querySelector('.phone-card input[type=range]') as HTMLInputElement
    const b = r.getBoundingClientRect()
    return { y: b.top + b.height / 2, left: b.left, width: b.width, value: Number(r.value), min: Number(r.min), max: Number(r.max) }
  })
  ok(slider.y + 22 <= p.h - 20, 'the slider is on the first screen', slider)
  const thumbX = slider.left + 22 + (slider.width - 44) * ((slider.value - slider.min) / (slider.max - slider.min))
  const undo0 = (await p.sum()).undoSteps
  await p.drag(Array.from({ length: 10 }, (_, i) => ({ x: thumbX + i * 6, y: slider.y })), 16)
  await sleep(400)
  const after = await p.page.evaluate(() => Number((document.querySelector('.phone-card input[type=range]') as HTMLInputElement).value))
  ok(after !== slider.value, 'a sideways drag moves the slider', { from: slider.value, to: after })
  ok((await p.sum()).undoSteps === undo0 + 1, 'one Undo step', { steps: (await p.sum()).undoSteps - undo0 })
  const bodyScroll = () => p.page.evaluate(() => document.querySelector('.phone-card-body')!.scrollTop)
  const canScroll = await p.page.evaluate(() => { const b = document.querySelector('.phone-card-body')!; return b.scrollHeight > b.clientHeight + 8 })
  if (canScroll) {
    await p.drag(Array.from({ length: 10 }, (_, i) => ({ x: thumbX + 50, y: slider.y - i * 7 + 60 })), 16)
    await sleep(300)
    ok((await bodyScroll()) > 4, 'a swipe up scrolls the card', { scrollTop: await bodyScroll() })
    ok((await p.sum()).undoSteps === undo0 + 1, 'and changes nothing')
    await p.page.evaluate(() => { document.querySelector('.phone-card-body')!.scrollTop = 0 })
  }
  await press('[data-testid=phone-done]')
  ok(!(await box('.phone-card')), 'Done closes the card')
  ok(!!(await box('[data-testid=editor-test-drive]')), 'and the stack is back')
  ok((await p.sum()).selection === null, 'and nothing is picked')

  // Undo and Redo, by tap.
  const steps = (await p.sum()).undoSteps
  await press('[data-rail=undo]')
  ok((await p.sum()).undoSteps === steps - 1, 'Undo undoes')
  await press('[data-rail=redo]')
  ok((await p.sum()).undoSteps === steps, 'Redo puts it back')

  // Cancel, for the other thumb, while a finger is on the road. A press, not a click: Chrome sends none for a second finger.
  await p.ed('tool', 'pencil')
  await p.ed('steady', 0)
  await sleep(150)
  // A line that leaves the road and comes back onto it, so it really lands when it is let go: proved first.
  const n = (await p.sum()).points
  const from = (await p.ed('screen', n * 0.2)) as { sx: number; sy: number }
  const to = (await p.ed('screen', n * 0.28)) as { sx: number; sy: number }
  const line = Array.from({ length: 22 }, (_, i) => {
    const t = i / 21
    const bulge = Math.sin(t * Math.PI) * 22
    const len = Math.hypot(to.sx - from.sx, to.sy - from.sy) || 1
    return { x: from.sx + (to.sx - from.sx) * t - ((to.sy - from.sy) / len) * bulge, y: from.sy + (to.sy - from.sy) * t + ((to.sx - from.sx) / len) * bulge }
  })
  const r0 = await p.road()
  const u0 = (await p.sum()).undoSteps
  await p.drag(line, 14)
  await sleep(500)
  ok((await p.sum()).undoSteps === u0 + 1 && (await p.road()) !== r0, 'a line off the road and back lands when it is let go', { undo: (await p.sum()).undoSteps - u0 })
  await p.undoTo(u0)
  await p.down({ ...line[0], id: 1 })
  for (const q of line.slice(1)) {
    await p.move({ ...q, id: 1 })
    await sleep(14)
  }
  await sleep(250)
  const cancel = await box('[data-testid=phone-cancel]')
  ok(!!cancel, 'a finger working the tool: Undo offers Cancel')
  if (cancel) {
    const fin = line[line.length - 1]
    await p.down({ ...fin, id: 1 }, { x: cancel.x, y: cancel.y, id: 2 })
    await sleep(60)
    await p.liftOne({ x: cancel.x, y: cancel.y, id: 2 })
    await sleep(60)
  }
  await p.lift()
  await sleep(400)
  ok((await p.road()) === r0 && (await p.sum()).undoSteps === u0, 'Cancel with the other thumb: the same line is gone', { undo: (await p.sum()).undoSteps - u0 })
  ok(!(await box('[data-testid=phone-cancel]')), 'and Undo is back')
  await p.ed('steady', 2)

  // A half-made Straight: Undo offers Cancel for as long as it is half made, and that is how to start again.
  await p.ed('fit')
  await p.ed('tool', 'straight')
  await sleep(150)
  const straightAt = (await p.ed('screen', (await p.sum()).points * 0.2)) as { sx: number; sy: number }
  await p.tap({ x: straightAt.sx, y: straightAt.sy })
  await sleep(150)
  ok(!!(await p.sum()).shaping, 'a Straight half made')
  ok(!!(await box('[data-testid=phone-cancel]')), 'Undo offers Cancel')
  await press('[data-testid=phone-cancel]')
  await sleep(100)
  ok(!(await p.sum()).shaping && !!(await box('[data-rail=undo]')), 'a tap on it starts again, and Undo is back')

  // One finger only moving the map has nothing to cancel, and the card stays where it is.
  await p.ed('tool', 'select')
  await sleep(150)
  const [emptySpot] = await freeSpots(p, 1)
  const hold = async (from: Spot, path: (i: number) => Spot) => {
    await p.down({ ...from, id: 1 })
    for (let i = 1; i <= 8; i++) {
      await p.move({ ...path(i), id: 1 })
      await sleep(14)
    }
    await sleep(250)
  }
  await hold(emptySpot, (i) => ({ x: emptySpot.x + i * 4, y: emptySpot.y }))
  ok((await p.g()).phase === 'tool', 'a finger moving the map')
  ok(!(await box('[data-testid=phone-cancel]')) && !!(await box('[data-rail=undo]')), 'Undo stays Undo, there is nothing to cancel')
  await p.lift()
  await sleep(150)
  await p.ed('fit')
  await p.ed('tool', 'width')
  await sleep(150)
  const stretchSpot = await p.roadNear(p.w * 0.4, p.h * 0.5)
  await p.tap(stretchSpot)
  await sleep(600)
  ok(!!(await box('.phone-card')), 'a card up for a stretch')
  const [offRoadSpot] = await freeSpots(p, 1)
  ok(await p.onMap(offRoadSpot), 'with an empty spot of map beside it')
  const cxBefore = (await p.g()).view.cx
  await hold(offRoadSpot, (i) => ({ x: offRoadSpot.x + i * 4, y: offRoadSpot.y }))
  ok((await p.g()).view.cx !== cxBefore, 'one finger off the road moves the map')
  ok(!!(await box('.phone-card')), 'and the card stays up')
  await p.lift()
  await sleep(200)
  const onStretch = await p.roadNear(p.w * 0.4, p.h * 0.5)
  ok(await p.onMap(onStretch), 'the road, beside the card')
  await hold(onStretch, (i) => ({ x: onStretch.x + i, y: onStretch.y + i }))
  ok(!(await box('.phone-card')), 'a finger working on the road: the card steps aside, the map only')
  ok(!!(await box('[data-testid=phone-cancel]')), 'and Undo offers Cancel')
  await p.lift()
  await sleep(350)
  ok(!!(await box('.phone-card')), 'and it comes back when the finger lifts')
  await press('[data-testid=phone-done]')

  // The Menu.
  await press('[data-testid=phone-menu-open]')
  ok(!!(await box('[data-testid=phone-menu]')), 'Menu opens')
  ok(!!(await box('[data-testid=phone-menu-back]')), 'with a way back on its first screen')
  await press('[data-testid=phone-menu-back]')
  ok(!(await box('[data-testid=phone-menu]')), 'and Back to the map closes it')
  await p.hidePanels(true)
}

/**
 * 21. Nathan: "Move the scale up to the top left on the editor. Try to keep the track field clear". The bar is
 * read off the map's own canvas, so it can't pass by a number alone. And picking a tool says one short line.
 */
async function scaleAndWords(p: Phone) {
  await p.hidePanels(false)
  await p.freshRoad()
  await p.ed('tool', 'pencil')
  await sleep(300)
  type V = { scaleTop: number | null; scaleX: number; scaleBox: { x0: number; y0: number; x1: number; y1: number; lineY: number; lineX1: number } }
  const scale = async () => (await p.ed('view')) as V
  /** How much of a level line on the map's canvas is drawn in, 0 to 1. */
  const inked = (x0: number, x1: number, y: number) =>
    p.page.evaluate(
      (a: number, b: number, c: number) => {
        const cv = document.querySelector('.sre-overlay') as HTMLCanvasElement
        const k = cv.width / innerWidth
        const w = Math.max(1, Math.round((b - a) * k))
        const d = cv.getContext('2d')!.getImageData(Math.round(a * k), Math.round(c * k) - 2, w, 5).data
        let hit = 0
        for (let i = 0; i < w; i++) {
          let any = false
          for (let r = 0; r < 5; r++) if (d[(r * w + i) * 4 + 3] > 150) any = true
          if (any) hit++
        }
        return hit / w
      },
      x0,
      x1,
      y,
    )
  const box = (sel: string) =>
    p.page.evaluate((s: string) => {
      const e = document.querySelector(s)
      if (!e || !(e as HTMLElement).checkVisibility()) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, sel)
  const v = await scale()
  ok(v.scaleTop !== null, 'the scale bar is told to sit at the top', v.scaleTop)
  ok(v.scaleBox.y1 <= p.h / 4, 'it is at the top of the map', v.scaleBox)
  ok(v.scaleBox.y0 >= 0 && v.scaleBox.x0 >= 62, 'clear of the top edge and the notch', v.scaleBox)
  const left = (await box('.phone-left'))!
  ok(v.scaleBox.x0 <= left.right, 'at the left, over the tool button column', { x0: v.scaleBox.x0, column: left.right })
  ok(v.scaleBox.x1 <= 240, 'and short: it ends well before the middle of the map', { x1: v.scaleBox.x1 })
  ok((await inked(v.scaleBox.x0 + 2, v.scaleBox.lineX1 - 2, v.scaleBox.lineY)) >= 0.9, 'the line really is drawn up there', { share: await inked(v.scaleBox.x0 + 2, v.scaleBox.lineX1 - 2, v.scaleBox.lineY) })
  ok((await inked(left.right + 14, left.right + 14 + (v.scaleBox.lineX1 - v.scaleBox.x0), left.bottom - 6)) < 0.6, 'and not where it used to be, along the bottom', { share: await inked(left.right + 14, left.right + 14 + (v.scaleBox.lineX1 - v.scaleBox.x0), left.bottom - 6) })
  // The other thumb's row keeps its place by the tool button now the bar has gone from there.
  const [emptySpot] = await freeSpots(p, 1)
  await p.down({ ...emptySpot, id: 1 })
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: emptySpot.x + i * 5, y: emptySpot.y, id: 1 })
    await sleep(14)
  }
  await sleep(100)
  const thumb = await box('.sre-thumb')
  ok(!!thumb && Math.abs(thumb.bottom - left.bottom) <= 1, 'Straight line sits level with the tool button', thumb)
  await p.cancel()
  await sleep(300)

  // Picking a tool says one short line, in a thumb's words.
  const press = async (sel: string) => {
    const b = await box(sel)
    if (!b) return ok(false, `${sel} is there to press`)
    await p.tap({ x: b.x, y: b.y })
    await sleep(80)
  }
  const said = () => p.page.evaluate(() => (window as unknown as { __game: { get(k: string): string | null } }).__game.get('editorMsg') ?? '')
  const lines = () =>
    p.page.evaluate(() => {
      const e = document.querySelector('.sre-status')
      if (!e) return 0
      const r = document.createRange()
      r.selectNodeContents(e)
      return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size
    })
  for (const t of TOOLS) {
    await p.ed('tool', t === 'select' ? 'pencil' : 'select')
    await sleep(120)
    await press('[data-testid=phone-tool]')
    await press(`[data-testid=phone-tray] [data-rail=${t}]`)
    await sleep(120)
    const words = await said()
    ok(words.length > 10 && words.length <= 52, `${t}: picking it says about 50 letters`, words)
    ok(!/click|mouse|panel|shift|esc\b|wheel|press/i.test(words), `${t}: in a thumb's words`, words)
    ok((await lines()) === 1, `${t}: on one line`, { lines: await lines() })
    if (t === 'place') await p.page.evaluate(() => (document.querySelector('[data-testid=phone-done]') as HTMLElement | null)?.click())
  }
  // The full explanation is still the tool's card.
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tray] [data-rail=height]')
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tool-row]')
  const card = await p.page.evaluate(() => document.querySelector('.phone-card')?.textContent ?? '')
  ok(/Drag along the road/.test(card) && /A tunnel needs a long stretch of plain road/.test(card), "the full words are on the tool's card", card.slice(0, 80))
  await press('[data-testid=phone-done]')
  // On the empty map too.
  await p.ed('newTrackNow')
  await sleep(300)
  await press('[data-testid=phone-tool]')
  await press('[data-testid=phone-tray] [data-rail=height]')
  await sleep(120)
  ok(/no road yet/.test(await said()) && (await lines()) === 1, 'on an empty map it says so, on one line', await said())
  await p.freshRoad()
  await p.hidePanels(true)
}

/** 21, a computer: the bar along the bottom at 96 px, as ever, and the long words. */
async function scaleOnDesktop() {
  const p = await openDesktop()
  await p.freshRoad()
  await sleep(300)
  const v = (await p.ed('view')) as { scaleTop: number | null; scaleBox: { x0: number; y1: number; lineY: number; lineX1: number } }
  ok(v.scaleTop === null && v.scaleBox.x0 === 96 && v.scaleBox.lineY === p.h - 28, 'a computer: the scale bar along the bottom, 96 px in', v)
  ok(v.scaleBox.lineX1 - v.scaleBox.x0 >= 80, 'and at least 80 px long', v.scaleBox)
  const b = await p.page.evaluate(() => {
    const r = document.querySelector('[data-rail=height]')!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await p.page.mouse.click(b.x, b.y)
  await sleep(150)
  const words = (await p.page.evaluate(() => (window as unknown as { __game: { get(k: string): string | null } }).__game.get('editorMsg'))) ?? ''
  ok(/drag along the road/.test(words) && /A tunnel needs a long stretch of plain road/.test(words), "and Height's long tip", words.slice(0, 60))
  await p.page.close()
}

/**
 * 22. The tunnel's footprint is a lot to put on the road, so a thumb only sees it while held on Make it a tunnel.
 * Finger down previews, finger up on the button acts, sliding off lets go, and what can't fit does nothing.
 */
async function tunnelHold(p: Phone) {
  await p.hidePanels(false)
  await p.freshRoad()
  const box = () =>
    p.page.evaluate(() => {
      const e = document.querySelector('[data-testid=editor-make-tunnel]')
      if (!e || !(e as HTMLElement).checkVisibility()) return null
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
  const footprint = async () => (await p.sum()).tunnelPreview
  const why = () => p.page.evaluate(() => document.querySelector('[data-testid=editor-tunnel-why]')?.textContent ?? null)
  const n = (await p.sum()).points
  let fits: number | null = null
  let noFit: number | null = null
  for (let i = 0; i < 28 && (fits === null || noFit === null); i++) {
    const at = ((i + 0.5) / 28) * n
    await p.ed('pickStretch', ['height', at])
    await sleep(350)
    if (!(await box())) continue
    if (await why()) noFit ??= at
    else fits ??= at
  }
  ok(fits !== null && noFit !== null, 'a stretch a tunnel fits on, and one it does not', { fits, noFit })
  if (fits === null || noFit === null) return
  const pick = async (at: number) => {
    await p.ed('pickStretch', ['height', at])
    await sleep(400)
    return (await box())!
  }
  // Picking a stretch: the road stays clear.
  let b = await pick(fits)
  ok(!(await footprint()), 'a stretch picked, its card open: no footprint on the road', await footprint())
  const before = await p.sum()
  const same = async () => {
    const now = await p.sum()
    return now.pieces === before.pieces && now.undoSteps === before.undoSteps
  }
  // Held: it shows, however long the hold, and nothing is done.
  await p.down({ x: b.x, y: b.y, id: 1 })
  await sleep(120)
  ok(!!(await footprint()), 'a thumb held on the button: the footprint shows', await footprint())
  await sleep(800)
  ok(!!(await footprint()) && (await same()), 'for as long as it is held, and nothing is done yet')
  // Slid off: it goes, and the lift does nothing.
  for (let i = 1; i <= 6; i++) {
    await p.move({ x: b.x - i * 34, y: b.y, id: 1 })
    await sleep(16)
  }
  await sleep(60)
  ok(!(await footprint()), 'slid off the button: it goes')
  await p.lift()
  await sleep(250)
  ok((await same()) && !(await footprint()), 'and the lift does nothing: that is how to look without doing')
  // Up the card: the card's own scroll, and nothing is done.
  b = (await box())!
  await p.drag(Array.from({ length: 9 }, (_, i) => ({ x: b.x, y: b.y - i * 8 })), 14)
  await sleep(250)
  ok((await same()) && !(await footprint()), 'a swipe up from the button does nothing either')
  await p.page.evaluate(() => {
    const c = document.querySelector('.phone-card-body')
    if (c) c.scrollTop = 0
  })
  // Can't fit: it shows, the words say why with no promise of another spot, and the lift does nothing.
  b = await pick(noFit)
  const words = (await why()) ?? ''
  ok(/won't fit/.test(words) && !/nearest spot/.test(words), "where it can't fit the words say so, and promise nothing else", words.slice(0, 70))
  const beforeNoFit = await p.sum()
  await p.down({ x: b.x, y: b.y, id: 1 })
  await sleep(700)
  ok(!!(await footprint()), "held where it can't fit: the footprint shows")
  await p.lift()
  await sleep(400)
  const afterNoFit = await p.sum()
  ok(afterNoFit.pieces === beforeNoFit.pieces && afterNoFit.undoSteps === beforeNoFit.undoSteps && !(await footprint()), "and the lift does nothing", { pieces: afterNoFit.pieces - beforeNoFit.pieces })
  // Let go on it, after a hold and after a quick tap: it acts, once. Each is one Undo step.
  for (const [label, holdMs] of [['a long hold', 800], ['a quick tap', 40]] as const) {
    b = await pick(fits)
    const u0 = await p.sum()
    await p.down({ x: b.x, y: b.y, id: 1 })
    await sleep(holdMs)
    await p.lift()
    await sleep(900)
    const u1 = await p.sum()
    ok(u1.pieces === u0.pieces + 1 && u1.undoSteps === u0.undoSteps + 1 && !u1.tunnelPreview, `${label}, let go on the button: a tunnel, once`, { pieces: u1.pieces - u0.pieces, undo: u1.undoSteps - u0.undoSteps })
    await p.undoTo(u0.undoSteps)
    await sleep(500)
  }
  await p.ed('tool', 'select')
  await p.hidePanels(true)
}

/** 22, a computer: hovering shows the footprint as it always has, and a click acts. */
async function tunnelHoverDesktop() {
  const p = await openDesktop()
  await p.freshRoad()
  const n = (await p.sum()).points
  const spot = () => p.page.evaluate(() => {
    const e = document.querySelector('[data-testid=editor-make-tunnel]')
    const fits = !document.querySelector('[data-testid=editor-tunnel-why]')
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, fits }
  })
  let b: Awaited<ReturnType<typeof spot>> = null
  for (let i = 0; i < 28; i++) {
    await p.ed('pickStretch', ['height', ((i + 0.5) / 28) * n])
    await sleep(350)
    b = await spot()
    if (b?.fits) break
  }
  ok(!!b?.fits, 'a stretch a tunnel fits on', b)
  if (!b) return
  await p.page.mouse.move(40, 40)
  await sleep(100)
  ok(!(await p.sum()).tunnelPreview, 'a computer: no footprint until the mouse is over the button')
  await p.page.mouse.move(b.x, b.y)
  await sleep(150)
  ok(!!(await p.sum()).tunnelPreview, 'hovering shows it')
  await p.page.mouse.move(40, 40)
  await sleep(150)
  ok(!(await p.sum()).tunnelPreview, 'leaving takes it away')
  const u0 = await p.sum()
  await p.page.mouse.click(b.x, b.y)
  await sleep(900)
  const u1 = await p.sum()
  ok(u1.pieces === u0.pieces + 1 && u1.undoSteps === u0.undoSteps + 1, 'a click acts, once', { pieces: u1.pieces - u0.pieces, undo: u1.undoSteps - u0.undoSteps })
  await p.page.close()
}

/** 11. The world map goes through the same handlers: pinch works there too, and one finger still pans. */
async function worldMap(name: string) {
  const p = await openPhone(name, 'track=afterglow&mode=free&touch=1&nomusic=1&quality=low')
  await sleep(4000)
  await p.page.evaluate(() => (window as unknown as { __dev: { ui(s: string): void } }).__dev.ui('pause'))
  await sleep(800)
  await p.ed('map')
  await sleep(1500)
  const s = await p.sum()
  ok(s.mode === 'map', 'the world map is open', s.mode)
  ok(await p.page.evaluate(() => { const e = document.querySelector('.sre'); return !!e && e.hasAttribute('data-map-touch') && !e.hasAttribute('data-touch') }), "it keeps its own phone layout, not the editor's")
  await p.hidePanels(true)
  await p.page.screenshot({ path: `${OUT}/${windowName}-11-map.png` })
  const cx = (p.w - 200) / 2
  const cy = p.h / 2
  const g0 = await p.g()
  const W = { x: g0.view.cx + (cx - p.w / 2) * g0.view.mpp, z: g0.view.cz + (cy - p.h / 2) * g0.view.mpp }
  const path = pinchPath(cx, cy, 100, 200)
  await twoFingers(p, path.a0, path.b0, 30, 14, path.at)
  await sleep(100)
  const g1 = await p.g()
  ok(close(g1.view.mpp / g0.view.mpp, 0.5, 0.02), 'a pinch zooms', { ratio: round(g1.view.mpp / g0.view.mpp, 1000) })
  const off = Math.hypot((W.x - g1.view.cx) / g1.view.mpp + p.w / 2 - cx, (W.z - g1.view.cz) / g1.view.mpp + p.h / 2 - cy)
  ok(off <= SPOT_PX, 'at the fingers', { px: round(off) })
  const dragPath = Array.from({ length: 16 }, (_, i) => ({ x: cx + i * 5, y: cy + i * 2 }))
  await p.drag(dragPath)
  const g2 = await p.g()
  const movedX = (g1.view.cx - g2.view.cx) / g1.view.mpp
  const movedY = (g1.view.cz - g2.view.cz) / g1.view.mpp
  ok(close(movedX, 75, DRAG_PX) && close(movedY, 30, DRAG_PX), 'one finger pans, all of its path', { movedX: round(movedX), movedY: round(movedY) })
  await p.page.close()
}

/**
 * 12. A road with a "near point" warning, then New track, by finger or by mouse. The old warnings
 * are still in the store when the road goes, and the Checks list worked out a spot on a road with
 * no points: that blanked the whole editor, on a computer too.
 */
async function newTrackOverWarnings(p: Phone, input: 'finger' | 'mouse') {
  const m = p.page.mouse
  const stroke = async (path: Spot[]) => {
    if (input === 'finger') return p.drag(path, 14)
    await m.move(path[0].x, path[0].y)
    await m.down()
    for (const q of path.slice(1)) {
      await m.move(q.x, q.y)
      await sleep(14)
    }
    await m.up()
    await sleep(80)
  }
  const press = async (s: Spot) => {
    if (input === 'finger') await p.tap(s)
    else await m.click(s.x, s.y)
    await sleep(200)
  }
  /** A real tap or click on a real button (the rail scrolls on a phone, so bring it into view first). */
  const pressEl = async (sel: string, text?: string) => {
    const at = await p.page.evaluate(
      (q: string, t: string | null) => {
        const e = [...document.querySelectorAll<HTMLElement>(q)].find((b) => t === null || b.textContent?.includes(t))
        if (!e) return null
        e.scrollIntoView({ block: 'nearest' })
        const r = e.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      sel,
      text ?? null,
    )
    if (at) await press(at)
    return !!at
  }
  const alive = () => p.page.evaluate(() => !!document.querySelector('[data-testid=editor-ui]') && !!document.querySelector('.sre-overlay'))
  /**
   * Real pencil lines that come back with tight corners or low crossings: which one does depends on the window's
   * zoom (metres a pixel decides where the line's points fall), so try them until the road has a "near point" warning.
   */
  const warnedRoad = async () => {
    const lines: [number, number][][] = [
      Array.from({ length: 31 }, (_, i): [number, number] => [-700 + i * 12.8, i * 0.8]),
      Array.from({ length: 40 }, (_, i): [number, number] => [-700 + i * 30, i * 2]),
      Array.from({ length: 60 }, (_, i): [number, number] => [-500 + i * 16, (i % 10 < 5 ? (i % 10) * 14 : (10 - i % 10) * 14) - 30]),
    ]
    for (const line of lines) {
      await p.ed('newTrackNow')
      await p.ed('fit')
      // A phone's empty map frames the whole world in its free part, and a coarser zoom smooths these lines clean away.
      if (input === 'finger') await p.ed('view', [0, 0, 4])
      await p.ed('tool', 'pencil')
      await p.ed('steady', 0)
      await sleep(500)
      const path: Spot[] = []
      for (const [x, z] of line) {
        const s = (await p.ed('screen', [x, z])) as { sx: number; sy: number }
        path.push({ x: s.sx, y: s.sy })
      }
      await stroke(path)
      await sleep(1000)
      const warned = await p.sum()
      if (warned.warnings.some((w: string) => /near point/.test(w))) return warned.warnings as string[]
    }
    return []
  }
  const steady0 = (await p.sum()).steady
  await p.hidePanels(true)
  const warnings = await warnedRoad()
  ok(warnings.length > 0, 'the road has a near point warning', warnings.slice(0, 1))

  // The real thing: the rail's New track, and Don't save.
  await p.hidePanels(false)
  await sleep(100)
  if (input === 'finger') ok(await pressEl('[data-testid=phone-menu-open]'), 'the Menu is there')
  ok(await pressEl('[data-rail=newTrack]'), input === 'finger' ? 'the Menu has New track' : 'the rail has New track')
  const asked = (await p.ed('ask')) as { open: boolean }
  if (asked.open) ok(await pressEl('[data-testid="editor-ask"] button', "Don't save"), "the question has Don't save")
  await sleep(700)
  ok(await alive(), 'the editor is still there: the UI root and the map layer')
  await p.page.screenshot({ path: `${OUT}/${windowName}-12-new-track.png` })
  if (!(await alive())) return
  const fresh = await p.sum()
  ok(fresh.empty && fresh.points === 0, 'the map is empty', { points: fresh.points, empty: fresh.empty })
  ok(fresh.tool === 'pencil', 'Pencil in hand', fresh.tool)

  // Undo brings the warned road back; into 3D with it, and New track from there too (the pins' list goes through the same code).
  await p.ed('undo')
  await sleep(1000)
  ok((await p.sum()).points > 0, 'undo brings the warned road back', { points: (await p.sum()).points })
  await p.look('open')
  await sleep(1600)
  await p.ed('newTrackNow')
  await sleep(900)
  ok(await alive(), 'New track in 3D: the editor stays up')
  if (!(await alive())) return
  await p.look('close')
  await sleep(1200)
  const s = await p.sum()

  // The new road draws.
  await p.hidePanels(true)
  await p.ed('steady', steady0)
  await p.ed('fit')
  await sleep(150)
  const undo0 = s.undoSteps
  const loop: Spot[] = []
  for (let i = 0; i <= 80; i++) {
    const t = (i / 80) * Math.PI * 2
    loop.push({ x: p.w / 2 + p.w * 0.25 * Math.cos(t), y: p.h / 2 + p.h * 0.33 * Math.sin(t) })
  }
  await stroke(loop)
  await sleep(700)
  const drawn = await p.sum()
  ok(drawn.points > 10 && drawn.undoSteps === undo0 + 1, 'the new road draws', { points: drawn.points, undo: drawn.undoSteps - undo0 })
  ok(await alive(), 'and the editor is still up')
  await p.page.screenshot({ path: `${OUT}/${windowName}-12-new-road.png` })

  // Undo taking the road away part way through a press: nothing may throw (a page error fails this scenario).
  const pickPiece = (label: string) =>
    p.page.evaluate((t: string) => {
      ;[...document.querySelectorAll<HTMLElement>('.sre-palette button')].find((b) => b.textContent?.includes(t))?.click()
    }, label)
  const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
  for (const [tool, label] of [['place', 'Wall ride (left)'], ['place', 'Tunnel'], ['height', null], ['bank', null], ['select', null]] as const) {
    await p.ed('tool', tool)
    if (label) await pickPiece(label)
    await sleep(120)
    if (input === 'finger') {
      await p.down({ ...spot, id: 1 })
      await sleep(120)
    } else {
      await m.move(spot.x, spot.y)
      await m.down()
    }
    await p.ed('undo')
    await sleep(80)
    for (let i = 1; i <= 8; i++) {
      if (input === 'finger') await p.move({ x: spot.x + i * 4, y: spot.y + i * 2, id: 1 })
      else await m.move(spot.x + i * 4, spot.y + i * 2)
      await sleep(16)
    }
    if (input === 'finger') await p.lift()
    else await m.up()
    await sleep(120)
    ok(await alive(), `${label ?? tool}: Undo mid-press takes the road away, the editor stays up`)
    await p.ed('redo')
    await sleep(120)
  }
  await p.ed('tool', 'select')
}

// ---------------------------------------------------------------- piece 2: the tools under a finger

type TouchView = {
  fingerDown: boolean
  pointerX: number
  pointerY: number
  shape: { marks: World[]; pull: World | null; preview: World[]; ok: boolean } | null
  ghost: { kind: string; at: World; wall?: unknown; tunnel?: unknown } | null
  lift: number
  pendingLifts: number
  commits: number
}
const touchOf = async (p: Phone) => (await p.g()).touch as TouchView
const message = (p: Phone) => p.page.evaluate(() => (window as unknown as { __game: { get(k: string): unknown } }).__game.get('editorMsg') as string | null)
/** Pick a piece to place by its number key. */
const pickPieceKey = async (p: Phone, digit: string) => {
  await p.page.keyboard.press(`Digit${digit}`)
  await sleep(80)
}
/** Wait until the tool has heard the finger (after an Undo the page can be busy for a moment, and the arm timer waits its turn), then a beat. */
const toolHeard = async (p: Phone) => {
  for (let i = 0; i < 150 && (await p.g()).phase !== 'tool'; i++) await sleep(20)
  await sleep(60)
}
/** Spots on the map well away from the road and from each other, the emptiest first (to put things on, and to tap to let go of a pick). */
const freeSpots = async (p: Phone, want = 3, xMax = Math.min(p.w - 270, 520), xMin = 280): Promise<Spot[]> => {
  const n = (await p.sum()).points
  const shown: Spot[] = []
  for (let i = 0; i < n * 4; i++) {
    const s = (await p.ed('screen', i / 4)) as { sx: number; sy: number }
    shown.push({ x: s.sx, y: s.sy })
  }
  const cands: { x: number; y: number; d: number }[] = []
  // (Inside the world, which fills the middle of the screen when the map is fitted: a prop outside it is a problem, with a pin that would take the finger.)
  for (let x = xMin; x < xMax; x += 10)
    for (let y = 60; y < p.h - 70; y += 10) cands.push({ x, y, d: Math.min(...shown.map((q) => Math.hypot(q.x - x, q.y - y))) })
  cands.sort((a, b) => b.d - a.d)
  const out: Spot[] = []
  for (const c of cands) {
    if (c.d < 45) break
    if (out.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > 110)) out.push({ x: c.x, y: c.y })
    if (out.length >= want) break
  }
  return out
}
const screenOf = async (p: Phone, at: number): Promise<Spot> => {
  const s = (await p.ed('screen', at)) as { sx: number; sy: number }
  return { x: s.sx, y: s.sy }
}

/** 13. Straight and Curve: a finger down previews, sliding moves the preview, lifting does it; a cancel leaves nothing; no false warning. */
async function shapesOnLift(p: Phone) {
  await p.freshRoad()
  const n = (await p.sum()).points
  const quiet = async (label: string, before: Awaited<ReturnType<Phone['sum']>>, road0: string) => {
    const after = await p.sum()
    ok(after.undoSteps === before.undoSteps && (await p.road()) === road0, `${label}: no Undo step, road unchanged`, { undo: after.undoSteps - before.undoSteps })
  }
  // ---- Straight: find two ends that make a legal straight (a corner too tight is refused, which is not what this checks).
  await p.ed('tool', 'straight')
  let a: Spot & { at: number } | null = null
  let b: Spot | null = null
  for (let k = 0; k < n && !b; k++) {
    const at = k + 0.5
    for (const len of [2.5, 2, 1.5, 1]) {
      const A = await screenOf(p, at)
      const B = await screenOf(p, (at + len) % n)
      if (A.x < 130 || B.x < 130 || A.x > p.w - 220 || B.x > p.w - 220 || A.y < 40 || B.y < 40 || A.y > p.h - 50 || B.y > p.h - 50) continue
      await p.tap(A)
      await p.down({ ...B, id: 1 })
      await toolHeard(p)
      const sh = (await touchOf(p)).shape
      await p.cancel()
      await sleep(100)
      await p.ed('tool', 'pencil')
      await p.ed('tool', 'straight')
      if (sh?.ok && sh.preview.length > 3) {
        a = { ...A, at }
        b = B
        break
      }
    }
  }
  ok(!!a && !!b, 'a legal straight to try', { a, b })
  if (!a || !b) return
  await p.ed('tool', 'pencil')
  await p.ed('tool', 'straight')
  let before = await p.sum()
  let road0 = await p.road()
  let g0 = await p.g()
  await p.down({ ...a, id: 1 })
  await toolHeard(p)
  let t = await touchOf(p)
  ok(t.fingerDown && t.shape?.marks.length === 1, 'straight: a finger down previews the start', { marks: t.shape?.marks.length })
  ok(Math.hypot(t.pointerX - a.x, t.pointerY - a.y) < 0.5, 'straight: the pointer is where the finger pressed', { x: t.pointerX, y: t.pointerY })
  ok((await p.sum()).shaping === null, 'straight: the press itself did nothing yet')
  await quiet('straight, first press', before, road0)
  await p.lift()
  await sleep(150)
  let s = await p.sum()
  t = await touchOf(p)
  ok(s.shaping?.tool === 'straight' && Math.abs(s.shaping.a - a.at) < 0.3, 'straight: lifting puts the first end in', s.shaping)
  ok(t.commits - ((g0.touch as TouchView).commits) === 1 && !t.fingerDown, 'straight: one commit, finger up')
  ok(Math.hypot(t.pointerX - a.x, t.pointerY - a.y) < 0.5, 'straight: lifting does not wipe the pointer', { x: t.pointerX, y: t.pointerY })
  // The second end: press shows the straight, sliding moves it, lifting does it.
  road0 = await p.road()
  before = await p.sum()
  await p.down({ ...b, id: 1 })
  await toolHeard(p)
  t = await touchOf(p)
  ok(t.shape?.marks.length === 2 && (t.shape?.preview.length ?? 0) > 3, 'straight: pressing the far end previews the straight', { marks: t.shape?.marks.length, preview: t.shape?.preview.length })
  const prev0 = JSON.stringify(t.shape?.preview)
  await quiet('straight, preview', before, road0)
  const further = await screenOf(p, (a.at + 3.5) % n)
  const stepTo = (from: Spot, to: Spot, i: number, of: number) => ({ x: from.x + ((to.x - from.x) * i) / of, y: from.y + ((to.y - from.y) * i) / of, id: 1 })
  for (let i = 1; i <= 10; i++) {
    await p.move(stepTo(b, further, i, 10))
    await sleep(14)
  }
  await sleep(120)
  t = await touchOf(p)
  ok(JSON.stringify(t.shape?.preview) !== prev0, 'straight: sliding moves the preview', { points: t.shape?.preview.length })
  await quiet('straight, slid', before, road0)
  await p.cancel()
  await sleep(150)
  await quiet('straight, cancelled', before, road0)
  ok((await p.sum()).shaping?.tool === 'straight', 'straight: the first end is still in after a cancel')
  // Press, slide off the road, lift: nothing happens, it says what to do.
  const off = await offRoad(p)
  await p.down({ ...b, id: 1 })
  await toolHeard(p)
  if (off) await p.move({ ...off, id: 1 })
  await sleep(60)
  await p.lift()
  await sleep(150)
  await quiet('straight, lifted off the road', before, road0)
  ok(/Click on the road/.test((await message(p)) ?? ''), 'straight: lifted off the road says where to click', await message(p))
  // The real thing: press the far end, slide, lift.
  await p.down({ ...b, id: 1 })
  await toolHeard(p)
  for (let i = 1; i <= 6; i++) {
    await p.move(stepTo(b, further, i, 12))
    await sleep(14)
  }
  const landed = stepTo(b, further, 6, 12)
  await p.lift()
  await sleep(250)
  s = await p.sum()
  ok(s.undoSteps === before.undoSteps + 1 && (await p.road()) !== road0, 'straight: lifting makes it straight, one Undo step', { undo: s.undoSteps - before.undoSteps, at: landed })
  ok(s.shaping === null, 'straight: the shape is finished')
  await p.page.screenshot({ path: `${OUT}/${windowName}-13-straight.png` })

  // ---- Curve: two taps, then press, pull, lift.
  await p.freshRoad()
  await p.ed('tool', 'curve')
  let c1: Spot = { x: 0, y: 0 }
  let c2: Spot = c1
  for (const [k, len] of [[1.5, 16], [20.5, 16], [40.5, 16], [60.5, 16], [80.5, 16], [100.5, 16], [10.5, 24], [50.5, 24], [90.5, 24]] as const) {
    c1 = await screenOf(p, k % n)
    c2 = await screenOf(p, (k + len) % n)
    if (c1.x < 130 || c2.x < 130 || c1.x > p.w - 220 || c2.x > p.w - 220 || c1.y < 40 || c2.y < 40 || c1.y > p.h - 50 || c2.y > p.h - 50) continue
    if (Math.hypot(c1.x - c2.x, c1.y - c2.y) < 55) continue
    await p.tap(c1)
    await p.tap(c2)
    if ((await p.sum()).shaping?.b != null) break
    await p.ed('tool', 'pencil')
    await p.ed('tool', 'curve')
  }
  const sh2 = (await p.sum()).shaping
  ok(sh2?.tool === 'curve' && sh2.b != null, 'curve: two taps are in', sh2)
  await sleep(350)
  const said = (await message(p)) ?? ''
  ok(!/edge of the world/.test(said), 'curve: no false "off the edge of the world" after two taps', said)
  before = await p.sum()
  road0 = await p.road()
  const mid = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 }
  // A pull the car can take: the nearer the chord, the gentler. Press at each in turn until the preview says it will do.
  let pull1 = mid
  let found = false
  for (const off of [3, 6, 10, 16, 24, 36, -6, -12, -20]) {
    pull1 = { x: mid.x + off * 0.6, y: mid.y - off * 0.8 }
    await p.down({ ...pull1, id: 1 })
    await toolHeard(p)
    found = ((await touchOf(p)).shape?.ok ?? false) && ((await touchOf(p)).shape?.preview.length ?? 0) > 3
    if (found) break
    await p.cancel()
    await sleep(100)
  }
  ok(found, 'curve: a pull the preview likes', { pull1, c1, c2, said: await message(p), shape: (await touchOf(p)).shape ? { ok: (await touchOf(p)).shape!.ok, pull: (await touchOf(p)).shape!.pull, pv: (await touchOf(p)).shape!.preview.length } : null })
  if (!found) return
  const pull2 = { x: pull1.x + 4, y: pull1.y - 3 }
  t = await touchOf(p)
  ok(t.shape?.pull != null, 'curve: pressing shows the curve through the finger', { preview: t.shape?.preview.length })
  const cp0 = JSON.stringify(t.shape?.preview)
  await quiet('curve, preview', before, road0)
  for (let i = 1; i <= 8; i++) {
    await p.move(stepTo(pull1, pull2, i, 8))
    await sleep(14)
  }
  await sleep(120)
  t = await touchOf(p)
  ok(JSON.stringify(t.shape?.preview) !== cp0, 'curve: sliding pulls the curve', {})
  const okNow = t.shape?.ok ?? false
  await p.lift()
  await sleep(250)
  s = await p.sum()
  ok(okNow && s.undoSteps === before.undoSteps + 1 && (await p.road()) !== road0 && s.shaping === null, 'curve: lifting makes the curve, one Undo step', { okNow, undo: s.undoSteps - before.undoSteps })
  await p.ed('tool', 'select')
}

/** 14. Place: the piece shows under the finger, slides with it, goes down where the finger lifts; a cancel leaves nothing. */
async function placeOnLift(p: Phone) {
  await p.page.evaluate(() => {
    const w = window as unknown as { __ev: string[] }
    w.__ev = []
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'pointerleave']) document.querySelector('.sre-overlay')!.addEventListener(t, (e) => w.__ev.push(`${t}:${(e as PointerEvent).pointerId}@${Math.round((e as PointerEvent).clientX)},${Math.round((e as PointerEvent).clientY)}`))
  })
  await p.freshRoad()
  await p.ed('fit')
  const road = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const slide = (from: Spot, to: Spot, i: number, of: number) => ({ x: from.x + ((to.x - from.x) * i) / of, y: from.y + ((to.y - from.y) * i) / of, id: 1 })
  await pickPieceKey(p, '1')
  ok((await p.sum()).tool === 'place', 'place: the Boost pad is in hand')
  const before = await p.sum()
  const road0 = await p.road()
  await p.down({ ...road, id: 1 })
  await toolHeard(p)
  let t = await touchOf(p)
  ok(t.ghost?.kind === 'boost', 'place: pressing shows the piece', t.ghost?.kind)
  ok((await p.sum()).pieces === before.pieces && (await p.sum()).undoSteps === before.undoSteps, 'place: the press itself placed nothing')
  const at0 = t.ghost?.at
  const slideTo = await screenOf(p, (road.at + 10) % before.points)
  for (let i = 1; i <= 8; i++) {
    await p.move(slide(road, slideTo, i, 8))
    await sleep(14)
  }
  await sleep(100)
  t = await touchOf(p)
  const liftSeen = t.lift
  ok(!!at0 && !!t.ghost && Math.hypot(t.ghost.at.x - at0.x, t.ghost.at.z - at0.z) > 5, 'place: sliding moves the piece', { from: at0, to: t.ghost?.at })
  await p.cancel()
  await sleep(150)
  let a = await p.sum()
  ok(a.pieces === before.pieces && a.undoSteps === before.undoSteps && (await p.road()) === road0, 'place: a cancel leaves nothing')
  ok(!(await touchOf(p)).ghost, 'place: and the piece is gone from under the finger')
  // The real thing.
  await p.down({ ...road, id: 1 })
  await toolHeard(p)
  for (let i = 1; i <= 8; i++) {
    await p.move(slide(road, slideTo, i, 8))
    await sleep(14)
  }
  await p.lift()
  await sleep(250)
  a = await p.sum()
  const placed = ((await p.ed('file')) as { pieces: { type: string; at: number }[] }).pieces
  ok(a.pieces === before.pieces + 1 && a.undoSteps === before.undoSteps + 1, 'place: lifting puts it down, one Undo step', { pieces: a.pieces - before.pieces })
  // It rode 56 px above the finger (below it near the top edge) and snapped to the nearest road, and that is where it landed.
  const ridden = await p.roadNear(slideTo.x, slideTo.y - 56 < 28 ? slideTo.y + 56 : slideTo.y - 56)
  ok(placed.some((q) => q.type === 'boost' && Math.abs(q.at - ridden.at) < 0.6), 'place: where it was shown riding above the finger, not under it', { want: round(ridden.at), placed: placed.map((q) => round(q.at)), shownLift: liftSeen, slideTo, ridden })
  ok(!(await touchOf(p)).ghost, 'place: the see-through piece is gone')
  await p.undoTo(before.undoSteps)
  // 14 px off the road: further than a mouse reaches, inside a finger's 20.
  const near = { x: road.x, y: road.y - 14 }
  const n0 = (await p.sum()).pieces
  await p.tap(near)
  await sleep(200)
  ok((await p.sum()).pieces === n0 + 1, 'place: a finger 14 px off the road still places on it', { added: (await p.sum()).pieces - n0 })
  await p.undoTo(before.undoSteps)
  // A press well off the road pans, and a tap there says what to do.
  const off = await offRoad(p)
  if (off) {
    const gv0 = (await p.g()).view
    const path = Array.from({ length: 14 }, (_, i) => ({ x: off.x + i * 5, y: off.y + i * 2 }))
    await p.drag(path)
    const gv1 = (await p.g()).view
    ok(close((gv0.cx - gv1.cx) / gv0.mpp, 65, DRAG_PX) && close((gv0.cz - gv1.cz) / gv0.mpp, 26, DRAG_PX), 'place: one finger off the road pans', {})
    ok((await p.sum()).pieces === before.pieces, 'place: and puts nothing down')
    await p.ed('fit')
    await sleep(100)
    const off2 = (await offRoad(p)) ?? off
    await p.tap(off2)
    await sleep(150)
    ok(/Click on the road/.test((await message(p)) ?? '') && (await p.sum()).pieces === before.pieces, 'place: a tap off the road says where to click', await message(p))
  }
  // Pieces that go anywhere show under the finger and go where it lifts.
  for (const [digit, key, count] of [['9', 'props', 'props'], ['0', 'cores', 'cores']] as const) {
    await pickPieceKey(p, digit)
    const spot = (await offRoad(p)) ?? { x: 200, y: 100 }
    const c0 = ((await p.sum()) as Record<string, number>)[count]
    await p.down({ ...spot, id: 1 })
    await toolHeard(p)
    t = await touchOf(p)
    ok(t.ghost?.kind === key, `${key}: pressing shows it under the finger`, { ghost: t.ghost?.kind, tool: (await p.sum()).tool, spot, fingerDown: t.fingerDown, phase: (await p.g()).phase, ev: await p.page.evaluate(() => (window as unknown as { __ev: string[] }).__ev.slice(-8)), touch: { ...t, shape: null } })
    ok(((await p.sum()) as Record<string, number>)[count] === c0, `${key}: nothing placed yet`)
    await p.lift()
    await sleep(250)
    ok(((await p.sum()) as Record<string, number>)[count] === c0 + 1, `${key}: lifting places it`, { added: ((await p.sum()) as Record<string, number>)[count] - c0 })
    await p.undoTo(before.undoSteps)
  }
  // The lift: a crash prop rides 56 px above the finger, lands there; a wobble under 6 px places it right at the finger; a wall ride has no lift.
  await pickPieceKey(p, '9')
  const [spotA] = await freeSpots(p, 1)
  const worldOf = async (q: World) => ((await p.ed('screen', [q.x, q.z])) as { sx: number; sy: number })
  const propsNow = async () => ((await p.ed('file')) as { props?: World[] }).props ?? []
  await p.down({ ...spotA, id: 1 })
  await toolHeard(p)
  await p.move({ x: spotA.x + 2, y: spotA.y + 2, id: 1 })
  await sleep(60)
  let tg = await touchOf(p)
  let gs = tg.ghost ? await worldOf(tg.ghost.at) : null
  ok(!!gs && Math.hypot(gs.sx - (spotA.x + 2), gs.sy - (spotA.y + 2)) < 3, 'place: a wobble under 6 px keeps the preview at the finger', gs)
  const fingerB = { x: spotA.x + 6, y: spotA.y + 70 }
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: spotA.x + (6 * i) / 8, y: spotA.y + (70 * i) / 8, id: 1 })
    await sleep(14)
  }
  await sleep(250)
  tg = await touchOf(p)
  gs = tg.ghost ? await worldOf(tg.ghost.at) : null
  ok(!!gs && close(gs.sx, fingerB.x, 1.5) && close(gs.sy, fingerB.y - 56, 1.5) && Math.abs(tg.lift + 56) < 0.01, 'place: the preview rides 56 px above the finger', { got: gs && [round(gs.sx), round(gs.sy)], want: [fingerB.x, fingerB.y - 56], lift: tg.lift })
  const nProps = (await propsNow()).length
  await p.lift()
  await sleep(250)
  const after = await propsNow()
  const landed = after.length === nProps + 1 ? await worldOf(after[after.length - 1]) : null
  ok(!!landed && close(landed.sx, fingerB.x, 1.5) && close(landed.sy, fingerB.y - 56, 1.5), 'place: and lands where it was shown', { landed: landed && [round(landed.sx), round(landed.sy)] })
  await p.undoTo(before.undoSteps)
  // A tap with a small wobble places it at the finger.
  const nProps2 = (await propsNow()).length
  await p.down({ ...spotA, id: 1 })
  await toolHeard(p)
  await p.move({ x: spotA.x + 3, y: spotA.y + 2, id: 1 })
  await sleep(60)
  await p.lift()
  await sleep(250)
  const after2 = await propsNow()
  const tapped = after2.length === nProps2 + 1 ? await worldOf(after2[after2.length - 1]) : null
  ok(!!tapped && Math.hypot(tapped.sx - (spotA.x + 3), tapped.sy - (spotA.y + 2)) < 3, 'place: a tap with a wobble puts it at the finger, no lift', { tapped: tapped && [round(tapped.sx), round(tapped.sy)] })
  await p.undoTo(before.undoSteps)
  // A wall ride: no lift, and the finger sliding along the road draws the length as before.
  await pickPieceKey(p, '4')
  await p.ed('fit')
  await sleep(150)
  const wr = await p.roadNear(p.w / 2 - 60, p.h / 2)
  await p.down({ ...wr, id: 1 })
  await toolHeard(p)
  await p.move({ x: wr.x + 12, y: wr.y + 8, id: 1 })
  await sleep(100)
  ok((await touchOf(p)).lift === 0, 'wall ride: no lift')
  await p.lift()
  await sleep(250)
  await p.undoTo(before.undoSteps)
  // A wall ride shows its whole wall on the press.
  await p.ed('fit')
  await sleep(150)
  const roadNow = await p.roadNear(p.w / 2 - 60, p.h / 2)
  await pickPieceKey(p, '4')
  await p.down({ ...roadNow, id: 1 })
  await toolHeard(p)
  t = await touchOf(p)
  ok(!!t.ghost?.wall, 'wall ride: the whole wall shows on the press', { ghost: t.ghost, tool: (await p.sum()).tool, road: roadNow, fingerDown: t.fingerDown, phase: (await p.g()).phase, onMap: await p.onMap(road) })
  await p.lift()
  await sleep(250)
  ok((await p.sum()).pieces === before.pieces + 1, 'wall ride: lifting places it')
  await p.undoTo(before.undoSteps)
  // Right on the road's first point: the nearest spot on the loop is the end of its last stretch, the same spot as 0. The file must still be valid.
  const seam = (await p.ed('screen', 0)) as { sx: number; sy: number }
  const onMapSeam = await p.onMap({ x: seam.sx, y: seam.sy })
  if (!onMapSeam) await p.ed('view', [(await p.ed('screen', 0) as { x: number }).x, (await p.ed('screen', 0) as { z: number }).z, (await p.g()).view.mpp])
  await sleep(150)
  const seam2 = (await p.ed('screen', 0)) as { sx: number; sy: number }
  await p.ed('tool', 'place')
  await pickPieceKey(p, '1')
  const u9 = (await p.sum()).undoSteps
  await p.tap({ x: seam2.sx, y: seam2.sy })
  await sleep(900)
  const seamFile = (await p.ed('file')) as { road: { points: unknown[] }; pieces: { at: number }[] }
  ok((await p.sum()).undoSteps === u9 + 1, 'a piece on the road\'s very first point goes down')
  ok(seamFile.pieces.every((q) => q.at >= 0 && q.at < seamFile.road.points.length), 'and every spot in the file is on the road', seamFile.pieces.map((q) => q.at))
  const seamErrors = ((await p.ed('checks')) as { validatorErrors: string[] }).validatorErrors
  ok(seamErrors.length === 0, 'and the game has nothing to say about it', seamErrors.slice(0, 1))
  await p.undoTo(u9)
  await p.ed('tool', 'select')
}

/** 15. How far from a thing a finger still grabs it: points 22, pieces 28, props and cores 26, crossings 24, road 20, label boxes plus 8. */
async function reaches(p: Phone) {
  await p.freshRoad()
  const u00 = (await p.sum()).undoSteps
  const sel = async () => JSON.stringify((await p.sum()).selection)
  const [far, blank] = await freeSpots(p, 2)
  ok(!!far && !!blank, 'two empty spots to work on', { far, blank })
  const clear = async () => {
    await p.tap(blank)
    await sleep(380)
  }
  // ---- a road point, zoomed in so points show
  await p.ed('tool', 'select')
  const pt = (await p.roadPoints())[3]
  await p.ed('view', [pt.x, pt.z, 0.5])
  await sleep(150)
  const ps = (await p.ed('screen', [pt.x, pt.z])) as { sx: number; sy: number }
  for (const [d, wants] of [[15, true], [20, true], [26, false]] as const) {
    await clear()
    await p.tap({ x: ps.sx + d, y: ps.sy })
    const got = (await p.sum()).selection
    ok((got?.kind === 'point' && got.index === 3) === wants, `point: ${d} px away ${wants ? 'is' : 'is not'} grabbed (reach 22)`, got)
  }
  // ---- a prop, a core and a piece, each placed by a tap with its tool, then picked by a finger at distance
  await p.ed('fit')
  await p.ed('tool', 'select')
  // Points show under 2.2 m a pixel and the nearest thing wins, so keep them out of this: it measures how far a piece reaches.
  const fitted = (await p.g()).view
  if (fitted.mpp < 2.3) await p.ed('view', [fitted.cx, fitted.cz, 2.6])
  await sleep(100)
  const road = await p.roadNear(p.w / 2 - 60, p.h / 2)
  await p.ed('tool', 'place')
  await pickPieceKey(p, '9')
  await p.tap(far)
  await pickPieceKey(p, '1')
  await p.tap(road)
  await sleep(200)
  const file = (await p.ed('file')) as { props?: unknown[]; pieces: unknown[] }
  const s0 = await p.sum()
  ok(s0.props >= 1 && s0.pieces >= 1, 'a prop and a piece to grab', { props: s0.props, pieces: s0.pieces })
  void file
  await p.ed('tool', 'select')
  await sleep(380)
  const grabAt = async (label: string, around: Spot, kind: string, hits: number[], misses: number[]) => {
    for (const d of hits) {
      await clear()
      await p.tap({ x: around.x + d, y: around.y })
      ok((await p.sum()).selection?.kind === kind, `${label}: ${d} px away is grabbed`, (await p.sum()).selection)
    }
    for (const d of misses) {
      await clear()
      await p.tap({ x: around.x + d, y: around.y })
      ok((await p.sum()).selection?.kind !== kind, `${label}: ${d} px away is not`, (await p.sum()).selection)
    }
  }
  await grabAt('prop (reach 26)', far, 'prop', [20, 25], [34])
  // A piece sits on the road; reach along the screen's vertical so the road itself isn't what is hit.
  const pieceSpot = road
  for (const d of [22, 27]) {
    await clear()
    await p.tap({ x: pieceSpot.x, y: pieceSpot.y - d })
    ok((await p.sum()).selection?.kind === 'piece', `piece: ${d} px away is grabbed (reach 28)`, (await p.sum()).selection)
  }
  await clear()
  await p.tap({ x: pieceSpot.x, y: pieceSpot.y - 36 })
  ok((await p.sum()).selection?.kind !== 'piece', 'piece: 36 px away is not', (await p.sum()).selection)
  void sel
  await p.undoTo(u00)

  // ---- a core (the same radius as a prop, 26)
  await p.ed('tool', 'place')
  await pickPieceKey(p, '0')
  await p.tap(far)
  await p.ed('tool', 'select')
  await sleep(380)
  await grabAt('core (reach 26)', far, 'core', [20, 25], [34])
  await p.undoTo(u00)

  // ---- the road: a stretch tool picks from 20 px away, Bend takes hold
  await p.ed('fit')
  const rd = await p.roadNear(p.w / 2 - 60, p.h / 2)
  await p.ed('tool', 'height')
  await clear()
  const px = (await p.ed('screen', rd.at)) as { sx: number; sy: number }
  void px
  // A spot exactly this far from the nearest road, wherever on the road there is room for one. (A bent road
  // has none round some spots: never fall back on a spot that isn't what the check says it is.)
  const roadOnScreen: Spot[] = []
  for (let i = 0, n = (await p.sum()).points; i < n * 4; i++) {
    const q = (await p.ed('screen', i / 4)) as { sx: number; sy: number }
    roadOnScreen.push({ x: q.sx, y: q.sy })
  }
  const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]
  const away = async (d: number): Promise<Spot> => {
    const nearest = (s: Spot) => Math.min(...roadOnScreen.map((q) => Math.hypot(q.x - s.x, q.y - s.y)))
    for (let k = 0; k < roadOnScreen.length; k += 7) {
      const from = k === 0 ? rd : roadOnScreen[k]
      for (const dir of dirs) {
        const s = { x: from.x + dir.x * d, y: from.y + dir.y * d }
        if (Math.abs(nearest(s) - d) < 2.5 && (await p.onMap(s)) && s.x > 180 && s.x < p.w - 270 && s.y > 60 && s.y < p.h - 40) return s
      }
    }
    ok(false, `a spot ${d} px from the road`)
    return { x: rd.x, y: rd.y - d }
  }
  const mpp = (await p.g()).view.mpp
  const g1 = await away(17)
  await p.tap(g1)
  ok((await p.sum()).selection?.kind === 'section', 'road: height picks a stretch from 17 px away (reach 20)', (await p.sum()).selection)
  await clear()
  const g2 = await away(32)
  await p.tap(g2)
  ok((await p.sum()).selection?.kind !== 'section', 'road: and not from 32 px away', (await p.sum()).selection)
  void mpp
  await p.ed('tool', 'bend')
  const u0 = (await p.sum()).undoSteps
  const road0 = await p.road()
  const b1 = await away(17)
  await p.down({ ...b1, id: 1 })
  await toolHeard(p)
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: b1.x + i * 3, y: b1.y + i * 2, id: 1 })
    await sleep(12)
  }
  const bent = (await p.road()) !== road0
  await p.lift()
  await sleep(200)
  ok(bent && (await p.sum()).undoSteps === u0 + 1, 'road: Bend takes hold from 17 px away', { undo: (await p.sum()).undoSteps - u0 })
  await p.undoTo(u0)
  await p.ed('tool', 'select')

  // ---- a crossing's marker and its label box (a figure of eight crosses itself; a new shape only lands on an empty map)
  await p.ed('newTrackNow')
  await sleep(300)
  await p.ed('shape', 'eight')
  await sleep(1500)
  await p.ed('fit')
  // (As with the piece: points showing would be nearer than the marker, and the nearest wins.)
  const fittedEight = (await p.g()).view
  if (fittedEight.mpp < 2.3) await p.ed('view', [fittedEight.cx, fittedEight.cz, 2.6])
  await p.ed('tool', 'select') // (New track put the Pencil in hand.)
  await sleep(300)
  const cr0 = (await p.ed('crossings')) as { screen: { marker: { sx: number; sy: number }; label: { sx: number; sy: number } | null } | null }[]
  const cr = Array.isArray(cr0) ? cr0.filter((c) => c.screen) : []
  ok(Array.isArray(cr) && cr.length >= 1, 'a crossing to grab', { n: Array.isArray(cr) ? cr.length : cr })
  if (Array.isArray(cr) && cr.length) {
    const m = cr[0].screen!.marker
    const l = cr[0].screen!.label
    // A spot that is empty on this road: picking a thing a card would cover slides the map, and these spots would go stale.
    const [emptyHere] = await freeSpots(p, 1)
    const probe = async (x: number, y: number) => {
      // (The BRIDGE pill only shows, and only grabs, with Select in hand; a tap near the road can have picked a stretch in its own tool.)
      await p.ed('tool', 'select')
      await sleep(120)
      await p.tap(emptyHere)
      await sleep(380)
      await p.tap({ x, y })
      return (await p.sum()).selection?.kind === 'crossing'
    }
    // The label sits below the marker, so probe up and to the left, away from it, until nothing is grabbed.
    const extent = async (from: Spot, dir: Spot, max: number) => {
      let last = 0
      for (let d = 0; d <= max; d += 3) if (await probe(from.x + dir.x * d, from.y + dir.y * d)) last = d
      return last
    }
    const down = await extent({ x: m.sx, y: m.sy }, { x: 0, y: -1 }, 36)
    const side = await extent({ x: m.sx, y: m.sy }, { x: -1, y: 0 }, 36)
    ok(Math.max(down, side) >= 21 && Math.max(down, side) <= 27, "a crossing's marker is grabbed out to about 24 px", { down, side })
    if (l) {
      const out = await extent({ x: l.sx, y: l.sy }, { x: 0, y: -1 }, 50)
      // The label's own box is a pill about 9 px either side of its middle; the finger reaches 8 more. Measured, not assumed: the same probe with the box edge found by the mouse is scenario 20.
      ok(out >= 12, "the label's box reaches past its own edge", { px: out })
    }
  }
  await p.ed('tool', 'select')
}

/** 16. A dragged thing eases up to ride 56 px above the finger, and nothing moves for a wobble. */
async function liftWhileDragging(p: Phone) {
  await p.freshRoad()
  await p.ed('tool', 'select')
  const idx = 3
  const pt = (await p.roadPoints())[idx]
  await p.ed('view', [pt.x, pt.z, 0.5])
  await sleep(150)
  const start = (await p.ed('screen', [pt.x, pt.z])) as { sx: number; sy: number }
  const where = async () => {
    const q = (await p.roadPoints())[idx]
    const s = (await p.ed('screen', [q.x, q.z])) as { sx: number; sy: number }
    return { x: s.sx, y: s.sy }
  }
  const u0 = (await p.sum()).undoSteps
  // A tap, and a wobble under 6 px: the point stays exactly where it was.
  await p.tap({ x: start.sx, y: start.sy })
  await sleep(380)
  let w = await where()
  ok(Math.hypot(w.x - start.sx, w.y - start.sy) < 0.5 && (await p.sum()).undoSteps === u0, 'a tap leaves the point exactly where it was')
  await p.down({ x: start.sx, y: start.sy, id: 1 })
  await toolHeard(p)
  for (const d of [2, -2, 3, -1]) {
    await p.move({ x: start.sx + d, y: start.sy + d, id: 1 })
    await sleep(20)
  }
  w = await where()
  ok(Math.hypot(w.x - start.sx, w.y - start.sy) < 0.5, 'a wobble under 6 px moves nothing', { px: round(Math.hypot(w.x - start.sx, w.y - start.sy)) })
  // Past 6 px: it eases up over 120 ms. Sampled while the finger is still.
  const f = { x: start.sx + 14, y: start.sy + 30 }
  await p.move({ ...f, id: 1 })
  const lifts: number[] = []
  for (let i = 0; i < 12; i++) {
    lifts.push((await touchOf(p)).lift)
    await sleep(16)
  }
  await sleep(200)
  const end = (await touchOf(p)).lift
  const climbing = lifts.every((v, i) => i === 0 || v <= lifts[i - 1] + 0.01)
  ok(climbing && lifts[0] > -56 && end === -56, 'it eases up to 56 px above the finger, not in one jump', { first: lifts.slice(0, 5).map((v) => round(v, 10)), end })
  w = await where()
  ok(close(w.x, f.x, 1.5) && close(w.y, f.y - 56, 1.5), 'the point sits 56 px above the finger', { x: round(w.x), y: round(w.y), want: [f.x, f.y - 56] })
  await p.lift()
  await sleep(200)
  w = await where()
  ok(close(w.x, f.x, 1.5) && close(w.y, f.y - 56, 1.5) && (await p.sum()).undoSteps === u0 + 1, 'let go, it stays there, one Undo step', { x: round(w.x), y: round(w.y), undo: (await p.sum()).undoSteps - u0 })
  await p.undoTo(u0)
  // Near the top edge it goes below the finger.
  await p.ed('view', [pt.x, pt.z, 0.5])
  await sleep(150)
  const s2 = (await p.ed('screen', [pt.x, pt.z])) as { sx: number; sy: number }
  await p.down({ x: s2.sx, y: s2.sy, id: 1 })
  await toolHeard(p)
  const top = { x: s2.sx + 10, y: 40 }
  for (let i = 1; i <= 10; i++) {
    await p.move({ x: s2.sx + (10 * i) / 10, y: s2.sy + ((40 - s2.sy) * i) / 10, id: 1 })
    await sleep(14)
  }
  await sleep(300)
  w = await where()
  const t = await touchOf(p)
  ok(t.lift === 56 && close(w.y, top.y + 56, 1.5), 'near the top edge it rides below the finger', { lift: t.lift, y: round(w.y), want: top.y + 56 })
  await p.lift()
  await sleep(200)
  await p.undoTo(u0)
  // No lift for the Pencil: the line ends where the finger does.
  await p.ed('fit')
  await p.ed('tool', 'pencil')
  await p.ed('steady', 0)
  const a = { x: p.w / 2 - 80, y: p.h / 2 + 30 }
  const path = Array.from({ length: 20 }, (_, i) => ({ x: a.x + i * 6, y: a.y + Math.sin(i / 3) * 10 }))
  await p.drag(path)
  const g = await p.g()
  const last = (g.line as World[])[(g.line as World[]).length - 1]
  const endPx = path[path.length - 1]
  const lastScreen = { x: p.w / 2 + (last.x - g.view.cx) / g.view.mpp, y: p.h / 2 + (last.z - g.view.cz) / g.view.mpp }
  ok(Math.hypot(lastScreen.x - endPx.x, lastScreen.y - endPx.y) < 3, 'Pencil: no lift, the line ends at the finger', { px: round(Math.hypot(lastScreen.x - endPx.x, lastScreen.y - endPx.y)) })
  await p.undoTo(u0)
  // No lift for Bend: the road under the grab follows the finger one for one.
  await p.ed('tool', 'bend')
  await p.ed('fit')
  const rd = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const un0 = (await p.sum()).undoSteps
  await p.down({ x: rd.x, y: rd.y, id: 1 })
  await toolHeard(p)
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: rd.x + i * 3, y: rd.y + i * 2, id: 1 })
    await sleep(14)
  }
  await sleep(100)
  const after = (await p.ed('screen', rd.at)) as { sx: number; sy: number }
  ok(Math.hypot(after.sx - (rd.x + 24), after.sy - (rd.y + 16)) < 3 && (await touchOf(p)).lift === 0, 'Bend: no lift, the grabbed road is under the finger', { px: round(Math.hypot(after.sx - (rd.x + 24), after.sy - (rd.y + 16))) })
  await p.lift()
  await sleep(200)
  await p.undoTo(un0)

  // A prop, lifted the same way, and landed where it is shown.
  await p.ed('fit')
  const far = (await freeSpots(p, 1))[0] ?? { x: 300, y: 100 }
  await p.ed('tool', 'place')
  await pickPieceKey(p, '9')
  await p.tap(far)
  await sleep(200)
  await p.ed('tool', 'select')
  await sleep(380)
  const propAt = async () => {
    const q = ((await p.ed('file')) as { props: { x: number; z: number }[] }).props.slice(-1)[0]
    const s = (await p.ed('screen', [q.x, q.z])) as { sx: number; sy: number }
    return { x: s.sx, y: s.sy }
  }
  const p0 = await propAt()
  await p.down({ x: p0.x, y: p0.y, id: 1 })
  await toolHeard(p)
  // (Toward the middle of the map: the world's edge would stop a prop short.)
  const dir = p0.x > p.w / 2 ? -1 : 1
  const pf = { x: p0.x + 40 * dir, y: p0.y + 80 }
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: p0.x + (40 * dir * i) / 8, y: p0.y + (80 * i) / 8, id: 1 })
    await sleep(14)
  }
  await sleep(250)
  const p1 = await propAt()
  ok(close(p1.x, pf.x, 1.5) && close(p1.y, pf.y < 84 ? pf.y + 56 : pf.y - 56, 1.5), 'a prop rides 56 px above the finger too', { x: round(p1.x), y: round(p1.y), want: [pf.x, pf.y - 56] })
  await p.lift()
  await sleep(200)
  await p.undoTo(un0)
}

/** 17. Double tap: 20 px for a finger. A mouse keeps 6 (scenario 20). A second finger after the second tap takes the point back. */
async function doubleTapTolerance(p: Phone) {
  await p.freshRoad()
  await p.ed('tool', 'select')
  const run = async (apart: number, label: string, wantAdded: number) => {
    await p.ed('fit')
    await sleep(380)
    const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
    const mid = (await p.ed('screen', Math.floor(spot.at) + 0.5)) as { sx: number; sy: number }
    const first = { x: mid.sx, y: mid.sy }
    const second = { x: mid.sx + apart, y: mid.sy }
    const n0 = (await p.sum()).points
    const u0 = (await p.sum()).undoSteps
    await p.down({ ...first, id: 1 })
    await sleep(60)
    await p.lift()
    await sleep(80)
    await p.down({ ...second, id: 1 })
    await sleep(60)
    await p.lift()
    await sleep(200)
    const added = (await p.sum()).points - n0
    ok(added === wantAdded, `double tap ${apart} px apart ${label}`, { added })
    await p.undoTo(u0)
    await sleep(400)
  }
  await run(8, 'adds a point', 1)
  await run(18, 'adds a point (tolerance 20)', 1)
  await run(32, 'does not', 0)
  // The same with the road points showing, a few pixels apart: every spot on the road is within a finger's reach of one.
  const showing = async (apart: number, wantAdded: number) => {
    await p.ed('fit')
    const onRoad = await p.roadNear(p.w / 2 - 60, p.h / 2)
    const w = (await p.ed('screen', onRoad.at)) as { x: number; z: number }
    await p.ed('view', [w.x, w.z, 1.5])
    await sleep(380)
    const mid = (await p.ed('screen', Math.floor(onRoad.at) + 0.5)) as { sx: number; sy: number; x: number; z: number }
    const near = (await p.ed('screen', Math.floor(onRoad.at))) as { sx: number; sy: number }
    const n0 = (await p.sum()).points
    const u0 = (await p.sum()).undoSteps
    await p.down({ x: mid.sx, y: mid.sy, id: 1 })
    await sleep(60)
    await p.lift()
    await sleep(80)
    await p.down({ x: mid.sx + apart, y: mid.sy, id: 1 })
    await sleep(60)
    await p.lift()
    await sleep(200)
    const added = (await p.sum()).points - n0
    ok(Math.hypot(near.sx - mid.sx, near.sy - mid.sy) < 22, 'points are showing, and this spot is within reach of one', { px: round(Math.hypot(near.sx - mid.sx, near.sy - mid.sy)) })
    ok(added === wantAdded, `double tap ${apart} px apart with the points showing ${wantAdded ? 'adds a point' : 'does not'}`, { added })
    await p.undoTo(u0)
    await sleep(400)
  }
  await showing(8, 1)
  await showing(32, 0)
  // Right on a point there is nothing to add, and it says so.
  await p.ed('fit')
  const onR = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const pointAt = Math.round(onR.at)
  const pw = (await p.ed('screen', pointAt)) as { x: number; z: number }
  await p.ed('view', [pw.x, pw.z, 0.5])
  await sleep(380)
  const ps = (await p.ed('screen', pointAt)) as { sx: number; sy: number }
  const pointsBefore = (await p.sum()).points
  await p.tap({ x: ps.sx, y: ps.sy }, 50)
  await sleep(60)
  await p.tap({ x: ps.sx + 2, y: ps.sy }, 50)
  await sleep(200)
  ok((await p.sum()).points === pointsBefore, 'a double tap right on a point adds nothing', { added: (await p.sum()).points - pointsBefore })
  ok(/already is a road point/.test((await p.page.evaluate(() => (window as any).__game.get('editorMsg'))) ?? ''), 'and it says why') // eslint-disable-line @typescript-eslint/no-explicit-any
  await p.undoTo((await p.sum()).undoSteps)
  // The second tap's point is taken back when a second finger lands on it.
  await p.ed('fit')
  await sleep(380)
  const spot = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const mid = (await p.ed('screen', Math.floor(spot.at) + 0.5)) as { sx: number; sy: number }
  const at = { x: mid.sx, y: mid.sy }
  const before = await p.sum()
  const road0 = await p.road()
  await p.down({ ...at, id: 1 })
  await sleep(60)
  await p.lift()
  await sleep(80)
  await p.down({ ...at, id: 1 })
  await toolHeard(p)
  const added = (await p.sum()).points - before.points
  await p.down({ ...at, id: 1 }, { x: at.x + 90, y: at.y, id: 2 })
  await sleep(40)
  await p.move({ ...at, x: at.x - 10, id: 1 }, { x: at.x + 100, y: at.y, id: 2 })
  await sleep(60)
  await p.lift()
  await sleep(200)
  const after = await p.sum()
  ok(added === 1 && after.points === before.points && after.undoSteps === before.undoSteps && (await p.road()) === road0, 'a second finger on the double tap takes the new point back', { added, points: after.points - before.points, undo: after.undoSteps - before.undoSteps })
}

/** 18. One finger off the road pans for Height, Bank, Width and Place (a tap says what to do); the Pencil always draws. */
async function offRoadPans(p: Phone) {
  await p.freshRoad()
  for (const tool of ['height', 'bank', 'width'] as const) {
    await p.ed('fit')
    await p.ed('tool', tool)
    await sleep(380)
    const off = await offRoad(p)
    ok(off !== null, `${tool}: a spot off the road`)
    if (!off) continue
    // A stretch is picked first, so a tap off the road clearing it is seen.
    const on = await p.roadNear(p.w / 2 - 60, p.h / 2)
    await p.tap(on)
    ok((await p.sum()).selection?.kind === 'section', `${tool}: a stretch is picked`)
    const g0 = await p.g()
    const road0 = await p.road()
    const path = Array.from({ length: 16 }, (_, i) => ({ x: off.x + i * 5, y: off.y + i * 2 }))
    await p.drag(path)
    const g1 = await p.g()
    ok(close((g0.view.cx - g1.view.cx) / g0.view.mpp, 75, DRAG_PX) && close((g0.view.cz - g1.view.cz) / g0.view.mpp, 30, DRAG_PX), `${tool}: one finger off the road pans, all its path`, { x: round((g0.view.cx - g1.view.cx) / g0.view.mpp), z: round((g0.view.cz - g1.view.cz) / g0.view.mpp) })
    ok((await p.sum()).selection?.kind === 'section' && (await p.road()) === road0, `${tool}: the pick is kept and the road left alone`)
    await p.ed('fit')
    await sleep(380)
    const off2 = (await offRoad(p)) ?? off
    await p.tap(off2)
    await sleep(150)
    ok((await p.sum()).selection === null && /Drag along the road/.test((await message(p)) ?? ''), `${tool}: a tap there says what to do, as it did`, { sel: (await p.sum()).selection, said: await message(p) })
  }
  // The Pencil always draws, wherever the finger lands.
  await p.ed('fit')
  await p.ed('tool', 'pencil')
  await sleep(380)
  const off = await offRoad(p)
  if (off) {
    const g0 = await p.g()
    const path = Array.from({ length: 16 }, (_, i) => ({ x: off.x + i * 5, y: off.y + i * 2 }))
    const t0 = g0.toolStarts
    await p.drag(path)
    const g1 = await p.g()
    ok(g1.toolStarts - t0 === 1 && g1.view.cx === g0.view.cx && g1.view.cz === g0.view.cz, 'Pencil: off the road it draws, and the map stays', { toolStarts: g1.toolStarts - t0 })
  }
  await p.ed('tool', 'select')
}

/** 19. The other thumb's buttons: Straight line (Shift's job) and less / more reach on Bend (the wheel's job). */
async function thumbButtons(p: Phone) {
  await p.freshRoad()
  await p.hidePanels(false)
  await p.page.addStyleTag({ content: '.sre-options, .sre-palette, .sre-tools, .sre-panel { pointer-events: none !important; opacity: 0 !important; }' })
  await p.ed('fit')
  const btn = async (id: string): Promise<Spot | null> =>
    p.page.evaluate((i: string) => {
      const r = document.querySelector(`[data-testid=${i}]`)?.getBoundingClientRect()
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
    }, id)
  const size = (id: string) => p.page.evaluate((i: string) => { const r = document.querySelector(`[data-testid=${i}]`)?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null }, id)
  // Pencil: Straight line.
  await p.ed('steady', 0)
  await p.ed('newTrackNow')
  await sleep(200)
  await p.ed('tool', 'pencil')
  await sleep(200)
  ok((await btn('thumb-straight')) === null, 'Pencil, no finger on the map: no Straight line (P8)')
  const pressed = () => p.page.evaluate(() => document.querySelector('[data-testid=thumb-straight]')?.getAttribute('aria-pressed'))
  // A wobbly line: the first half freehand, then the thumb taps Straight line, and the second half wobbles on but comes out straight.
  const pts: Spot[] = []
  for (let i = 0; i <= 60; i++) pts.push({ x: p.w * 0.25 + i * 5, y: p.h * 0.5 + Math.sin(i / 2.2) * 28 })
  await p.down({ ...pts[0], id: 1 })
  await sleep(100)
  for (let i = 1; i <= 15; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  // It shows while the finger draws, and showing moves nothing: the map stays put and the line keeps coming.
  await sleep(60)
  const viewWhileDrawing = (await p.g()).view
  const sb = await btn('thumb-straight')
  ok(sb !== null, 'a finger drawing: the Straight line button shows')
  const sz = await size('thumb-straight')
  ok(!!sz && sz[0] >= 44 && sz[1] >= 44, 'and is at least 44 px each way', sz)
  if (!sb) {
    await p.lift()
    return
  }
  for (let i = 16; i <= 30; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  const viewStill = (await p.g()).view
  ok(viewStill.cx === viewWhileDrawing.cx && viewStill.cz === viewWhileDrawing.cz && viewStill.mpp === viewWhileDrawing.mpp, 'and the map has not moved under the finger')
  await p.down({ ...pts[30], id: 1 }, { ...sb, id: 2 })
  await sleep(40)
  await p.liftOne({ ...sb, id: 2 })
  await sleep(60)
  ok((await pressed()) === 'true', 'the thumb toggles Straight line on while a finger draws')
  for (let i = 31; i <= 60; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  await p.lift()
  await sleep(300)
  const line = ((await p.g()).line as World[]).slice()
  const g = await p.g()
  const n = line.length
  const dev = (seg: World[]) => {
    const [a, b] = [seg[0], seg[seg.length - 1]]
    const vx = b.x - a.x
    const vz = b.z - a.z
    const len = Math.hypot(vx, vz) || 1
    return Math.max(...seg.map((q) => Math.abs((q.x - a.x) * vz - (q.z - a.z) * vx) / len)) / g.view.mpp
  }
  const early = line.slice(0, Math.floor(n * 0.3))
  const late = line.slice(Math.floor(n * 0.7))
  ok(n > 20 && dev(early) > 3, 'the first part of the line is freehand', { px: round(dev(early)), points: n })
  ok(dev(late) < 0.8, 'the part after the tap is dead straight', { px: round(dev(late)) })
  ok((await btn('thumb-straight')) === null, 'the finger lifted, it goes, and takes Straight line with it (like Shift)')
  // Tap it off mid-line: freehand again.
  await p.ed('newTrackNow')
  await sleep(200)
  await p.down({ ...pts[0], id: 1 })
  await sleep(100)
  for (let i = 1; i <= 20; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  await p.down({ ...pts[20], id: 1 }, { ...sb, id: 2 })
  await sleep(30)
  await p.liftOne({ ...sb, id: 2 })
  await sleep(40)
  for (let i = 21; i <= 36; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  await p.down({ ...pts[36], id: 1 }, { ...sb, id: 2 })
  await sleep(30)
  await p.liftOne({ ...sb, id: 2 })
  await sleep(40)
  ok((await pressed()) === 'false', 'tapped again, Straight line is off')
  for (let i = 37; i <= 60; i++) {
    await p.move({ ...pts[i], id: 1 })
    await sleep(10)
  }
  await p.lift()
  await sleep(300)
  const line2 = ((await p.g()).line as World[]).slice()
  const tail = line2.slice(Math.floor(line2.length * 0.75))
  ok(dev(tail) > 3, 'tapped off, the line carries on freehand', { px: round(dev(tail)) })

  // Bend: less and more reach, while a finger holds the road.
  await p.ed('random', 7)
  await sleep(1500)
  await p.ed('fit')
  await p.ed('tool', 'bend')
  await sleep(200)
  ok(!(await btn('thumb-less')) && !(await btn('thumb-more')), 'Bend, no finger on the road: no minus and plus (P8)')
  const r0 = (await p.sum()).bendReach
  const rd = await p.roadNear(p.w / 2 - 60, p.h / 2)
  const u0 = (await p.sum()).undoSteps
  await p.down({ ...rd, id: 1 })
  await toolHeard(p)
  for (let i = 1; i <= 8; i++) {
    await p.move({ x: rd.x + i * 3, y: rd.y + i * 2, id: 1 })
    await sleep(12)
  }
  await sleep(80)
  const less = await btn('thumb-less')
  const more = await btn('thumb-more')
  ok(!!less && !!more, 'a finger on the road: the minus and plus buttons show')
  const sz2 = await size('thumb-more')
  ok(!!sz2 && sz2[0] >= 44 && sz2[1] >= 44, 'and are at least 44 px each way', sz2)
  if (!less || !more) {
    await p.lift()
    return
  }
  const road1 = await p.road()
  const held = { x: rd.x + 24, y: rd.y + 16, id: 1 }
  await p.down(held, { ...more, id: 2 })
  await sleep(30)
  await p.liftOne({ ...more, id: 2 })
  await sleep(120)
  const r1 = (await p.sum()).bendReach
  ok(close(r1 / r0, 1.25, 0.03), 'plus brings 1.25 times the road along', { before: r0, after: r1 })
  ok((await p.road()) !== road1, 'and the held road changes under the finger')
  ok((await p.sum()).undoSteps === u0, 'with no Undo step until the finger lets go')
  await p.down(held, { ...less, id: 2 })
  await sleep(30)
  await p.liftOne({ ...less, id: 2 })
  await sleep(120)
  const r2 = (await p.sum()).bendReach
  ok(close(r2 / r1, 0.8, 0.03), 'minus takes it back by a step', { before: r1, after: r2 })
  await p.lift()
  await sleep(250)
  ok((await p.sum()).undoSteps === u0 + 1, 'one Undo step for the whole bend', { undo: (await p.sum()).undoSteps - u0 })
  ok(!(await btn('thumb-less')) && !(await btn('thumb-more')), 'and the finger lifted, they go')
  await p.undoTo(u0)
  // Other tools show neither.
  await p.ed('tool', 'select')
  await sleep(150)
  ok(!(await btn('thumb-straight')) && !(await btn('thumb-more')), 'Select shows neither')
  await p.ed('tool', 'pencil')
}

/** 20. A real mouse at 1920x1080 is what it was: no waiting, the old reach, a 6 px double click, no lift. */
async function mouseUnchanged() {
  const p = await openDesktop()
  const m = p.page.mouse
  await p.freshRoad()
  const t0 = (await p.g()).touch as TouchView
  // Curve: the third click acts on the press.
  await p.ed('tool', 'curve')
  const n = (await p.sum()).points
  const c1 = await screenOf(p, 1.5)
  const c2 = await screenOf(p, (1.5 + 4) % n)
  await m.click(c1.x, c1.y)
  await m.click(c2.x, c2.y)
  const shaping = (await p.sum()).shaping
  ok(shaping?.tool === 'curve' && shaping.b != null, 'curve: the mouse puts the ends in as it clicks', shaping)
  const u0 = (await p.sum()).undoSteps
  const road0 = await p.road()
  const mid = { x: (c1.x + c2.x) / 2 + 14, y: (c1.y + c2.y) / 2 - 12 }
  await m.move(mid.x, mid.y)
  await m.down()
  const acted = (await p.road()) !== road0 || (await p.sum()).undoSteps !== u0
  await m.up()
  ok(acted || /tight/i.test((await message(p)) ?? '') || (await p.sum()).shaping === null, 'curve: the third press acts at once', { undo: (await p.sum()).undoSteps - u0 })
  await p.undoTo(u0 - 0)
  // Reach: a road point is grabbed from 7 px, not from 12.
  await p.ed('tool', 'select')
  const pt = (await p.roadPoints())[3]
  await p.ed('view', [pt.x, pt.z, 0.5])
  await sleep(200)
  const ps = (await p.ed('screen', [pt.x, pt.z])) as { sx: number; sy: number }
  await m.click(ps.sx + 400, ps.sy + 200)
  await m.click(ps.sx + 7, ps.sy)
  ok((await p.sum()).selection?.kind === 'point', 'a mouse grabs a point from 7 px')
  await m.click(ps.sx + 400, ps.sy + 200)
  await sleep(400)
  await m.click(ps.sx + 12, ps.sy)
  ok((await p.sum()).selection?.kind !== 'point', 'and not from 12 px (a finger reaches 22)', (await p.sum()).selection)
  // Dragging a point: no lift, it follows the mouse exactly.
  await m.move(ps.sx, ps.sy)
  await m.down()
  for (let i = 1; i <= 10; i++) await m.move(ps.sx + i * 4, ps.sy + i * 3)
  await m.up()
  const q = (await p.roadPoints())[3]
  const qs = (await p.ed('screen', [q.x, q.z])) as { sx: number; sy: number }
  ok(Math.hypot(qs.sx - (ps.sx + 40), qs.sy - (ps.sy + 30)) < 1, 'a dragged point sits under the mouse, no lift', { dx: round(qs.sx - (ps.sx + 40)), dy: round(qs.sy - (ps.sy + 30)) })
  await p.undoTo(u0)
  // Double click: 6 px.
  await p.ed('fit')
  await sleep(500)
  // The middle of the longest gap between two road points (points show at this zoom, and a click near one picks it).
  let best = { gap: 0, at: 0 }
  const nPts = (await p.sum()).points
  for (let i = 0; i < nPts; i++) {
    const a = (await p.ed('screen', i)) as { sx: number; sy: number }
    const b = (await p.ed('screen', (i + 1) % nPts)) as { sx: number; sy: number }
    const gap = Math.hypot(a.sx - b.sx, a.sy - b.sy)
    if (gap > best.gap && a.sx > 500 && a.sx < 1200 && b.sx > 500 && b.sx < 1200) best = { gap, at: i + 0.5 }
  }
  // Zoomed right in, so the gap is wide and the middle of it is well clear of both points.
  const w0 = (await p.ed('screen', best.at)) as { x: number; z: number }
  await p.ed('view', [w0.x, w0.z, 0.3])
  await sleep(300)
  const mid2 = (await p.ed('screen', best.at)) as { sx: number; sy: number }
  for (const [apart, want] of [[4, 1], [12, 0]] as const) {
    await sleep(500)
    const pts0 = (await p.sum()).points
    await m.click(mid2.sx, mid2.sy)
    await sleep(60)
    await m.click(mid2.sx + apart, mid2.sy)
    await sleep(200)
    ok((await p.sum()).points - pts0 === want, `double click ${apart} px apart ${want ? 'adds a point' : 'does not (a finger gets 20)'}`, { added: (await p.sum()).points - pts0, gap: round(best.gap), at: best.at, tool: (await p.sum()).tool, said: await message(p) })
    await p.undoTo(u0)
  }
  // Stretch tools: off the road does not pan with a mouse; it clears the pick and says so, as it always did.
  await p.ed('fit')
  await p.ed('tool', 'height')
  const off = (await freeSpots(p, 1, 1200, 520))[0]
  if (off) {
    const v0 = (await p.g()).view
    await m.move(off.x, off.y)
    await m.down()
    await m.move(off.x + 60, off.y + 20)
    await m.up()
    const v1 = (await p.g()).view
    ok(v1.cx === v0.cx && v1.cz === v0.cz && /Drag along the road/.test((await message(p)) ?? ''), 'height: a mouse off the road does not pan, it says what to do', { said: await message(p) })
  }
  const t1 = (await p.g()).touch as TouchView
  ok(t1.commits === t0.commits && t1.pendingLifts === t0.pendingLifts, 'none of it went through the finger side', { commits: t1.commits - t0.commits })
  await p.page.close()
}


// ---- 24: the browser takes the picture away

const CRASH = '[data-testid=crash-screen]'
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Grab the real context's extension, so it can give the context back later (a lost context hands out no extensions). */
const holdLoseExt = (p: Phone) =>
  p.page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas')].find((c) => c.dataset.engine)!
    ;(window as any).__glCheck = { gl: canvas.getContext('webgl2'), ext: canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context') }
  })
const lose = async (p: Phone) => {
  await holdLoseExt(p)
  return p.page.evaluate(() => {
    const { gl, ext } = (window as any).__glCheck
    ext.loseContext()
    return gl.isContextLost() as boolean
  })
}
const restore = (p: Phone) => p.page.evaluate(() => (window as any).__glCheck.ext.restoreContext())
const look = (p: Phone) => p.page.evaluate(() => (window as any).__game.get('look')) as Promise<{ post: { passes: number; bloom: boolean }; env: { builds: number }; quality: { level: string; dpr: number } }>
const frameNow = (p: Phone) => p.page.evaluate(() => { const f = (window as any).__game.frame; return { n: f.frame as number, calls: f.calls as number, gpuSupported: f.gpuSupported as boolean, gpuMs: f.gpuMs as number } })
const speedNow = (p: Phone) => p.page.evaluate(() => (window as any).__game.telemetry.speedKmh as number)
const audioNow = (p: Phone) => p.page.evaluate(() => { const a = (window as any).__game.get('audio'); return { state: a?.state as string | undefined, hidden: a?.hidden as boolean | undefined } })
/* eslint-enable @typescript-eslint/no-explicit-any */
const rootSize = (p: Phone) => p.page.evaluate(() => document.getElementById('root')!.innerHTML.length)
const hasEl = (p: Phone, sel: string) => p.page.evaluate((s: string) => !!document.querySelector(s), sel)
const boxOf = (p: Phone, sel: string) =>
  p.page.evaluate((s: string) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }, sel)
const pressNav = async (p: Phone, nav: string) => {
  const b = await boxOf(p, `[data-nav="${nav}"]`)
  ok(!!b, `${nav} is on the screen to press`)
  if (b) await p.tap(b)
}
const until = async (cond: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond().catch(() => false)) return true
    await sleep(100)
  }
  return false
}
/** The canvas's place on the page and how many pixels it draws. */
const canvasSize = (p: Phone) =>
  p.page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].find((e) => e.dataset.engine)!
    const r = c.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, bufferW: c.width, bufferH: c.height }
  })
/** How much of what is on screen is bright and coloured, from a real screenshot: the only way to see the picture itself. */
async function litShare(p: Phone) {
  const png = await p.page.screenshot({ encoding: 'base64' })
  return p.page.evaluate(async (data: string) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) {
      const hi = Math.max(d[i], d[i + 1], d[i + 2])
      if (hi > 90 && hi - Math.min(d[i], d[i + 1], d[i + 2]) > 50) lit++
    }
    return lit / (d.length / 4)
  }, png)
}
/** The picture came back: right size and place, the post stack and the reflection map rebuilt, and really on screen. */
async function pictureBack(p: Phone, was: { size: Awaited<ReturnType<typeof canvasSize>>; lit: number; passes: number; calls: number; gpuSupported: boolean }, envBefore: number) {
  ok(await until(async () => (await look(p)).post.passes === was.passes, 3000), 'the post stack is built again, with all its passes', (await look(p)).post)
  ok(await until(async () => (await look(p)).env.builds > envBefore, 3000), 'the reflection map is drawn again', { before: envBefore, now: (await look(p)).env.builds })
  await sleep(1000)
  const size = await canvasSize(p)
  ok(JSON.stringify(size) === JSON.stringify(was.size), 'the picture is in the same place at the same size', size)
  const f = await frameNow(p)
  ok(f.calls > was.calls * 0.5, 'the scene is being drawn again', { calls: f.calls, before: was.calls })
  ok(f.gpuSupported === was.gpuSupported && (!was.gpuSupported || f.gpuMs >= 0), "the frame clock's GPU timer works again", { supported: f.gpuSupported, gpuMs: f.gpuMs })
  const lit = await litShare(p)
  ok(lit > was.lit * 0.5, 'the picture is on the screen, as bright as it was', { lit: round(lit, 1000), before: round(was.lit, 1000) })
}
async function pictureNow(p: Phone) {
  const f = await frameNow(p)
  return { size: await canvasSize(p), lit: await litShare(p), passes: (await look(p)).post.passes, calls: f.calls, gpuSupported: f.gpuSupported }
}
/** The crash screen fits and can be pressed here, and does nothing by itself. */
async function crashScreenFits(p: Phone, inset: { left: number; right: number; bottom: number }) {
  ok(await hasEl(p, CRASH), 'the crash screen is up, the page is not blank', { root: await rootSize(p) })
  ok(!(await hasEl(p, 'canvas')), 'it needs no WebGL: the game and its canvas have gone')
  const b = await boxOf(p, `${CRASH} button`)
  ok(!!b && b.height >= 44 && b.width >= 88, 'Reload is big enough for a thumb', b)
  if (b) ok(b.left >= inset.left && b.right <= p.w - inset.right && b.bottom <= p.h - inset.bottom, 'Reload is clear of the notch and the home bar', b)
  const fits = await p.page.evaluate((s: string) => {
    const page = document.querySelector(s)!
    const texts = [...page.querySelectorAll('h1, p, button')].map((e) => e.getBoundingClientRect())
    return { scroll: page.scrollHeight - page.clientHeight, top: Math.min(...texts.map((r) => r.top)), bottom: Math.max(...texts.map((r) => r.bottom)), words: page.textContent }
  }, CRASH)
  ok(fits.scroll <= 0 && fits.top >= 0 && fits.bottom <= p.h, 'all of it fits without scrolling', fits)
  await p.page.evaluate(() => {
    ;(window as unknown as { __sameLoad: boolean }).__sameLoad = true
  })
  await sleep(2500)
  ok(await p.page.evaluate(() => !!(window as unknown as { __sameLoad?: boolean }).__sameLoad), 'it never reloads by itself')
  return fits.words as string
}
const sameLoad = (p: Phone) => p.page.evaluate(() => !!(window as unknown as { __sameLoad?: boolean }).__sameLoad)

/**
 * 24. The browser takes the picture away, with real presses and a really lost context: a phone can do this whenever it
 * likes. The game must not go blank or throw, the picture must come back right, and a context that stays gone must end on
 * a plain screen with a Reload button that keeps a road being drawn. Screenshots land in --out.
 */
async function contextLost(name: string) {
  const inset = WINDOWS[name].insets
  const TITLE = 'nomusic=1&quality=low'
  const READY = '[data-nav=editor]'

  // ---- gone, then Road Editor (this is what left the page blank on Safari), then a new quality, then it comes back
  let p = await openPhone(name, TITLE, READY)
  let was = await pictureNow(p)
  ok(was.passes >= 2 && was.lit > 0.03, 'the title screen is drawing before anything happens', was)
  ok((await lose(p)) === true, 'the context is really lost')
  await sleep(300)
  const dark = await litShare(p)
  ok(dark < was.lit * 0.5, 'the check can see the picture go', { lit: round(dark, 1000), before: round(was.lit, 1000) })
  await pressNav(p, 'editor')
  ok(await until(() => hasEl(p, '[data-testid=editor-ui]'), 3000), 'Road Editor opens while the picture is gone')
  ok((await rootSize(p)) > 0 && !(await hasEl(p, CRASH)), 'the page is not blank and no crash screen')
  ok((await look(p)).post.passes === 0, 'no post stack is built on a lost context')
  await p.page.evaluate(() => (window as unknown as { __dev: { setQuality: (q: string) => void } }).__dev.setQuality('medium'))
  ok(await until(async () => (await look(p)).quality.level === 'medium', 1500), 'quality changes while the picture is gone')
  ok((await rootSize(p)) > 0 && !(await hasEl(p, CRASH)), 'still not blank, no crash screen')
  let env = (await look(p)).env.builds
  await restore(p)
  ok(await until(async () => (await look(p)).post.passes >= 2, 3000), 'the context comes back and the post stack with it', (await look(p)).post)
  ok(await until(async () => (await look(p)).env.builds > env, 3000), 'the reflection map is drawn again')
  await sleep(800)
  const q = await look(p)
  const size = await canvasSize(p)
  ok(q.quality.level === 'medium' && size.bufferW === Math.round(size.width * q.quality.dpr), 'the new quality held and the picture is the right size for it', { dpr: q.quality.dpr, size })
  ok(size.left === 0 && size.top === 0 && size.width === p.w && size.height === p.h, 'the picture fills the window', size)
  ok((await frameNow(p)).calls > 0, 'the map is being drawn again')
  await p.page.screenshot({ path: `${OUT}/lost-${name}-1-editor-back.png` })
  await p.page.close()

  // ---- gone for 13 ms on the title, as Safari did it; then a press in the gap between the loss and its event
  p = await openPhone(name, TITLE, READY)
  was = await pictureNow(p)
  env = (await look(p)).env.builds
  await holdLoseExt(p)
  await p.page.evaluate(() => {
    const { gl, ext } = (window as unknown as { __glCheck: { gl: WebGL2RenderingContext; ext: { loseContext(): void; restoreContext(): void } } }).__glCheck
    gl.canvas.addEventListener('webglcontextlost', () => setTimeout(() => ext.restoreContext(), 13), { once: true })
    ext.loseContext()
  })
  await sleep(500)
  await pictureBack(p, was, env)
  await p.page.screenshot({ path: `${OUT}/lost-${name}-2-title-back.png` })
  await holdLoseExt(p)
  // React draws straight after the press, before the browser has delivered the loss: only the context itself knows yet.
  const heard = await p.page.evaluate(() => {
    const { gl, ext } = (window as unknown as { __glCheck: { gl: WebGL2RenderingContext; ext: { loseContext(): void } } }).__glCheck
    let told = false
    gl.canvas.addEventListener('webglcontextlost', () => (told = true), { once: true })
    ext.loseContext()
    document.querySelector<HTMLElement>('[data-nav=editor]')!.click()
    return told
  })
  ok(!heard, 'a press lands before the loss has been announced')
  ok(await until(() => hasEl(p, '[data-testid=editor-ui]'), 3000), 'Road Editor opens from that press too')
  ok(!(await hasEl(p, CRASH)) && (await rootSize(p)) > 0, 'no crash from it')
  await restore(p)
  await p.page.close()

  // ---- gone, then into a race with real presses; it comes back and the car drives
  p = await openPhone(name, TITLE, READY)
  await lose(p)
  await sleep(200)
  await pressNav(p, 'play')
  await sleep(350)
  await pressNav(p, 'mode:race')
  await sleep(350)
  await pressNav(p, 'track:afterglow')
  ok(await until(() => hasEl(p, '.touch'), 5000), 'into a race while the picture is gone')
  ok(!(await hasEl(p, CRASH)) && (await rootSize(p)) > 0, 'not blank, no crash screen')
  await restore(p)
  ok(await until(async () => (await look(p)).post.passes >= 2, 3000), 'the picture comes back in the race')
  const gas = (await boxOf(p, '.touch-pedal--gas'))!
  await p.down({ ...gas, id: 1 })
  ok(await until(async () => (await speedNow(p)) > 5, 9000), 'the car drives', { kmh: await speedNow(p) })
  await sleep(2000)
  ok((await litShare(p)) > 0.03, 'the race is on the screen')
  await p.page.screenshot({ path: `${OUT}/lost-${name}-3-race-back.png` })

  // ---- to the background and back during normal play: nothing breaks, the car and the sound carry on
  const frames0 = (await frameNow(p)).n
  const other = await browser.newPage()
  await other.bringToFront()
  await sleep(2500)
  ok((await p.page.evaluate(() => document.visibilityState)) === 'hidden', 'the game is really in the background')
  await p.page.bringToFront()
  ok(await until(async () => (await frameNow(p)).n > frames0 + 30, 4000), 'it runs again when it comes back', { frames: (await frameNow(p)).n - frames0 })
  ok(!(await p.page.evaluate(() => (window as unknown as { __glCheck: { gl: WebGL2RenderingContext } }).__glCheck.gl.isContextLost())), 'the context stayed')
  // (Not "running": in headless Chrome the AudioContext stays suspended after this on the build before scenario 24 too.)
  ok(await until(async () => { const a = await audioNow(p); return a.hidden === false && a.state !== 'closed' }, 3000), 'the sound system knows it is back and was not torn down', await audioNow(p))
  ok((await speedNow(p)) > 5, 'the car is still driving', { kmh: await speedNow(p) })

  // ---- gone while hidden: only time someone could see counts
  await lose(p)
  await other.bringToFront()
  await sleep(11000)
  await p.page.bringToFront()
  await sleep(1000)
  ok(!(await hasEl(p, CRASH)), 'eleven seconds gone in the background do not count towards the crash screen')
  await restore(p)
  ok(await until(async () => (await look(p)).post.passes >= 2, 3000), 'it comes back on its return')
  await p.lift()
  await other.close()
  await p.page.close()

  // ---- gone for good, in the Road Editor with a road half drawn; Reload keeps the road
  p = await openPhone(name, TITLE, READY)
  await pressNav(p, 'editor')
  ok(await until(() => hasEl(p, '[data-testid=editor-ui]'), 4000), 'Road Editor opens')
  await sleep(800)
  await p.hidePanels(true)
  await p.ed('tool', 'pencil')
  await p.drag(Array.from({ length: 25 }, (_, i) => ({ x: 240 + i * 16, y: p.h * 0.35 + Math.sin(i / 4) * 40 })))
  await sleep(300)
  const road = await p.roadPoints()
  ok(road.length > 2, 'a finger has drawn a road', { points: road.length })
  ok((await p.page.evaluate(() => document.visibilityState)) === 'visible', 'this page is the one showing: only visible time counts')
  await lose(p)
  await sleep(5500)
  ok(!(await hasEl(p, CRASH)), 'not given up yet after five and a half seconds')
  ok(await until(() => hasEl(p, CRASH), 8000), 'the context stays gone: the crash screen comes up')
  const words = await crashScreenFits(p, inset)
  ok(/didn't come back/.test(words) && !/Something broke/.test(words), 'it says the picture went', words)
  await p.page.screenshot({ path: `${OUT}/lost-${name}-4-crash-screen.png` })
  const reload = (await boxOf(p, `${CRASH} button`))!
  await p.tap(reload)
  ok(await until(async () => !(await sameLoad(p)) && (await hasEl(p, READY)), 12000), 'a real finger on Reload starts the game again')
  await sleep(1500)
  await pressNav(p, 'editor')
  ok(await until(() => hasEl(p, '[data-testid=editor-ui]'), 4000), 'Road Editor opens after the reload')
  await sleep(500)
  ok(JSON.stringify(await p.roadPoints()) === JSON.stringify(road), 'the road being drawn was kept', { points: road.length })
  ok((await p.sum()).undoSteps === 0, 'what a reload does lose: Undo starts empty')
  await p.page.close()

  // ---- any other crash while React draws: the same screen, in its other words
  p = await openPhone(name, TITLE, READY)
  crashOnPurpose = true
  await p.page.evaluate(() => {
    WebGL2RenderingContext.prototype.getContextAttributes = () => null
  })
  await pressNav(p, 'editor')
  ok(await until(() => hasEl(p, CRASH), 3000), 'a crash in a render shows the crash screen, the page is not blank', { root: await rootSize(p) })
  const other2 = await crashScreenFits(p, inset)
  ok(/Something broke/.test(other2), 'it says something broke', other2)
  await p.page.close()
  crashOnPurpose = false
}

/** 24 at 1920x1080: the same screen, a real mouse. */
async function crashScreenDesktop() {
  const page = await browser.newPage()
  page.on('pageerror', (e) => ok(false, 'page error', String((e as Error).stack ?? (e as Error).message).slice(0, 600)))
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
  await page.goto(`http://localhost:${port}/?nomusic=1&quality=low`, { waitUntil: 'load' })
  const p = new Phone(page, await page.createCDPSession(), 1920, 1080)
  ok(await until(() => hasEl(p, '[data-nav=editor]'), 20000), 'the title is up')
  await sleep(2500)
  await lose(p)
  ok(await until(() => hasEl(p, CRASH), 10000), 'the context stays gone: the crash screen comes up')
  await crashScreenFits(p, { left: 0, right: 0, bottom: 0 })
  await page.screenshot({ path: `${OUT}/lost-desktop-crash-screen.png` })
  const b = (await boxOf(p, `${CRASH} button`))!
  await page.mouse.click(b.x, b.y)
  ok(await until(async () => !(await sameLoad(p)) && (await hasEl(p, '[data-nav=editor]')), 12000), 'a real mouse on Reload starts the game again')
  await page.close()
}

/**
 * 23. Nathan, 5 Nov 2026 (P8): on a phone each road label shows only with the tool that changes it. RAISED and DUG with Height,
 * BANK with Bank, WIDTH with Width, the crossing's pill with Select. A hidden label can't be tapped either, so a tap where it
 * would be acts as the tool in hand does on bare road. A computer keeps every label with every tool.
 */
async function labelsByTool(p: Phone, phone: boolean) {
  await p.hidePanels(false)
  await p.ed('newTrackNow')
  await sleep(300)
  await p.ed('shape', 'eight')
  await sleep(1500)
  await p.ed('fit')
  await p.ed('tool', 'select')
  await sleep(300)
  type Mark = { tool: string; from: number; to: number; value: number; label: { sx: number; sy: number } }
  const marks = async () => (await p.ed('marks')) as Mark[]
  const n = (await p.sum()).points as number
  // One stretch of each kind on stretches of road of their own (the dice may refuse a spot: try the next).
  const kinds: [string, string, number][] = [['raise', 'height', 5], ['raise', 'height', -2], ['bank', 'bank', 14], ['width', 'width', 20]]
  let at = 1
  for (const [cmd, tool, v] of kinds) {
    for (; at < n; at += 2) {
      const before = await p.road()
      await p.ed(cmd, [at, at + (cmd === 'raise' ? 6 : 2), v])
      await sleep(120)
      if ((await p.road()) === before) continue
      // Landed only if its own label shows with its own tool (a raised stretch by a crossing gets the crossing's BRIDGE instead).
      await p.ed('tool', tool)
      await sleep(150)
      const got = (await marks()).some((m) => m.tool === tool && Math.sign(m.value) === Math.sign(v))
      if (got) break
      await p.ed('undo')
    }
    at += Math.round(n / 5)
  }
  await p.ed('tool', 'select')
  await sleep(300)
  const crossings = async () => ((await p.ed('crossings')) as { screen: { label: { sx: number; sy: number } | null } | null }[]).filter((c) => c.screen)
  // (Select shows the crossing's pill and, with nothing else from the three kinds, none of theirs: the allMarks below are read per tool.)
  const read = async (tool: string) => {
    await p.ed('tool', tool)
    await sleep(250)
    return { marks: await marks(), pills: (await crossings()).filter((c) => c.screen!.label).length }
  }
  const per: Record<string, Awaited<ReturnType<typeof read>>> = {}
  for (const tool of TOOLS) per[tool] = await read(tool)
  // (Every label that exists: on a phone each tool only shows its own, so the union of the tools.)
  const all = TOOLS.flatMap((tool) => per[tool].marks).filter((m, i, a) => a.findIndex((x) => x.from === m.from && x.to === m.to && x.tool === m.tool) === i)
  const hasKinds = ['height', 'bank', 'width'].every((k) => all.some((m) => m.tool === k)) && all.some((m) => m.tool === 'height' && m.value < 0) && all.some((m) => m.tool === 'height' && m.value > 0)
  ok(hasKinds && (await crossings()).length >= 1, 'a road with a raised stretch, a dug one, a banked one, a width one and a crossing', { marks: all.length, crossings: (await crossings()).length })
  const kindsIn = (tool: string) => [...new Set(per[tool].marks.map((m) => m.tool + (m.tool === 'height' ? (m.value < 0 ? '-' : '+') : '')))].sort().join(',')
  if (!phone) {
    for (const tool of TOOLS) ok(kindsIn(tool) === 'bank,height+,height-,width' && per[tool].pills >= 1, `a computer, ${tool}: every label shows`, { kinds: kindsIn(tool), pills: per[tool].pills })
    return
  }
  for (const tool of TOOLS) {
    const want = tool === 'height' ? 'height+,height-' : tool === 'bank' ? 'bank' : tool === 'width' ? 'width' : ''
    ok(kindsIn(tool) === want, `${tool}: the labels drawn (and tappable) are ${want || 'none'}`, { got: kindsIn(tool) })
    ok(per[tool].pills === (tool === 'select' ? (await crossings()).length : 0), `${tool}: ${tool === 'select' ? "the crossing's pill shows" : 'no crossing pill'}`, { pills: per[tool].pills })
  }
  // The right tool in hand: a tap on the label does what it did.
  const jump = async (tool: string, m: Mark) => {
    await p.ed('tool', tool)
    await sleep(250)
    const spot = (await marks()).find((x) => x.from === m.from && x.to === m.to)!.label
    await p.tap({ x: spot.sx, y: spot.sy })
    await sleep(250)
    const s = await p.sum()
    const good = s.selection?.kind === 'section' && Math.abs(s.selection.from - m.from) < 0.01
    if (!good) console.log('  tap missed', tool, JSON.stringify({ spot, onMap: await p.onMap({ x: spot.sx, y: spot.sy }), sel: s.selection }))
    return good
  }
  for (const k of ['height', 'bank', 'width']) {
    const m = all.find((x) => x.tool === k)!
    ok(await jump(k, m), `${k}: a tap on its own label picks that stretch up`)
  }
  // Tap-through: the label's spot read with its tool, then another tool in hand and a finger on that spot.
  const road0 = await p.road()
  for (const [from, k] of [['height', 'straight'], ['height', 'pencil'], ['bank', 'curve'], ['width', 'bend']] as const) {
    const m = all.find((x) => x.tool === from)!
    await p.ed('tool', from)
    await sleep(250)
    const spot = (await marks()).find((x) => x.from === m.from && x.to === m.to)!.label
    await p.ed('tool', k)
    await sleep(250)
    await p.tap({ x: spot.sx, y: spot.sy })
    await sleep(300)
    const s = await p.sum()
    ok(s.tool === k && s.selection?.kind !== 'section', `${k} on a hidden ${from} label's spot: the ${k} tool acts, nothing jumps`, { tool: s.tool, selection: s.selection?.kind ?? null })
  }
  await p.ed('tool', 'select')
  await sleep(250)
  const cl = (await crossings()).find((c) => c.screen!.label)!.screen!.label!
  await p.ed('tool', 'straight')
  await sleep(250)
  await p.tap({ x: cl.sx, y: cl.sy })
  await sleep(300)
  const sc = await p.sum()
  ok(sc.tool === 'straight' && sc.selection?.kind !== 'crossing', "straight on a hidden crossing pill's spot: nothing is selected", { tool: sc.tool, selection: sc.selection?.kind ?? null })
  await p.ed('tool', 'select')
  await sleep(250)
  const cl2 = (await crossings()).find((c) => c.screen!.label)!.screen!.label!
  await p.tap({ x: cl2.sx, y: cl2.sy })
  await sleep(300)
  ok((await p.sum()).selection?.kind === 'crossing', 'select: a tap on the crossing pill selects it')
  await p.ed('tool', 'pencil')
  await sleep(250)
  ok((await p.sum()).selection === null, 'and a tool change lets it go: no card is left open on a crossing with no pill')

  // A road label never sits under a button round the map's edge (P10): slide the map so each label falls on each fixed element in turn.
  type Rect = { x0: number; y0: number; x1: number; y1: number }
  const fixed = async (): Promise<{ name: string; r: Rect }[]> => {
    const dom = await p.page.evaluate(() => {
      const out: { name: string; r: Rect }[] = []
      const add = (name: string, e: Element | null) => {
        if (!e || !(e as HTMLElement).checkVisibility()) return
        const b = e.getBoundingClientRect()
        out.push({ name, r: { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom } })
      }
      add('tool button', document.querySelector('.phone-tool'))
      add('undo and redo', document.querySelector('.phone-undo'))
      document.querySelectorAll('.phone-stack > *').forEach((e, i) => add(`right column ${i}`, e))
      return out
    })
    const v = (await p.ed('view')) as { scaleBox: Rect }
    return [...dom, { name: 'scale', r: v.scaleBox }]
  }
  const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
  const pillBoxes = async (tool: string) => {
    await p.ed('tool', tool)
    await sleep(250)
    if (tool === 'select') return ((await p.ed('crossings')) as { screen: { box: Rect | null } | null }[]).flatMap((c) => (c.screen?.box ? [c.screen.box] : []))
    return (await marks()).map((m) => (m as Mark & { box: Rect }).box)
  }
  let landed = 0
  const shown: string[] = []
  for (const tool of ['height', 'bank', 'width', 'select']) {
    for (const el of await fixed()) {
      await p.ed('fit')
      await sleep(200)
      const from = (await pillBoxes(tool))[0]
      if (!from) continue
      const v0 = (await p.ed('view')) as { cx: number; cz: number; mpp: number }
      const dx = (el.r.x0 + el.r.x1) / 2 - (from.x0 + from.x1) / 2
      const dy = (el.r.y0 + el.r.y1) / 2 - (from.y0 + from.y1) / 2
      await p.ed('view', [v0.cx - dx * v0.mpp, v0.cz - dy * v0.mpp, v0.mpp])
      await sleep(300)
      const now = await pillBoxes(tool)
      const under = [...now.entries()].filter(([, b]) => (b ? hit(b, el.r) : false))
      if (now.length) landed++
      shown.push(`${tool}@${el.name}:${now.length}`)
      ok(under.length === 0, `${tool}: slid onto the ${el.name}, no label sits under it`, { under: under.length, boxes: now.length })
    }
  }
  ok(landed >= 4, 'and the labels do still show where there is room (not every one hidden)', { landed, shown: shown.join(' ') })
  await p.ed('fit')
  void road0
}


// ---------------------------------------------------------------- 25. the words

/** What no line on a phone may say: a mouse, a key, a wheel, the computer's "panel on the right" (spec/phone-landscape-standard.md rule 8, plus the editor's own). */
const KEY_WORDS = /click|\bmouse\b|\bwheel\b|\bEsc\b|\bEscape\b|\bShift\b|\bpanel\b|hover|right-drag|middle-drag|\bpress |\[ and \]|on the right|keyboard|controller|WASD|\b(?:Enter|Return|Space|Spacebar|Backspace|Tab|Ctrl|Control|Alt|Cmd|arrow keys?|any key)\b/i

/** Every line the page has shown since it loaded, with the element it went into. */
const wordsSeen = (p: Phone) => p.page.evaluate(() => [...(window as unknown as { __wordsSeen: Map<string, string> }).__wordsSeen.entries()])

/**
 * 25. The words on a phone. A real walk through everything that talks: every tool and piece, the Menu and its Map key, the
 * question box, Checks with real problems, 3D, and the gestures that say something mid-press (Bend, Straight, Curve, Place,
 * the pencil's thumb). Then the page's own record of every line it ever showed (watchWords) is read: none may name a click,
 * the mouse, a wheel, Shift, Esc or "the panel", and each line written by hand for a finger must really have been shown.
 * When the whole suite runs on this page, the other scenarios' gestures count too.
 */
async function wordsOnTouch(p: Phone) {
  await p.hidePanels(false)
  const box = (sel: string, nth = 0) =>
    p.page.evaluate(
      (s: string, i: number) => {
        const e = document.querySelectorAll<HTMLElement>(s)[i]
        if (!e || !e.checkVisibility()) return null
        let r = e.getBoundingClientRect()
        // (Only what is off the screen is scrolled to: the card and the tray scroll by themselves.)
        if (r.bottom > innerHeight - 20 || r.top < 0) {
          e.scrollIntoView({ block: 'nearest' })
          r = e.getBoundingClientRect()
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      sel,
      nth,
    )
  const press = async (sel: string, nth = 0) => {
    const b = await box(sel, nth)
    if (!b) return false
    await p.tap(b)
    await sleep(120)
    return true
  }
  const pressText = async (sel: string, text: string) => {
    const at = await p.page.evaluate(
      (s: string, t: string) => {
        const e = [...document.querySelectorAll<HTMLElement>(s)].find((b) => b.textContent?.trim().startsWith(t))
        if (!e) return null
        let r = e.getBoundingClientRect()
        if (r.bottom > innerHeight - 20 || r.top < 0) {
          e.scrollIntoView({ block: 'nearest' })
          r = e.getBoundingClientRect()
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      },
      sel,
      text,
    )
    if (!at) return false
    await p.tap(at)
    await sleep(150)
    return true
  }
  const count = (sel: string) => p.page.evaluate((s: string) => document.querySelectorAll(s).length, sel)
  const done = async () => void (await press('[data-testid=phone-done]'))
  const trayUp = async () => (await count('[data-testid=phone-tray]')) > 0
  /** Pick a tool from the tray, as a thumb does (the tray opens first unless it is already up). */
  const pickTool = async (t: string) => {
    if (!(await trayUp())) await press('[data-testid=phone-tool]')
    await press(`[data-testid=phone-tray] [data-rail=${t}]`)
    await sleep(80)
  }
  /** Open the card of the tool in hand, from the tray's setting row. */
  const openCard = async () => {
    if (!(await trayUp())) await press('[data-testid=phone-tool]')
    await press('[data-testid=phone-tool-row]')
    await sleep(120)
  }
  const seen0 = (await wordsSeen(p)).length

  // ---- the empty map: every tool, its line and its card; every piece
  await p.ed('newTrackNow')
  await sleep(500)
  for (const t of TOOLS) {
    await pickTool(t)
    if (t === 'place') {
      const n = await count('.sre-piece')
      for (let i = 0; i < n; i++) {
        if (!(await box('.sre-piece', i))) {
          await pickTool('place')
          await openCard()
        }
        await press('.sre-piece', i)
      }
      await done()
    } else {
      await openCard()
      await done()
    }
  }
  ok((await count('.sre-piece')) >= 0, 'walked every tool and piece on the empty map')

  // ---- the Menu: its Map key, Track, Random track
  await press('[data-testid=phone-menu-open]')
  await press('[data-testid=phone-menu-key]')
  await pressText('.phone-menu-nav button', 'Track')
  await pressText('.phone-menu-nav button', 'Random track')
  await press('[data-testid=editor-random-yes]')
  await sleep(1800)
  ok((await p.sum()).points > 10, 'Random track from the Menu made a road', { points: (await p.sum()).points })
  // (The Menu closes itself when it starts something.) The question box over a road with changes: New track, then Random track.
  await press('[data-testid=phone-menu-open]')
  await pressText('.phone-menu-nav button', 'New track')
  await sleep(200)
  await press('[data-testid=editor-ask-cancel]')
  await press('[data-testid=phone-menu-open]')
  await pressText('.phone-menu-nav button', 'Random track')
  await sleep(200)
  await press('[data-testid=editor-ask-cancel]')
  // Smooth the road, from the Menu's Track page: it says what it did.
  await press('[data-testid=phone-menu-open]')
  await pressText('.phone-menu-nav button', 'Track')
  await pressText('button', 'Smooth the road')
  await sleep(500)
  await press('[data-testid=phone-menu-back]')

  // ---- a road: the gestures that talk while a finger is down
  await p.freshRoad()
  await p.hidePanels(false)
  const n = (await p.sum()).points
  /** Two spots on the road that a finger can reach (clear of the buttons round the edge). */
  const reachable = async (): Promise<(Spot & { at: number })[]> => {
    const out: (Spot & { at: number })[] = []
    for (let k = 0; k < n * 2 && out.length < 6; k++) {
      const at = k / 2
      const s = await screenOf(p, at)
      if (s.x < 150 || s.x > p.w - 200 || s.y < 60 || s.y > p.h - 70) continue
      if (out.every((o) => Math.hypot(o.x - s.x, o.y - s.y) > 60)) out.push({ ...s, at })
    }
    return out
  }
  const spots = await reachable()
  ok(spots.length >= 4, 'road spots a finger can reach', { found: spots.length })
  const [A, B, C, D] = spots
  const off = await offRoad(p)
  const slide = async (from: Spot, to: Spot, steps = 8) => {
    await p.down({ ...from, id: 1 })
    await sleep(40)
    for (let i = 1; i <= steps; i++) {
      await p.move({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 })
      await sleep(14)
    }
  }
  // Pencil: a tap says how it works; the thumb's Straight line says how to go back to freehand.
  await p.ed('tool', 'pencil')
  await sleep(150)
  if (C) await p.tap(C)
  const lineY = Math.round(p.h * 0.5)
  await p.down({ x: p.w * 0.3, y: lineY, id: 1 })
  for (let i = 1; i <= 16; i++) {
    await p.move({ x: p.w * 0.3 + i * 6, y: lineY + Math.sin(i / 2) * 20, id: 1 })
    await sleep(12)
  }
  const thumb = await box('[data-testid=thumb-straight]')
  if (thumb) {
    await p.down({ x: p.w * 0.3 + 96, y: lineY, id: 1 }, { ...thumb, id: 2 })
    await sleep(50)
    await p.liftOne({ ...thumb, id: 2 })
    await sleep(100)
  }
  await p.cancel()
  await sleep(200)
  ok(!!thumb, 'the thumb had a Straight line button while a finger drew')
  // Bend: a tap, then a pull, then a pull too hard for a car, and the plus beside the thumb.
  await p.ed('tool', 'bend')
  await sleep(150)
  if (A) await p.tap(A)
  if (B) {
    await slide(B, { x: B.x + 70, y: B.y + 40 })
    await sleep(120)
    for (let i = 1; i <= 4; i++) {
      await p.move({ x: B.x + 70 + i * 18, y: B.y + 40 + i * 13, id: 1 })
      await sleep(14)
    }
    await sleep(120)
    await p.cancel()
    await sleep(150)
    await p.ed('bend', [B.at, 400, 400])
    await sleep(150)
  }
  // Straight: off the road, the first end, the far end previewed and lifted.
  await p.ed('tool', 'straight')
  await sleep(150)
  if (off) await p.tap(off)
  if (A && B) {
    await p.tap(A)
    await p.down({ ...B, id: 1 })
    await sleep(150)
    await p.lift()
    await sleep(200)
  }
  await p.ed('tool', 'pencil')
  // Curve: both ends, then the pull.
  await p.ed('tool', 'curve')
  await sleep(150)
  if (off) await p.tap(off)
  if (A && C) {
    await p.tap(A)
    await p.tap(C)
    if (off) {
      await p.down({ ...off, id: 1 })
      await sleep(150)
      await p.lift()
      await sleep(200)
    }
  }
  await p.ed('tool', 'pencil')
  // Height, Bank and Width: off the road, on it, and a drag along it; and a card for each.
  for (const t of ['height', 'bank', 'width']) {
    await p.ed('tool', t)
    await sleep(150)
    if (off) await p.tap(off)
    if (A) await p.tap(A)
    if (C && D) await slide(C, D)
    await p.lift()
    await sleep(250)
    await done()
    await p.ed(t === 'height' ? 'raise' : t, t === 'height' ? [1, 3, 6] : [1, 3, t === 'bank' ? 12 : 14])
    await sleep(200)
    await p.ed('tool', 'select')
    await sleep(100)
    const m = await screenOf(p, 2)
    if (m.x > 150 && m.x < p.w - 200 && m.y > 60 && m.y < p.h - 70) await p.tap(m)
    await sleep(200)
    await done()
  }
  // Select: a double tap adds a point.
  await p.ed('tool', 'select')
  if (B) {
    await p.tap(B, 30)
    await p.tap(B, 30)
  }
  await done()
  // Place: a ramp off the road, a wall ride and a tunnel on it (dragged to draw how long).
  for (const label of ['Ramp', 'Wall ride (left)', 'Tunnel', 'Start line']) {
    await pickTool('place')
    await pressText('.sre-piece', label)
    if (off) await p.tap(off)
    if (A) await p.tap(A)
    await sleep(150)
  }
  // Checks with real problems: a tight corner, a steep bank, then the card and a row.
  await p.ed('tool', 'select')
  await p.ed('corner', [3, 3])
  await p.ed('bank', [4, 6, 80])
  await sleep(2500)
  await press('[data-testid=phone-checks]')
  await sleep(400)
  const rows = await count('.sre-issue')
  for (let i = 0; i < Math.min(rows, 3); i++) {
    await press('.sre-issue', i)
    await sleep(300)
    await press('[data-testid=editor-fix-it]')
    await sleep(600)
  }
  await done()
  await p.ed('fixAll')
  await sleep(500)
  await done()
  // 3D: the note.
  await press('[data-testid=editor-3d-button]')
  await sleep(1200)
  await press('[data-testid=editor-3d-button]')
  await sleep(300)

  // ---- what the page showed
  const seen = await wordsSeen(p)
  // (Another scenario's injected <style> mentions .sre-panel: CSS is not a line a player reads.)
  const bad = seen.filter(([t, where]) => !/^(style|script)\./.test(where) && KEY_WORDS.test(t))
  ok(seen.length - seen0 > 40, 'the walk showed plenty of lines (not an empty look)', { lines: seen.length - seen0, total: seen.length })
  ok(bad.length === 0, 'no line shown on a phone names a click, the mouse, a wheel, Shift, Esc or the panel', bad.slice(0, 6).map(([t, where]) => `${where}: ${t.slice(0, 110)}`))
  const mustSay: [RegExp, string][] = [
    [/^Keep a finger down and draw:/, 'a tap with the pencil'],
    [/^Straight line: tap it again to carry on drawing freehand/, 'the thumb\'s Straight line'],
    [/^Put a finger on the road and drag to bend it/, 'a tap with Bend'],
    [/^While you draw, tap Straight line with your other thumb/, "the pencil's card"],
    [/^How much road comes with your hand\. Short for a small nudge, long for a big sweeping bend\. While you drag, tap - or \+ with your other thumb/, "Bend's card"],
    [/^Put a finger down and pull the middle out, then let go/, "Curve's card"],
    [/^Now put a finger down and slide to pull the curve out, then let go/, "Curve's last step"],
    [/^Tap the road where the (straight|curve) should start/, 'a tap off the road with Straight or Curve'],
    [/Tap it with the Height tool to change its height/, 'the Map key'],
    [/Tap Random track in the Menu for another, or Undo\.$/, 'Random track'],
    [/Set how high its middle goes, or tap Make it a tunnel on the card/, "Height's card"],
    [/^Two fingers: drag moves, pinch zooms, twist turns/, 'the 3D note'],
  ]
  for (const [re, what] of mustSay) ok(seen.some(([t]) => re.test(t)), `shown for a finger: ${what}`, re.source.slice(0, 60))
  await p.hidePanels(true)
}

/**
 * 25 on a computer: the same lines as before. A walk with the keyboard and the mouse, the lines the page showed written
 * down (--dump), and the old words checked in place. Run the same dump on the build before this change and diff the two.
 */
async function wordsOnDesktop() {
  const p = await openDesktop()
  const m = p.page.mouse
  const key = async (k: string) => {
    await p.page.keyboard.press(k)
    await sleep(120)
  }
  await p.ed('newTrackNow')
  await sleep(400)
  const rail = async (id: string) => {
    const b = await p.page.evaluate((i: string) => {
      const r = document.querySelector(`[data-rail=${i}]`)?.getBoundingClientRect()
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
    }, id)
    if (b) await m.click(b.x, b.y)
    await sleep(120)
  }
  for (const t of ['select', 'straight', 'curve', 'bend', 'bank', 'height', 'width', 'pencil', 'place']) await rail(t)
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) await key(`Digit${d}`)
  await rail('select')
  await rail('pencil')
  await p.ed('random', 7)
  await sleep(1800)
  await p.ed('fit')
  const n = (await p.sum()).points
  const A = await p.roadNear(700, 400)
  const B = await p.roadNear(1000, 500)
  await p.ed('tool', 'pencil')
  await m.click(A.x, A.y)
  await sleep(150)
  await p.ed('tool', 'bend')
  await m.move(B.x, B.y)
  await m.down()
  await m.move(B.x + 90, B.y + 60, { steps: 6 })
  await m.move(B.x + 400, B.y + 300, { steps: 6 })
  await m.up()
  await sleep(150)
  await p.ed('undo')
  await p.ed('tool', 'straight')
  await m.click(10, 10)
  await m.click(A.x, A.y)
  await sleep(100)
  await p.ed('tool', 'curve')
  await m.click(A.x, A.y)
  await m.click(B.x, B.y)
  await sleep(100)
  await key('Escape')
  for (const t of ['height', 'bank', 'width']) {
    await p.ed('tool', t)
    await m.click(10, 10)
    await m.click(A.x, A.y)
    await sleep(200)
  }
  await p.ed('corner', [3, 3])
  await p.ed('bank', [4, 6, 80])
  await p.ed('random', 9)
  await sleep(1800)
  await key('KeyT')
  await sleep(1000)
  await key('KeyT')
  await sleep(300)
  void n
  const seen = await wordsSeen(p)
  const texts = seen.map(([t]) => t).sort()
  ok(texts.length > 40, 'the walk showed plenty of lines', { lines: texts.length })
  const old: [RegExp, string][] = [
    [/^Hold Shift while you draw for a dead straight line\. Let go of Shift to carry on freehand\./, "the pencil's card"],
    [/mouse wheel, or \[ and \]\./, "Bend's card"],
    [/^Draw a loop with the pencil, or press Random track\./, 'the empty note'],
    [/^Pencil: start on the road and end back on the road to redraw the bit in between\. Hold Shift while you draw for a straight line\./, "the pencil's line"],
    [/^Select: click a piece or road point, drag to move it, Delete removes it\. Double-click the road to add a point\./, "Select's line"],
    [/^Bend: grab one spot on the road and pull it, and the road around it follows\. The mouse wheel \(or \[ and \]\) changes how much road comes with it\./, "Bend's line"],
    [/Click it to change its height\./, 'the Map key'],
    [/^Right-drag to look round\. Middle-drag or Space \+ drag to move\. Wheel to zoom\./, 'the 3D note'],
    [/in the panel on the right/, "the stretch tools' card"],
  ]
  for (const [re, what] of old) ok(texts.some((t) => re.test(t)), `a computer still reads the old words: ${what}`)
  if (dumpTo) {
    await Bun.write(dumpTo, JSON.stringify(texts, null, 1))
    console.log(`wrote ${texts.length} lines to ${dumpTo}`)
  }
  await p.page.close()
}

// ---------------------------------------------------------------- run

const wanted = (n: string) => !only.length || only.includes(n)
for (const name of windowNames) {
  windowName = name
  const { w, h } = WINDOWS[name]
  const needsPhone = ['1', '2', '3', '4', '5', '6', '7', '8', '10', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '23', '25'].some(wanted)
  if (needsPhone) {
    const p = await openPhone(name, 'editor=1&touch=1&nomusic=1&quality=low')
    scenario = '0 setup'
    const size = await p.page.evaluate(() => [innerWidth, innerHeight])
    ok(size[0] === w && size[1] === h, 'the window is the size it should be', size)
    const inset = await p.page.evaluate(() => {
      const e = document.createElement('div')
      e.style.cssText = 'position:fixed;left:env(safe-area-inset-left);bottom:env(safe-area-inset-bottom)'
      document.body.append(e)
      const c = getComputedStyle(e)
      const out = [c.left, c.bottom]
      e.remove()
      return out
    })
    ok(inset[0] === '62px' && inset[1] === '20px', 'the notch insets took', inset)
    ok(await p.page.evaluate(() => !!document.querySelector('.sre[data-touch]')), 'the editor knows it is on a phone')
    ok(await p.page.evaluate(() => document.querySelector<HTMLElement>('.sre-overlay')!.style.width === `${innerWidth}px`), 'the map layer is as wide as the window')
    ok(await p.page.evaluate(() => !document.dispatchEvent(new Event('gesturestart', { cancelable: true }))), "Safari's own pinch of the page is turned off")
    await p.hidePanels(true)
    await p.ed('fit')
    const runs: [string, string, () => Promise<void>][] = [
      ['1', '1 pencil loop', () => pencilLoop(p)],
      ['2', '2 pinch, every tool', () => pinchEveryTool(p)],
      ['3', '3 two-finger drag, every tool', () => dragEveryTool(p)],
      ['4', '4 second finger early', () => secondFingerEarly(p)],
      ['5', '5 second finger late', () => secondFingerLate(p)],
      ['6', '6 touch cancelled', () => cancelled(p)],
      ['7', '7 one finger as before', () => oneFinger(p)],
      ['8', '8 in 3D', () => in3d(p)],
      ['10', '10 the tool button', () => toolButton(p)],
      ['12', '12 New track over warnings', () => newTrackOverWarnings(p, 'finger')],
      ['13', '13 Straight and Curve on lift', () => shapesOnLift(p)],
      ['14', '14 Place on lift', () => placeOnLift(p)],
      ['15', '15 how far a finger reaches', () => reaches(p)],
      ['16', '16 lift while dragging', () => liftWhileDragging(p)],
      ['17', '17 double tap', () => doubleTapTolerance(p)],
      ['18', '18 off the road pans', () => offRoadPans(p)],
      ['19', '19 the other thumb', () => thumbButtons(p)],
      ['21', '21 the scale and the tool words', () => scaleAndWords(p)],
      ['22', '22 the tunnel footprint under a thumb', () => tunnelHold(p)],
      ['23', '23 road labels with their own tool', () => labelsByTool(p, true)],
      ['25', '25 the words on a phone', () => wordsOnTouch(p)],
    ]
    for (const [n, label, run] of runs) {
      if (!wanted(n)) continue
      scenario = label
      await run().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
    }
    await p.page.close()
  }
  if (wanted('11')) {
    scenario = '11 world map'
    await worldMap(name).catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
  }
  if (wanted('24')) {
    scenario = '24 the picture goes away'
    await contextLost(name).catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
  }
}
if (wanted('9')) {
  windowName = 'desktop'
  scenario = '9 mouse and pen'
  await mouseAndPen().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('22')) {
  windowName = 'desktop'
  scenario = '22 the tunnel footprint under a thumb'
  await tunnelHoverDesktop().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('23')) {
  windowName = 'desktop'
  scenario = '23 road labels on a computer'
  await openDesktop()
    .then(async (p) => {
      await labelsByTool(p, false)
      await p.page.close()
    })
    .catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('21')) {
  windowName = 'desktop'
  scenario = '21 the scale and the tool words'
  await scaleOnDesktop().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('20')) {
  windowName = 'desktop'
  scenario = '20 mouse unchanged'
  await mouseUnchanged().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('12')) {
  windowName = 'desktop'
  scenario = '12 New track over warnings'
  await openDesktop()
    .then(async (p) => {
      await newTrackOverWarnings(p, 'mouse')
      await p.page.close()
    })
    .catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('25')) {
  windowName = 'desktop'
  scenario = '25 the words on a computer'
  await wordsOnDesktop().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
if (wanted('24')) {
  windowName = 'desktop'
  scenario = '24 the picture goes away'
  await crashScreenDesktop().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
}
await browser.close()
console.log(fails ? `\n${fails} FAILED. Red scenarios: ${[...red].sort((a, b) => Number(a) - Number(b)).join(', ')}` : '\nALL PASS')
process.exit(fails ? 1 : 0)
