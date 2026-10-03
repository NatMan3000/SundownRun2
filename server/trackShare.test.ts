// ============================================================
//  TRACK SHARING TESTS - bun test server/trackShare.test.ts
// ------------------------------------------------------------
//  The real post office (server/issues.ts + server/trackShare.ts)
//  mounted on a plain HTTP server, posting to the fake GitHub
//  (server/fakeGithub.ts). Never the real GitHub: the API address is
//  the fake's, the waiting pile is in a temporary folder, and the
//  "key" is made-up letters only the fake knows.
// ============================================================

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReportHandler } from './issues'
import { startFakeGithub, type FakeGithub } from './fakeGithub'
import { buildTrackIssue, fingerprint, publicTrackFile, readTrackIssue, verifySharedTrack, type SharedListResult, type ShareResult } from '../src/editor/share/protocol'
import { validateTrack } from '../src/track/validate'
import type { TrackFile } from '../src/track/schema'

const PUSH_KEY = 'fakekey_owner_0123456789abcdef'
const NOPUSH_KEY = 'fakekey_helper_0123456789abcdef'
const afterglow = JSON.parse(readFileSync(join(import.meta.dir, '../tracks/afterglow.json'), 'utf8')) as TrackFile

let fake: FakeGithub
let server: Server
let base = ''
let pending = ''
let root = ''
const env: Record<string, string | undefined> = {}
const logs: string[] = []

