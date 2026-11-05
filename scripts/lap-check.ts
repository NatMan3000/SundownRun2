// ============================================================
//  LAP CHECK - the race's lap toasts, in a real race
// ------------------------------------------------------------
//  Starts a 3 lap race against nobody in a production preview with the demo
//  autopilot driving, and records every toast and the HUD's lap
//  counter. Passes when the toasts are exactly "Lap 2 of 3" then "Final lap"
//  (never "Final lap" as lap 2 starts) and nothing lap-shaped follows the finish.
//
//    bunx vite build --outDir /tmp/sr2/phone/dist-fixes --emptyOutDir
//    bunx vite preview --outDir /tmp/sr2/phone/dist-fixes --port 5216 --strictPort
//    bun run lap:check 5216
// ============================================================

import puppeteer from 'puppeteer-core'
import { findChrome } from './chrome'

const port = process.argv[2] ?? '5216'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
let fails = 0
const ok = (c: boolean, s: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${s}`)
  if (!c) fails++
}
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.evaluateOnNewDocument(() => {
  const w = window as any
  w.__toasts = []
  w.__lapText = []
  new MutationObserver(() => {
    for (const e of document.querySelectorAll('.hud-toast__text')) {
      const t = e.textContent ?? ''
      if (!w.__seen) w.__seen = new Set()
      const el = e as any
      if (!el.__logged) { el.__logged = true; w.__toasts.push(t) }
    }
    const l = document.querySelector('[data-hud="raceLap"]')?.textContent ?? ''
    if (l && w.__lapText[w.__lapText.length - 1] !== l) w.__lapText.push(l)
  }).observe(document, { subtree: true, childList: true, characterData: true })
})
await page.goto(`http://localhost:${port}/?track=afterglow&demo=1&nomusic=1&quality=low`, { waitUntil: 'load' })
await sleep(6000)
await page.evaluate(() => { const w = window as any; if (w.__game.get('ui').stack.length) w.__dev.ui('hud') })
await sleep(1500)
await page.evaluate(() => (window as any).__dev.race(0))
let length = 0
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const p = await page.evaluate(() => (window as any).__game.get('play'))
  if (p?.flow?.stage === 'running' && p.race) { length = p.race.length; var laps = p.race.laps; break }
}
ok(length > 0, `race is running (track length ${length} m)`)
const lapsTotal = await page.evaluate(() => (window as any).__game.get('play').race.laps)
ok(lapsTotal === 3, `3 lap race (got ${lapsTotal})`)
// The demo autopilot (?demo=1) drives the player round the real track; poll each lap as it lands.
// (__dev.teleport can't stand in: a teleport restarts the lap tracker.)
const stages: string[] = []
let lastDone = 0
const t0 = Date.now()
while (Date.now() - t0 < 9 * 60_000) {
  await sleep(200)
  const r = await page.evaluate(() => { const p = (window as any).__game.get('play'); return { done: p.race?.racers.find((x: any) => x.id === 'player')?.lapsDone ?? 0, stage: p.flow.stage as string, toasts: (window as any).__toasts as string[] } })
  if (r.done !== lastDone) { lastDone = r.done; stages.push(`after lap ${r.done}: toasts ${JSON.stringify(r.toasts.filter((t) => /Lap \d+ of|Final lap/.test(t)))}`) }
  if (r.stage === 'finished') break
}
await sleep(1500)
const res = await page.evaluate(() => ({ toasts: (window as any).__toasts as string[], lap: (window as any).__lapText as string[], state: (window as any).__game.get('play').flow.stage }))
for (const l of stages) console.log(l)
const lapToasts = res.toasts.filter((t) => /Lap \d+ of|Final lap/.test(t))
console.log('lap toasts', JSON.stringify(lapToasts), 'hud lap text', JSON.stringify(res.lap), 'stage', res.state)
ok(res.state === 'finished', `race finished (stage ${res.state})`)
ok(JSON.stringify(lapToasts) === JSON.stringify(['Lap 2 of 3', 'Final lap']), 'toasts are exactly "Lap 2 of 3" then "Final lap", none after lap 3')
ok(stages[0]?.includes('["Lap 2 of 3"]') ?? false, 'after lap 1 the toast says "Lap 2 of 3"')
ok(stages[1]?.endsWith('["Lap 2 of 3","Final lap"]') ?? false, 'after lap 2 the toast says "Final lap"')
ok(stages[2]?.endsWith('["Lap 2 of 3","Final lap"]') ?? false, 'after lap 3 no new lap toast')
ok(['Lap 1 of 3', 'Lap 2 of 3', 'Lap 3 of 3'].every((t) => res.lap.includes(t)), 'HUD lap counter read Lap 1, 2 and 3 of 3')
await page.screenshot({ path: '/tmp/sr2/phone/shots/fixes/lap-finish.png' })
await browser.close()
process.exit(fails ? 1 : 0)
