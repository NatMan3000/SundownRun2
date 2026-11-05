// ============================================================
//  EDITOR BACKENDS - the two things the Library talks to, in-process
// ------------------------------------------------------------
//  Shared by scripts/phone-gate.ts and scripts/editor-touch-check.ts, so the
//  Library, Share and Shared tracks (home) and Everyone's tracks (online) can
//  be opened with real rows in them without a server, GitHub or Cloudflare:
//
//    home    the REAL post office (server/issues.ts + server/trackShare.ts)
//            posting to the fake GitHub (server/fakeGithub.ts). Never the real
//            repository: the API address is the fake's and the key is made up.
//    online  the REAL library rules (cloud/libraryStore.ts) on bun:sqlite,
//            served to a page that believes it is on https (libraryOn() asks
//            for https), by answering that page's requests from the script.
//
//  `serve(page, ...)` turns on request interception for one page.
// ============================================================

import { Database } from 'bun:sqlite'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import { createReportHandler } from '../server/issues'
import { startFakeGithub, type FakeGithub } from '../server/fakeGithub'
import { LibraryStore } from '../cloud/libraryStore'
import type { TrackFile } from '../src/track/schema'

const KEY = 'fakekey_owner_0123456789abcdef'
const ROOT = join(import.meta.dir, '..')

/** The address the online page believes it is on (never resolved: every request is answered by the script). */
export const ONLINE_ORIGIN = 'https://sr2-gate.test'

export interface Backends {
  /** Turn on interception for a page. `online`: the page is loaded from ONLINE_ORIGIN and the library answers. */
  serve: (page: Page, port: string) => Promise<void>
  /** Put a track in the online library as another player (so Everyone's tracks has rows). */
  otherPlayer: (name: string, file: TrackFile) => void
  stop: () => void
}

export function startBackends(): Promise<Backends> {
  const fake: FakeGithub = startFakeGithub({ keys: { [KEY]: { push: true, login: 'owner' } } })
  const pending = mkdtempSync(join(tmpdir(), 'sr2-rooms-pending-'))
  const env = { SR2_ISSUES_API: fake.url, SR2_REPORTS_DIR: pending, SR2_GITHUB_TOKEN: KEY }
  const handler = createReportHandler({ root: ROOT, env, log: () => {}, warn: () => {} })
  const post: Server = createServer((req, res) =>
    handler(req, res, () => {
      res.statusCode = 404
      res.end()
    }),
  )

  const db = new Database(':memory:')
  let n = 0
  const store = new LibraryStore({
    sql: {
      exec: (q, ...b) => {
        const rows = db.prepare(q).all(...(b as never[])) as never[]
        return { toArray: () => rows }
      },
    },
    transaction: (fn) => db.transaction(fn)(),
    now: () => Date.now() - 86_400_000 + n * 60_000,
    randomSuffix: () => `r${n++}`,
  })
  const ME = 'me@example.com'

  /** The Worker's routes (cloud/libraryApi.ts) minus the Access login, on the real store. */
  const library = (method: string, path: string, body: Record<string, unknown> | null): unknown => {
    if (path === '/api/library') return { status: 'ok', ...store.list(ME) }
    if (path === '/api/library/tracks' && method === 'POST') return store.create(ME, String(body?.playerName ?? ''), body?.file as TrackFile)
    const one = /^\/api\/library\/tracks\/([^/]+)$/.exec(path)
    if (!one) return { status: 'refused', code: 'not-found', message: 'There is nothing at that address.' }
    const id = decodeURIComponent(one[1])
    if (method === 'GET') return store.get(ME, id)
    if (method === 'DELETE') return store.remove(ME, id)
    if (method === 'PUT') return store.update(ME, String(body?.playerName ?? ''), id, body?.file as TrackFile, Number(body?.baseRev))
    return { status: 'refused', code: 'invalid', message: 'GET, PUT or DELETE only.' }
  }

  return new Promise((resolve) => {
    post.listen(0, '127.0.0.1', () => {
      const addr = post.address()
      const postBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve({
        async serve(page, port) {
          await page.setRequestInterception(true)
          page.on('request', (req) => {
            void (async () => {
              try {
                const url = new URL(req.url())
                const online = url.origin === ONLINE_ORIGIN
                const local = url.origin === `http://localhost:${port}`
                if (!online && !local) return void req.continue()
                const text = req.postData()
                const json = (body: unknown, status = 200) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
                // Home: Share and Shared tracks (and Report a problem) go to the real post office, which posts to the fake GitHub.
                if (!online && (url.pathname === '/api/tracks' || url.pathname === '/api/report')) {
                  const r = await fetch(postBase + url.pathname + url.search, { method: req.method(), headers: text ? { 'Content-Type': 'application/json' } : undefined, body: text ?? undefined })
                  return void req.respond({ status: r.status, contentType: 'application/json', body: await r.text() })
                }
                if (online && url.pathname.startsWith('/api/library')) return void json(library(req.method(), url.pathname.replace(/\/+$/, ''), text ? JSON.parse(text) : null))
                if (online) {
                  // Everything else is the game itself, from the preview.
                  const r = await fetch(`http://localhost:${port}${url.pathname}${url.search}`)
                  return void req.respond({ status: r.status, contentType: r.headers.get('content-type') ?? undefined, body: Buffer.from(await r.arrayBuffer()) })
                }
                return void req.continue()
              } catch (e) {
                console.error('backend request failed', req.url(), e)
                if (!req.isInterceptResolutionHandled()) void req.abort()
              }
            })()
          })
        },
        otherPlayer(name, file) {
          const slug = name.toLowerCase()
          store.create(`${slug}@example.com`, name, file)
        },
        stop() {
          fake.stop()
          post.close()
          rmSync(pending, { recursive: true, force: true })
        },
      })
    })
  })
}

/** A built-in track's file, renamed: the rows other players' tracks are made of. */
export function sampleTrack(id: string, name: string, from = 'afterglow'): TrackFile {
  const file = JSON.parse(readFileSync(join(ROOT, 'tracks', `${from}.json`), 'utf8')) as TrackFile
  return { ...file, id, name }
}