/** A fresh fake GitHub, waiting pile and server for every test. */
beforeEach(async () => {
  fake?.stop()
  server?.close()
  fake = startFakeGithub({ keys: { [PUSH_KEY]: { push: true, login: 'owner' }, [NOPUSH_KEY]: { push: false, login: 'helper' } } })
  root = mkdtempSync(join(tmpdir(), 'sr2-share-root-'))
  pending = mkdtempSync(join(tmpdir(), 'sr2-share-pending-'))
  for (const k of Object.keys(env)) delete env[k]
  Object.assign(env, { SR2_ISSUES_API: fake.url, SR2_REPORTS_DIR: pending, SR2_GITHUB_TOKEN: PUSH_KEY })
  logs.length = 0
  const handler = createReportHandler({ root, env, log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) })
  server = createServer((req, res) => handler(req, res, () => {
    res.statusCode = 404
    res.end()
  }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  fake?.stop()
  server?.close()
  rmSync(pending, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

beforeAll(() => {
  // Belt and braces: these tests must never see a real key or the real GitHub.
  expect(process.env.SR2_GITHUB_TOKEN ?? '').toBe('')
})

async function share(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ code: number; r: ShareResult }> {
  const res = await fetch(`${base}/api/tracks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { code: res.status, r: (await res.json()) as ShareResult }
}

function shareOf(track: TrackFile, extra: Record<string, unknown> = {}) {
  return { track, madeBy: 'JJ', world: 'Hills at sundown', shareKey: 'k3x9abcd12345678', issue: null, ...extra }
}

async function list(fresh = true): Promise<SharedListResult> {
  const res = await fetch(`${base}/api/tracks${fresh ? '?fresh=1' : ''}`)
  return (await res.json()) as SharedListResult
}

/** Ask the Report screen's GET, which sends whatever is waiting (in the background), then wait for it. */
async function nudgeWaiting(): Promise<void> {
  await fetch(`${base}/api/report`)
  for (let i = 0; i < 40 && readdirSync(pending).filter((f) => f.endsWith('.json')).length; i++) await Bun.sleep(25)
}

describe('sharing a track', () => {
  test('posts a readable issue with the track file, labelled track', async () => {
    const { code, r } = await share(shareOf(afterglow))
    expect(code).toBe(200)
    expect(r).toMatchObject({ status: 'sent', number: 1, updated: false, labelMissing: false })
    expect(fake.issues).toHaveLength(1)
    const issue = fake.issues[0]
    expect(issue.title).toBe('Track: Afterglow Valley by JJ')
    expect(issue.labels.map((l) => l.name).sort()).toEqual(['from the game', 'track'])
    expect(issue.body).toContain('**Made by:** JJ')
    expect(issue.body).toContain('**World:** Hills at sundown')
    expect(issue.body).toMatch(/\*\*Length:\*\* \d+\.\d km/)
    // The track file reads back whole, with Made by in it, and its fingerprint matches.
    const read = readTrackIssue(issue.body)
    expect(read.problem).toBeNull()
    const ok = verifySharedTrack(read)
    expect(ok.ok).toBe(true)
    const back = JSON.parse(read.trackText as string) as TrackFile
    expect(back.author).toBe('JJ')
    expect(back.road.points).toEqual(afterglow.road.points)
    expect(validateTrack(back).ok).toBe(true)
    // The label was made once, before the first share.
    expect(fake.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/labels'))).toHaveLength(1)
  })

  test('sharing again edits the same issue, never a copy', async () => {
    const first = await share(shareOf(afterglow))
    expect(first.r.status).toBe('sent')
    const renamed = { ...afterglow, name: 'Afterglow Remix' }
    const again = await share(shareOf(renamed, { issue: 1 }))
    expect(again.r).toMatchObject({ status: 'sent', number: 1, updated: true })
    // The browser forgot the number: the share key still finds it.
    const forgot = await share(shareOf({ ...afterglow, name: 'Afterglow Three' }))
    expect(forgot.r).toMatchObject({ status: 'sent', number: 1, updated: true })
    expect(fake.issues).toHaveLength(1)
    expect(fake.issues[0].title).toBe('Track: Afterglow Three by JJ')
    // Edits keep the labels (an edit without labels leaves them alone).
    expect(fake.issues[0].labels.map((l) => l.name)).toContain('track')
  })

  test("never edits an issue that isn't this track's share", async () => {
    const report = fake.addIssue({ title: 'camera angle', body: 'the camera is too low', labels: ['bug', 'from the game'], login: 'owner' })
    const other = await share(shareOf(afterglow, { shareKey: 'otherkey12345678' }))
    expect(other.r.status).toBe('sent')
    // A browser pointing at the bug report, and at someone else's track: both make a new issue instead.
    const a = await share(shareOf(afterglow, { issue: report.number }))
    expect(a.r).toMatchObject({ status: 'sent', updated: false })
    const b = await share(shareOf(afterglow, { issue: 2, shareKey: 'thirdkey12345678' }))
    expect(b.r).toMatchObject({ status: 'sent', updated: false })
    expect(fake.issues.find((i) => i.number === report.number)?.body).toBe('the camera is too low')
    expect(readTrackIssue(fake.issues[1].body).shareKey).toBe('otherkey12345678')
  })

  test("a stranger's unlabelled copy of the issue (share key and all) is never the one edited", async () => {
    await share(shareOf(afterglow))
    const copy = fake.addIssue({ title: 'Track: Afterglow Valley by JJ', body: fake.issues[0].body, labels: [], login: 'stranger' })
    const again = await share(shareOf({ ...afterglow, name: 'Afterglow Two' }, { issue: copy.number }))
    expect(again.r).toMatchObject({ status: 'sent', updated: true, number: 1 })
    expect(fake.issues.find((i) => i.number === copy.number)?.title).toBe('Track: Afterglow Valley by JJ')
  })

  test('a closed (taken down) share is not put back up', async () => {
    await share(shareOf(afterglow))
    fake.issues[0].state = 'closed'
    const again = await share(shareOf(afterglow, { issue: 1 }))
    expect(again.code).toBe(409)
    expect(again.r).toMatchObject({ status: 'rejected', reason: 'taken-down' })
    expect(fake.issues).toHaveLength(1)
    expect(fake.issues[0].state).toBe('closed')
  })

  test('a key without push access: GitHub drops the label, and the answer says so', async () => {
    env.SR2_GITHUB_TOKEN = NOPUSH_KEY
    const { r } = await share(shareOf(afterglow))
    expect(r).toMatchObject({ status: 'sent', labelMissing: true })
    expect(fake.issues[0].labels).toEqual([])
    const l = await list()
    expect(l.status === 'ok' && l.items).toEqual([])
  })

  test('no key: the share waits on this computer, and goes up (labelled) once the key is there', async () => {
    delete env.SR2_GITHUB_TOKEN
    const { r } = await share(shareOf(afterglow))
    expect(r).toMatchObject({ status: 'saved', reason: 'no-token', waiting: 1 })
    expect(fake.issues).toHaveLength(0)
    // Sharing it again while it waits replaces the waiting copy, so it can't go up twice.
    const again = await share(shareOf({ ...afterglow, name: 'Afterglow Two' }))
    expect(again.r).toMatchObject({ status: 'saved', waiting: 1 })
    const files = readdirSync(pending).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(pending, files[0]), 'utf8')).share.shareKey).toBe('k3x9abcd12345678')
    // The list still works without a key (a plain public read, no Authorization).
    fake.addIssue({ title: 'Track: Canyon by Sam', body: (buildTrackIssue(publicTrackFile(afterglow, 'Sam'), 'Neon Valley', 'samkey1234567890') as { body: string }).body, labels: ['track'], login: 'owner' })
    const l = await list()
    expect(l).toMatchObject({ status: 'ok', ready: false, waiting: 1 })
    expect(fake.requests.at(-1)?.key).toBe('none')
    // The key arrives; the Report screen opening sends the waiting share.
    env.SR2_GITHUB_TOKEN = PUSH_KEY
    await nudgeWaiting()
    const made = fake.issues.find((i) => i.title === 'Track: Afterglow Two by JJ')
    expect(made?.labels.map((x) => x.name)).toContain('track')
    expect(readdirSync(pending).filter((f) => f.endsWith('.json'))).toHaveLength(0)
    // The browser never learned the number; sharing again still edits that one.
    const third = await share(shareOf({ ...afterglow, name: 'Afterglow Three' }))
    expect(third.r).toMatchObject({ status: 'sent', updated: true, number: made?.number })
    expect(fake.issues).toHaveLength(2)
  })

  test('offline: the share waits, and the list says so in plain words', async () => {
    fake.stop()
    const { r } = await share(shareOf(afterglow))
    expect(r).toMatchObject({ status: 'saved', reason: 'offline' })
    const l = await list()
    expect(l).toMatchObject({ status: 'unavailable', reason: 'offline' })
    expect(l.status === 'unavailable' && l.message).toBe("Can't reach GitHub right now, so the shared tracks can't be shown. Is the internet on? Your own tracks still work.")
  })

  test('GitHub busy (500) or a refused key keeps the share waiting', async () => {
    fake.failNext(502, 'Bad gateway', 2)
    expect((await share(shareOf(afterglow))).r).toMatchObject({ status: 'saved', reason: 'offline' })
    env.SR2_GITHUB_TOKEN = 'fakekey_unknown_0123456789abcdef'
    expect((await share(shareOf(afterglow))).r).toMatchObject({ status: 'saved', reason: 'refused' })
    expect(readdirSync(pending).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })

  test('too big for GitHub: refused in plain words, nothing sent', async () => {
    const points = Array.from({ length: 2600 }, (_, i) => ({ x: Math.cos(i / 400) * 500 + i * 0.001, z: Math.sin(i / 400) * 500, lift: 0.123456789 }))
    const { code, r } = await share(shareOf({ ...afterglow, road: { ...afterglow.road, points } }))
    expect(code).toBe(413)
    expect(r).toMatchObject({ status: 'rejected', reason: 'too-big' })
    expect(r.status === 'rejected' && r.message).toContain('too big to share')
    expect(fake.issues).toHaveLength(0)
  })

  test('only the game itself may share', async () => {
    const { code } = await share(shareOf(afterglow), { Origin: 'https://evil.example' })
    expect(code).toBe(403)
    expect(fake.issues).toHaveLength(0)
  })

  test("a name can't sneak links, pictures or @mentions into the issue", async () => {
    await share(shareOf({ ...afterglow, name: '![x](http://evil/x.png) @octocat' }, { madeBy: '[click](http://evil)' }))
    const body = fake.issues[0].body
    const top = body.slice(0, body.indexOf('<!--'))
    expect(top).not.toContain('![x](')
    expect(top).not.toContain('[click](')
    expect(top).not.toMatch(/@octocat/)
    expect(fake.issues[0].title).not.toMatch(/@octocat/)
  })
})

describe('the Shared tracks list', () => {
  test('lists only labelled issues (never an unlabelled one or a pull request), newest first', async () => {
    const good = buildTrackIssue(publicTrackFile(afterglow, 'Sam'), 'Neon Valley', 'samkey1234567890') as { title: string; body: string }
    fake.addIssue({ title: 'Track: first', body: good.body, labels: ['track'], login: 'owner' })
    fake.addIssue({ title: 'Track: stranger (no label)', body: good.body, labels: [], login: 'stranger' })
    fake.addIssue({ title: 'Track: a pull request', body: good.body, labels: ['track'], pull: true, login: 'owner' })
    fake.addIssue({ title: 'Track: second', body: good.body, labels: ['track', 'from the game'], login: 'owner' })
    const l = await list()
    expect(l.status).toBe('ok')
    if (l.status !== 'ok') return
    expect(l.items.map((i) => i.title)).toEqual(['Track: second', 'Track: first'])
    expect(l.items.every((i) => verifySharedTrack(i).ok)).toBe(true)
  })

  test('a tampered or cut-off track is listed but refused, with the reason', async () => {
    const good = (buildTrackIssue(publicTrackFile(afterglow, 'Sam'), 'Neon Valley', 'samkey1234567890') as { body: string }).body
    // Someone edits one number on the website (GitHub turns new lines into \r\n when it is edited there).
    const tampered = good.replace('"x": -455', '"x": -456').replace(/\n/g, '\r\n')
    const reflowed = good.replace(/\n/g, '\r\n') // only the line endings changed: still fine
    const cut = good.slice(0, Math.floor(good.length * 0.6))
    const noFile = 'Just some words about a track.'
    for (const [title, body] of [['tampered', tampered], ['reflowed', reflowed], ['cut', cut], ['nofile', noFile]] as const) {
      fake.addIssue({ title, body, labels: ['track'], login: 'owner' })
    }
    expect(tampered).not.toBe(good)
    const l = await list()
    if (l.status !== 'ok') throw new Error('list failed')
    const verdict = Object.fromEntries(l.items.map((i) => [i.title, verifySharedTrack(i)]))
    expect(verdict.reflowed.ok).toBe(true)
    expect(verdict.tampered).toMatchObject({ ok: false })
    expect(!verdict.tampered.ok && verdict.tampered.why).toContain('changed on GitHub after it was shared')
    expect(!verdict.cut.ok && verdict.cut.why).toContain('cut off')
    expect(!verdict.nofile.ok && verdict.nofile.why).toContain("there's no track file in it")
  })

  test('remembers the list for a minute, and Refresh asks again', async () => {
    await list(false)
    const before = fake.requests.length
    await list(false)
    expect(fake.requests.length).toBe(before)
    // fresh=1 inside 10 s of the last ask still uses the memory (GitHub allows 60 asks an hour without a key).
    await list(true)
    expect(fake.requests.length).toBe(before)
  })

  test('GitHub having trouble (a 502) gets its own plain words, not "too many times"', async () => {
    fake.failNext(502, 'Bad gateway', 1)
    const l = await list()
    expect(l).toMatchObject({ status: 'unavailable', reason: 'offline' })
    expect(l.status === 'unavailable' && l.message).toBe("GitHub is having trouble right now, so the shared tracks can't be shown. Try again in a while. Your own tracks still work.")
  })

  test("GitHub's rate limit (no key) gets plain words", async () => {
    delete env.SR2_GITHUB_TOKEN
    fake.limit.remaining = 0
    const l = await list()
    expect(l).toMatchObject({ status: 'unavailable', reason: 'busy' })
    expect(l.status === 'unavailable' && l.message).toContain('too many times')
  })

  test('a key GitHub turns down still lets the list be read in public', async () => {
    env.SR2_GITHUB_TOKEN = 'fakekey_unknown_0123456789abcdef'
    fake.addIssue({ title: 'Track: one', body: 'x', labels: ['track'], login: 'owner' })
    const l = await list()
    expect(l.status).toBe('ok')
    expect(fake.requests.at(-1)?.key).toBe('none')
  })
})

describe('Report a problem still works beside it', () => {
  test('a report posts with its labels and the same waiting pile', async () => {
    const res = await fetch(`${base}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bug', title: 'camera', text: 'too low', name: 'JJ', details: { lines: [], events: [], errors: [] } }),
    })
    expect(((await res.json()) as { status: string }).status).toBe('sent')
    expect(fake.issues[0].labels.map((l) => l.name).sort()).toEqual(['bug', 'from the game'])
  })
})

describe('the fingerprint', () => {
  test('changes with any value and ignores spacing', () => {
    const a = JSON.stringify(afterglow)
    expect(fingerprint(a)).toBe(fingerprint(JSON.stringify(JSON.parse(JSON.stringify(afterglow, null, 2)))))
    expect(fingerprint(a)).not.toBe(fingerprint(a.replace('"Afterglow Valley"', '"Afterglow Valleys"')))
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{28}$/)
  })
})
