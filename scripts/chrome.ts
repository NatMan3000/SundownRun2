// Which Chrome the dev tools drive: an explicit path, $CHROME_PATH, puppeteer's cache, then an installed one.

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function findChrome(explicitPath?: string): string {
  const explicit = explicitPath ?? process.env.CHROME_PATH
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
