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
//  (layout C), 9 a real mouse at 1920x1080, 12 both.
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
  /** A road to work on, framed, with every tool's last state gone. */
  async freshRoad() {
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

async function openPhone(name: string, query: string): Promise<Phone> {
  const { w, h, insets } = WINDOWS[name]
  const page = await browser.newPage()
  page.on('pageerror', (e) => ok(false, 'page error', String((e as Error).stack ?? (e as Error).message).slice(0, 600)))
  await page.setUserAgent(UA)
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets } as never)
  // Each window starts on an empty map, not on whatever the last one left in the working copy.
  await page.evaluateOnNewDocument(() => localStorage.removeItem('sr2.editor.working.v1'))
  await page.goto(`http://localhost:${port}/?${query}`, { waitUntil: 'load' })
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid=editor-ui]') || !!document.querySelector('.touch')).catch(() => false)) break
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
    ok(new RegExp(t === 'place' ? 'Pieces' : t, 'i').test(name), 'and the button says so', name)
    if (t === 'place') {
      ok(!!(await box('.phone-card .sre-palette')), 'Place opens on its palette')
      await press('.phone-card .sre-piece')
      ok(!(await box('.phone-card')), 'picking a piece folds the card')
      ok(/Boost/.test((await box('[data-testid=phone-chip]'))?.text ?? ''), 'to a chip naming the piece', (await box('[data-testid=phone-chip]'))?.text)
    }
  }

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
  const v = (await p.ed('view')) as { scaleX: number; scaleUp: number }
  const fr = await free()
  ok(v.scaleX >= fr.left && v.scaleX + 245 <= fr.right && v.scaleUp >= 20, 'the scale bar sits inside the free map, clear of the home bar', v)
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

  // The Menu.
  await press('[data-testid=phone-menu-open]')
  ok(!!(await box('[data-testid=phone-menu]')), 'Menu opens')
  ok(!!(await box('[data-testid=phone-menu-back]')), 'with a way back on its first screen')
  await press('[data-testid=phone-menu-back]')
  ok(!(await box('[data-testid=phone-menu]')), 'and Back to the map closes it')
  await p.hidePanels(true)
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

// ---------------------------------------------------------------- run

const wanted = (n: string) => !only.length || only.includes(n)
for (const name of windowNames) {
  windowName = name
  const { w, h } = WINDOWS[name]
  const needsPhone = ['1', '2', '3', '4', '5', '6', '7', '8', '10', '12'].some(wanted)
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
}
if (wanted('9')) {
  windowName = 'desktop'
  scenario = '9 mouse and pen'
  await mouseAndPen().catch((e: Error) => ok(false, 'the scenario itself broke', e.message))
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
await browser.close()
console.log(fails ? `\n${fails} FAILED. Red scenarios: ${[...red].sort((a, b) => Number(a) - Number(b)).join(', ')}` : '\nALL PASS')
process.exit(fails ? 1 : 0)
