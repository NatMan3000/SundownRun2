// ============================================================
//  PROBE - drive the game in a private headless Chrome
// ------------------------------------------------------------
//  Dev tool for workers and checkers: opens a URL in its OWN
//  headless Chrome (GPU-accelerated on macOS), runs a scripted
//  sequence, and prints what happened. It never touches anyone's
//  open browser tabs.
//
//    bun run probe -- --url "http://localhost:5210/?track=afterglow" \
//      --wait 6 --shot /tmp/a.png
//
//  Options (all optional except --url):
//    --url <u>           page to open
//    --width/--height    viewport (default 1920x1080)
//    --wait <s>          seconds to wait after load (default 5)
//    --steps "<seq>"     semicolon-separated steps, run in order:
//                          wait:<ms>            sleep
//                          hold:<Key>:<ms>      hold a key (e.g. hold:KeyW:3000)
//                          down:<Key> / up:<Key>
//                          tap:<Key>            press and release
//                          eval:<js expr>       evaluate, print JSON result
//                          shot:<path.png>      screenshot
//                        Keys use KeyboardEvent.code names: KeyW, Space,
//                        ArrowUp, ShiftLeft, Escape, Enter, KeyR, KeyC ...
//    --shot <path>       screenshot at the end
//    --eval "<expr>"     evaluate at the end, print JSON (repeatable)
//    --perf              wait for window.__perf.done (up to --perf-timeout s,
//                        default 60) and print the report
//    --gpuinfo           print the WebGL renderer string (check it's the GPU)
//    --headed            show the window (default headless)
//    --angle <backend>   the GPU backend Chrome draws with (default metal).
//                        swiftshader = Google's CPU renderer, whose maths
//                        (pow, NaN) behaves like a Windows Direct3D GPU's
//                        more than the Mac's does; slow, but a few frames do
//    --chrome <path>     Chrome binary (default: $CHROME_PATH, puppeteer's
//                        cache, then Chrome Canary / Chrome in /Applications)
//
//  Output: console errors/warnings from the page, eval results, and
//  the perf report, as plain lines. Exit code 1 if the page threw.
// ============================================================

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import type { KeyInput } from 'puppeteer-core'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function args(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1])
  return out
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function findChrome(): string {
  const explicit = arg('chrome') ?? process.env.CHROME_PATH
  if (explicit && existsSync(explicit)) return explicit
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome')
  if (existsSync(cache)) {
    const versions = readdirSync(cache).sort().reverse()
    for (const v of versions) {
      const mac = join(cache, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(mac)) return mac
      const linux = join(cache, v, 'chrome-linux64', 'chrome')
      if (existsSync(linux)) return linux
      const win = join(cache, v, 'chrome-win64', 'chrome.exe')
      if (existsSync(win)) return win
    }
  }
  const apps = [
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
  ]
  for (const a of apps) if (existsSync(a)) return a
  throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.')
}

const url = arg('url')
if (!url) {
  console.error('usage: bun run probe -- --url <url> [--wait s] [--steps "..."] [--shot path] [--eval expr] [--perf]')
  process.exit(2)
}
const width = Number(arg('width') ?? 1920)
const height = Number(arg('height') ?? 1080)
const waitS = Number(arg('wait') ?? 5)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: !flag('headed'),
  defaultViewport: { width, height, deviceScaleFactor: 1 },
  args: [
    `--window-size=${width},${height}`,
    `--use-angle=${arg('angle') ?? 'metal'}`,
    ...(arg('angle') === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
    '--no-default-browser-check',
  ],
})

let pageThrew = false
try {
  const page = await browser.newPage()
  page.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warn' || t === 'info') console.log(`[page ${t}] ${m.text()}`)
  })
  page.on('pageerror', (e) => {
    pageThrew = true
    console.log(`[page threw] ${(e as Error).message}`)
  })
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  await sleep(waitS * 1000)

  if (flag('gpuinfo')) {
    const info = await page.evaluate(() => {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2')
      if (!gl) return 'no webgl2'
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
    })
    console.log(`[gpu] ${info}`)
  }

  const steps = (arg('steps') ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  for (const step of steps) {
    const [kind, ...rest] = step.split(':')
    const a = rest.join(':')
    if (kind === 'wait') await sleep(Number(a))
    else if (kind === 'hold') {
      const [key, ms] = a.split(':')
      await page.keyboard.down(key as KeyInput)
      await sleep(Number(ms))
      await page.keyboard.up(key as KeyInput)
    } else if (kind === 'down') await page.keyboard.down(a as KeyInput)
    else if (kind === 'up') await page.keyboard.up(a as KeyInput)
    else if (kind === 'tap') await page.keyboard.press(a as KeyInput)
    else if (kind === 'eval') console.log(`[eval] ${a} => ${JSON.stringify(await page.evaluate(a))}`)
    else if (kind === 'shot') {
      await page.screenshot({ path: a as `${string}.png` })
      console.log(`[shot] ${a}`)
    } else console.log(`[probe] unknown step "${step}"`)
  }

  if (flag('perf')) {
    const timeout = Number(arg('perf-timeout') ?? 60) * 1000
    const t0 = Date.now()
    let report: unknown = null
    while (Date.now() - t0 < timeout) {
      report = await page.evaluate(() => (window as unknown as { __perf?: { done?: boolean } }).__perf ?? null)
      if (report && (report as { done?: boolean }).done) break
      await sleep(500)
    }
    console.log(`[perf] ${JSON.stringify(report)}`)
  }

  for (const expr of args('eval')) console.log(`[eval] ${expr} => ${JSON.stringify(await page.evaluate(expr))}`)

  const shot = arg('shot')
  if (shot) {
    await page.screenshot({ path: shot as `${string}.png` })
    console.log(`[shot] ${shot}`)
  }
} finally {
  await browser.close()
}
process.exit(pageThrew ? 1 : 0)
