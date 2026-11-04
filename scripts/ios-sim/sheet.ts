import puppeteer from 'puppeteer-core'
import { findChrome } from '../chrome'
import { readFileSync } from 'node:fs'
// Lays sweep shots out as 874x292 cells (the Safari page area of a 874x402 screen) on one sheet.
// usage: bun scripts/ios-sim/sheet.ts <out.png> <name>...   (names are $IOS_SIM_OUT/sweep/<name>.png)
const SWEEP = `${process.env.IOS_SIM_OUT ?? '/tmp/sr2/ios-sim'}/sweep`
const [out, ...names] = process.argv.slice(2)
const b = await puppeteer.launch({ executablePath: findChrome(), headless: true })
const p = await b.newPage()
await p.setViewport({ width: 1760, height: Math.ceil(names.length / 2) * 300 })
const cell = (n: string) => `<div style="width:874px;height:292px;overflow:hidden;position:relative;margin:2px;float:left"><img src="data:image/png;base64,${readFileSync(`${SWEEP}/${n}.png`).toString('base64')}" style="position:absolute;left:0;top:-110px;width:874px"><b style="position:absolute;left:400px;bottom:2px;color:#ff0;background:#000;font:12px sans-serif;padding:0 3px">${n}</b></div>`
await p.setContent(`<body style="margin:0;background:#333">${names.map(cell).join('')}</body>`, { waitUntil: 'load' })
await new Promise((r) => setTimeout(r, 500))
await p.screenshot({ path: out as `${string}.png` })
await b.close()
