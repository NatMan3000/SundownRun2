// ============================================================
//  MAKE ICONS - the phone's Home Screen icons, from one drawing
// ------------------------------------------------------------
//  Draws public/icons/icon.svg in a private headless Chrome and
//  saves the PNGs next to it. Run it after changing the drawing,
//  and bump ?v= in public/manifest.webmanifest. A phone only picks
//  up a new icon when the game is deleted and added again.
//
//    bun run icons
// ============================================================

import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { findChrome } from './chrome'

const SIZES: [string, number][] = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]

const dir = new URL('../public/icons/', import.meta.url)
const svg = readFileSync(new URL('icon.svg', dir), 'utf8')
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true })
try {
  for (const [name, size] of SIZES) {
    const page = await browser.newPage()
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
    await page.setContent(`<!doctype html><html><body style="margin:0"><div style="width:${size}px;height:${size}px">${svg}</div></body></html>`)
    await page.screenshot({ path: new URL(name, dir).pathname as `${string}.png`, omitBackground: false })
    await page.close()
    console.log(`${name} ${size}px`)
  }
} finally {
  await browser.close()
}
