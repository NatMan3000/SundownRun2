// ============================================================
//  REPORT A PROBLEM - the game's own little post office
// ------------------------------------------------------------
//  The "Report a problem" screen (src/ui/screens/Report.tsx) sends
//  its report here, to the game's own server on this computer, and
//  this file posts it on GitHub as an issue:
//
//    https://github.com/NatMan3000/SundownRun2/issues
//
//  Why go through the server instead of the browser? Posting needs a
//  GitHub key (a "token"), and a key must stay secret. It lives in a
//  file on this computer; this file reads it when a report comes in,
//  and it never goes to the browser, into the issue, or into a log.
//  (GitHub accounts start at 13, so the game posts for Josh with the
//  key Dad put on the computer.)
//
//  It is a Vite plugin, registered in vite.config.ts, so every way of
//  starting the game has it: `bun run dev`, the .bat launchers,
//  `bun run mp` and `vite preview`.
//
//    GET  /api/report   is reporting switched on? version, commit, waiting reports
//    POST /api/report   { kind, title, text, name, details } -> send it
//
//  The key: one line in github-token.txt in the game folder (gitignored,
//  so it is never uploaded and the Update .bat leaves it alone), or the
//  SR2_GITHUB_TOKEN environment variable. README "Turn on reporting".
//
//  No key, no internet, or GitHub says no: the report is saved in
//  reports/pending/ (gitignored too) and sent after the next report that
//  does get through. Every failure is printed in the server window with
//  its reason, so nothing goes missing quietly.
//
//  Testing (never post to the real GitHub from a test):
//    SR2_ISSUES_API=http://127.0.0.1:<port>   post to a fake GitHub instead
//    SR2_REPORTS_DIR=/tmp/somewhere           keep waiting reports there
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join, relative } from 'node:path'
import type { Plugin } from 'vite'
import { REPORT_ENDPOINT, REPORT_KINDS, REPORT_LIMITS, REPORT_REPO, scrubPrivate } from '../src/ui/report/protocol'
import type { ReportDetails, ReportInfo, ReportKind, ReportRequest, ReportResult, SavedReason } from '../src/ui/report/protocol'

// ---------------------------------------------------------------- settings

const GITHUB_API = 'https://api.github.com'
/** The GitHub REST API version this file was written against. */
const GITHUB_API_VERSION = '2026-03-10'
/** At most this many reports per this long, so a stuck button can't flood GitHub. */
const RATE_MAX = 3
const RATE_WINDOW_MS = 10 * 60 * 1000
/** Give up on GitHub after this long and save the report instead. */
const GITHUB_TIMEOUT_MS = 15_000
/** Reports kept waiting on this computer, at most. */
const PENDING_MAX = 50
/** Waiting reports sent along with one new report, at most. */
const FLUSH_MAX = 10
/** Where the key can live. Windows hides ".txt", so a doubled one is checked too. */
const TOKEN_FILES = ['github-token.txt', 'github-token.txt.txt']
/** Every report gets this label, plus one for its kind. */
const LABEL_GAME = 'from the game'
const KIND_LABEL: Record<ReportKind, string | null> = { bug: 'bug', idea: 'idea', other: null }

// ---------------------------------------------------------------- types

/** The issue as GitHub's "create an issue" call wants it. */
interface Issue {
  title: string
  body: string
  labels: string[]
}

/** One file in reports/pending/. */
interface PendingReport {
  savedAt: string
  reason: SavedReason
  issue: Issue
}

type PostResult = { ok: true; number: number; url: string } | { ok: false; reason: 'offline' | 'refused'; status: number; detail: string }

type Next = (err?: unknown) => void
export type ReportHandler = (req: IncomingMessage, res: ServerResponse, next: Next) => void

export interface ReportOptions {
  /** The game folder (where package.json and github-token.txt are). */
  root: string
  /** Environment to read SR2_* from (tests pass their own). */
  env?: Record<string, string | undefined>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

// ---------------------------------------------------------------- the plugin

/** Vite plugin: serves /api/report from the dev server and from `vite preview`. */
export function reportPlugin(): Plugin {
  return {
    name: 'sr2-report-a-problem',
    configureServer(server) {
      const logger = server.config.logger
      server.middlewares.use(
        createReportHandler({
          root: server.config.root,
          log: (m) => logger.info(`[report] ${m}`, { timestamp: true }),
          warn: (m) => logger.warn(`[report] ${m}`, { timestamp: true }),
        }),
      )
    },
    configurePreviewServer(server) {
      const logger = server.config.logger
      server.middlewares.use(
        createReportHandler({
          root: server.config.root,
          log: (m) => logger.info(`[report] ${m}`, { timestamp: true }),
          warn: (m) => logger.warn(`[report] ${m}`, { timestamp: true }),
        }),
      )
    },
  }
}

/** The request handler itself (connect-style), so a test can mount it on a plain http server. */
export function createReportHandler(opts: ReportOptions): ReportHandler {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((m: string) => console.log(`[report] ${m}`))
  const warn = opts.warn ?? ((m: string) => console.warn(`[report] ${m}`))
  const root = opts.root
  const api = apiBase(env.SR2_ISSUES_API, warn)
  const pendingDir = env.SR2_REPORTS_DIR ? env.SR2_REPORTS_DIR : join(root, 'reports', 'pending')
  if (api !== GITHUB_API) log(`test mode: reports go to ${api}, not to GitHub`)

  /** When each recent report arrived (for the rate limit). */
  const recent: number[] = []
  /** One flush at a time, so a waiting report is never sent twice. */
  let flushing = false
  let gitCache: { at: number; commit: string; changed: string[] } | null = null
  let gitMissingLogged = false

  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== REPORT_ENDPOINT) {
      next()
      return
    }
    handle(req, res).catch((err) => {
      warn(`a report request failed inside the server: ${errText(err)}`)
      if (!res.headersSent) reply(res, 500, { status: 'rejected', reason: 'invalid', message: 'The game server had a problem with that. Try again.' })
      else res.end()
    })
  }

  // ---------------------------------------------------------------- one request

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = callerProblem(req)
    if (refusal) {
      warn(`refused a request from outside the game (${refusal})`)
      reply(res, 403, { status: 'rejected', reason: 'invalid', message: 'Reports can only come from the game itself.' })
      return
    }

    if (req.method === 'GET') {
      const git = await gitInfo()
      const info: ReportInfo = {
        ready: (await readToken()) !== null,
        version: await readVersion(),
        commit: git.commit,
        changed: git.changed,
        waiting: (await listPending()).length,
      }
      reply(res, 200, info)
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      reply(res, 405, { status: 'rejected', reason: 'invalid', message: 'Use GET or POST.' })
      return
    }

    // A JSON content type also makes a browser ask first (CORS) before another website can post here.
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      warn(`refused a report that was not sent as JSON (${String(req.headers['content-type'] ?? 'no content type')})`)
      reply(res, 415, { status: 'rejected', reason: 'invalid', message: 'A report must be JSON.' })
      return
    }
    const raw = await readBody(req, REPORT_LIMITS.body)
    if (raw === null) {
      warn(`refused a report bigger than ${REPORT_LIMITS.body} bytes`)
      res.setHeader('Connection', 'close')
      reply(res, 413, { status: 'rejected', reason: 'invalid', message: 'That report is too big to send.' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      warn(`refused a report that was not readable JSON (${errText(err)})`)
      reply(res, 400, { status: 'rejected', reason: 'invalid', message: 'That report could not be read.' })
      return
    }
    const report = validate(parsed)
    if (typeof report === 'string') {
      warn(`refused a report: ${report}`)
      reply(res, 400, { status: 'rejected', reason: 'invalid', message: `That report could not be sent: ${report}.` })
      return
    }

    const now = Date.now()
    while (recent.length && now - recent[0] > RATE_WINDOW_MS) recent.shift()
    if (recent.length >= RATE_MAX) {
      const waitMin = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 60_000))
      warn(`refused a report: ${RATE_MAX} already sent in the last ${RATE_WINDOW_MS / 60_000} minutes`)
      reply(res, 429, {
        status: 'rejected',
        reason: 'too-many',
        message: `That's ${RATE_MAX} reports in ${RATE_WINDOW_MS / 60_000} minutes. Have a break and send this one in ${waitMin} ${waitMin === 1 ? 'minute' : 'minutes'}.`,
      })
      return
    }
    recent.push(now)

    const git = await gitInfo()
    const issue = buildIssue(report, await readVersion(), git.commit, git.changed)
    const token = await readToken()
    if (!token) {
      await saveAndReply(res, issue, 'no-token', 'reporting is not switched on here yet (no github-token.txt in the game folder)')
      return
    }
    const sent = await postIssue(issue, token)
    if (!sent.ok) {
      await saveAndReply(res, issue, sent.reason, sent.detail)
      return
    }
    log(`sent: issue #${sent.number} ${sent.url}`)
    const alsoSent = await flushPending(token)
    const result: ReportResult = { status: 'sent', number: sent.number, url: sent.url, alsoSent }
    reply(res, 200, result)
  }

  // ---------------------------------------------------------------- saving and retrying

  async function saveAndReply(res: ServerResponse, issue: Issue, reason: SavedReason, detail: string): Promise<void> {
    const before = (await listPending()).length
    if (before >= PENDING_MAX) {
      warn(`could not save a report: ${PENDING_MAX} are already waiting in ${shown(pendingDir)} (${detail})`)
      reply(res, 507, {
        status: 'rejected',
        reason: 'full',
        message: `There are already ${PENDING_MAX} reports waiting on this computer. Ask Dad to switch reporting on so they can send.`,
      })
      return
    }
    const file = await savePending({ savedAt: new Date().toISOString(), reason, issue })
    warn(`saved on this computer as ${file}: ${detail}. It sends after the next report that gets through.`)
    const result: ReportResult = { status: 'saved', reason, waiting: before + 1 }
    reply(res, 200, result)
  }

  async function savePending(data: PendingReport): Promise<string> {
    await mkdir(pendingDir, { recursive: true })
    const stamp = data.savedAt.replace(/[:.]/g, '-')
    const name = `${stamp}-${Math.random().toString(36).slice(2, 6)}.json`
    // Write then rename, so a half-written file is never picked up as a report.
    const tmp = join(pendingDir, `${name}.tmp`)
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, join(pendingDir, name))
    return shown(join(pendingDir, name))
  }

  async function listPending(): Promise<string[]> {
    try {
      return (await readdir(pendingDir)).filter((f) => f.endsWith('.json')).sort()
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return [] // no folder yet: nothing waiting
      throw err
    }
  }

  /** Send reports that were waiting, oldest first. Stops at the first one GitHub won't take. */
  async function flushPending(token: string): Promise<number> {
    if (flushing) return 0
    flushing = true
    let sent = 0
    try {
      const files = (await listPending()).slice(0, FLUSH_MAX)
      for (const f of files) {
        const full = join(pendingDir, f)
        let saved: PendingReport | null = null
        try {
          saved = JSON.parse(await readFile(full, 'utf8')) as PendingReport
        } catch (err) {
          warn(`a waiting report could not be read (${f}: ${errText(err)}); renamed it to ${f}.broken so it is skipped`)
        }
        if (!saved || !isIssue(saved.issue)) {
          if (saved) warn(`a waiting report has no issue in it (${f}); renamed it to ${f}.broken so it is skipped`)
          await rename(full, `${full}.broken`)
          continue
        }
        const r = await postIssue(saved.issue, token)
        if (!r.ok) {
          warn(`a waiting report did not send yet (${f}): ${r.detail}`)
          break
        }
        try {
          await unlink(full)
        } catch (err) {
          // It went to GitHub but is still on disk: it would be sent again next time. Say so loudly.
          warn(`sent ${f} as issue #${r.number}, but could not delete it (${errText(err)}). Delete it by hand or it will be sent twice.`)
        }
        sent++
        log(`sent a waiting report: issue #${r.number} ${r.url}`)
      }
    } finally {
      flushing = false
    }
    return sent
  }

  // ---------------------------------------------------------------- GitHub

  async function postIssue(issue: Issue, token: string): Promise<PostResult> {
    const first = await postOnce(issue, token)
    if (!first.ok && first.status === 422 && issue.labels.length > 0) {
      // GitHub validates labels; if it turns them down, the report matters more than its labels.
      warn(`GitHub turned the report down with its labels (${first.detail}); sending it without labels`)
      return postOnce({ ...issue, labels: [] }, token)
    }
    return first
  }

  async function postOnce(issue: Issue, token: string): Promise<PostResult> {
    let res: Response
    try {
      res = await fetch(`${api}/repos/${REPORT_REPO}/issues`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SundownRunII-report-a-problem',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        body: JSON.stringify(issue),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
    } catch (err) {
      return { ok: false, reason: 'offline', status: 0, detail: `could not reach GitHub (${errText(err)})` }
    }
    let data: Record<string, unknown> | null = null
    const text = await res.text()
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      // GitHub answers in JSON; when it doesn't (a proxy page), the status code below still says what happened.
      data = null
    }
    const said = typeof data?.message === 'string' ? `: ${String(data.message).slice(0, 200)}` : ''
    if (res.status === 201) {
      const number = data?.number
      const url = data?.html_url
      if (typeof number === 'number' && Number.isInteger(number) && typeof url === 'string') return { ok: true, number, url }
      // Created, but the answer was odd: still a success (saving it would post it twice).
      warn(`GitHub made the issue but did not say its number (answer started: ${text.slice(0, 120)})`)
      return { ok: true, number: 0, url: `https://github.com/${REPORT_REPO}/issues` }
    }
    const status = res.status
    if (status >= 500 || status === 429 || /rate limit/i.test(said)) {
      return { ok: false, reason: 'offline', status, detail: `GitHub is busy or having trouble (${status}${said})` }
    }
    if (status === 401) return { ok: false, reason: 'refused', status, detail: `GitHub turned the key down (401${said}): it may have run out or been copied wrong` }
    if (status === 403) return { ok: false, reason: 'refused', status, detail: `the key is not allowed to make issues (403${said}): it needs Issues: Read and write` }
    if (status === 404) return { ok: false, reason: 'refused', status, detail: `GitHub can't find ${REPORT_REPO} with this key (404${said}): the key needs that repository` }
    if (status === 410) return { ok: false, reason: 'refused', status, detail: `issues are switched off on ${REPORT_REPO} (410${said})` }
    return { ok: false, reason: 'refused', status, detail: `GitHub said ${status}${said}` }
  }

  // ---------------------------------------------------------------- the key, the version, git

  /** The GitHub key, read fresh for every request (so adding the file needs no restart). Null when there is none. */
  async function readToken(): Promise<string | null> {
    const fromEnv = cleanToken(env.SR2_GITHUB_TOKEN ?? '')
    if (fromEnv) return fromEnv
    for (const f of TOKEN_FILES) {
      let buf: Buffer
      try {
        buf = await readFile(join(root, f))
      } catch (err) {
        if (codeOf(err) !== 'ENOENT') warn(`could not read ${f} (${errText(err)}); reporting stays off`)
        continue
      }
      const token = cleanToken(decodeText(buf))
      if (token) return token
      warn(`${f} is there but does not look like a GitHub key (one line, starting github_pat_); reporting stays off`)
    }
    return null
  }

  async function readVersion(): Promise<string> {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
      return typeof pkg.version === 'string' ? pkg.version : 'unknown'
    } catch (err) {
      warn(`could not read the game version from package.json (${errText(err)})`)
      return 'unknown'
    }
  }

  /** The commit this folder is on and the game files changed since (cached for a minute). */
  async function gitInfo(): Promise<{ commit: string; changed: string[] }> {
    if (gitCache && Date.now() - gitCache.at < 60_000) return gitCache
    const commit = await git(['rev-parse', '--short', 'HEAD'])
    const diff = commit ? await git(['diff', '--name-only', 'HEAD']) : null
    if (!commit && !gitMissingLogged) {
      gitMissingLogged = true
      warn('git is not available here, so reports will say "commit unknown"')
    }
    gitCache = {
      at: Date.now(),
      commit: commit || 'unknown',
      changed: diff ? diff.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20) : [],
    }
    return gitCache
  }

  function git(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: root, timeout: 3000, windowsHide: true }, (err, stdout) => {
        // No git, or not a git folder: the caller reports it once and carries on.
        resolve(err ? null : String(stdout).trim())
      })
    })
  }

  /** A path to print: inside the game folder it is shown from there (no user names in the log). */
  function shown(p: string): string {
    const rel = relative(root, p)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : p
  }
}

// ---------------------------------------------------------------- checking a report

/** A trimmed single line: no control characters, runs of spaces squashed. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Multi-line text: keeps new lines and tabs, drops other control characters. */
function multiLine(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** The report, cleaned, or a reason it can't be sent. */
function validate(x: unknown): ReportRequest | string {
  if (!x || typeof x !== 'object') return 'it was empty'
  const o = x as Record<string, unknown>
  const kind = REPORT_KINDS.find((k) => k.value === o.kind)?.value
  if (!kind) return 'it has no kind (broken, idea or something else)'
  if (typeof o.title !== 'string' || typeof o.text !== 'string') return 'it has no title or no words'
  const title = oneLine(o.title)
  const text = multiLine(o.text)
  const name = typeof o.name === 'string' ? oneLine(o.name) : ''
  if (!title) return 'it needs a short title'
  if (!text) return 'it needs to say what happened'
  if (title.length > REPORT_LIMITS.title) return `the title is longer than ${REPORT_LIMITS.title} letters`
  if (text.length > REPORT_LIMITS.text) return `it is longer than ${REPORT_LIMITS.text} letters`
  if (name.length > REPORT_LIMITS.name) return `the name is longer than ${REPORT_LIMITS.name} letters`
  const details = validateDetails(o.details)
  if (typeof details === 'string') return details
  return { kind, title, text, name, details }
}

function validateDetails(x: unknown): ReportDetails | string {
  if (!x || typeof x !== 'object') return 'its game details are missing'
  const d = x as Record<string, unknown>
  if (!Array.isArray(d.lines) || !Array.isArray(d.events) || !Array.isArray(d.errors)) return 'its game details are the wrong shape'
  if (d.lines.length > REPORT_LIMITS.lines || d.events.length > REPORT_LIMITS.events || d.errors.length > REPORT_LIMITS.errors) {
    return 'it has too many game details'
  }
  const lines: [string, string][] = []
  for (const l of d.lines) {
    if (!Array.isArray(l) || l.length !== 2 || typeof l[0] !== 'string' || typeof l[1] !== 'string') return 'a game detail is the wrong shape'
    lines.push([cut(oneLine(l[0]), REPORT_LIMITS.lineLabel), cut(oneLine(l[1]), REPORT_LIMITS.lineValue)])
  }
  const strings = (list: unknown[], max: number): string[] | null => {
    const out: string[] = []
    for (const s of list) {
      if (typeof s !== 'string') return null
      out.push(cut(oneLine(s), max))
    }
    return out
  }
  const events = strings(d.events, REPORT_LIMITS.event)
  const errors = strings(d.errors, REPORT_LIMITS.error)
  if (!events || !errors) return 'a game event or error is the wrong shape'
  return { lines, events, errors }
}

function isIssue(x: unknown): x is Issue {
  const i = x as Issue | null
  return !!i && typeof i.title === 'string' && typeof i.body === 'string' && Array.isArray(i.labels)
}

// ---------------------------------------------------------------- building the issue

/** Stop "@someone" in a report from pinging a stranger on GitHub (a zero-width space after the @). */
function noMentions(s: string): string {
  return s.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
}

/** Josh may paste code between ``` marks; one left open would swallow the rest of the issue, so close it. */
function closeFences(s: string): string {
  const fences = s.match(/```/g)?.length ?? 0
  return fences % 2 === 1 ? `${s}\n\`\`\`` : s
}

/** Text going inside a ``` block can't close it early. */
function inCode(s: string): string {
  return s.replace(/`/g, "'")
}

function buildIssue(r: ReportRequest, version: string, commit: string, changed: string[]): Issue {
  const kindWord = REPORT_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind
  const name = r.name ? noMentions(scrubPrivate(r.name)) : '(no name given)'
  const changedNote = changed.length
    ? ` (game files changed on this computer: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ` and ${changed.length - 8} more` : ''})`
    : ''
  const out: string[] = [
    closeFences(noMentions(scrubPrivate(r.text))),
    '',
    `**Kind:** ${kindWord}  `,
    `**From:** ${name}  `,
    `**Game version:** ${version}, commit ${commit}${changedNote}`,
    '',
    '<details><summary>Game details (added by the game)</summary>',
    '',
    '```text',
  ]
  for (const [k, v] of r.details.lines) out.push(inCode(scrubPrivate(`${k}: ${v}`)))
  if (r.details.events.length) {
    out.push('', 'Recent game events (seconds before the report screen opened):')
    for (const e of r.details.events) out.push(`  ${inCode(scrubPrivate(e))}`)
  }
  out.push('', r.details.errors.length ? 'Recent errors:' : 'Recent errors: none')
  for (const e of r.details.errors) out.push(`  ${inCode(scrubPrivate(e))}`)
  out.push('```', '', '</details>', '', '_Sent from the Report a problem screen in Sundown Run II._')
  const labels = [LABEL_GAME]
  const kindLabel = KIND_LABEL[r.kind]
  if (kindLabel) labels.push(kindLabel)
  return { title: noMentions(scrubPrivate(r.title)), body: out.join('\n'), labels }
}

// ---------------------------------------------------------------- small helpers

/** SR2_ISSUES_API if it is a usable http(s) address, else the real GitHub. */
function apiBase(raw: string | undefined, warn: (m: string) => void): string {
  if (!raw) return GITHUB_API
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw.replace(/\/+$/, '')
  } catch {
    // falls through to the warning below
  }
  warn(`SR2_ISSUES_API "${raw}" is not an http address; using GitHub`)
  return GITHUB_API
}

/**
 * Only the game's own pages may use this: the request must come to a local
 * or LAN address (like Vite's own host check) from a page on the same address.
 */
function callerProblem(req: IncomingMessage): string | null {
  const host = String(req.headers.host ?? '')
  const name = hostName(host)
  if (!(name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0)) return `host "${name}"`
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) return `page from ${origin}`
    } catch {
      return 'unreadable origin'
    }
  }
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return `${site} request`
  return null
}

function hostName(host: string): string {
  if (host.startsWith('[')) return host.slice(1, Math.max(1, host.indexOf(']'))).toLowerCase()
  const i = host.lastIndexOf(':')
  return (i >= 0 ? host.slice(0, i) : host).toLowerCase()
}

/** The body as text, or null if it is bigger than `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    req.resume()
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size > max) {
        over = true
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function reply(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Windows Notepad may save UTF-16 or put a marker at the start; read all of them. */
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return buf.toString('utf8')
}

/** A GitHub key is one word of letters, digits and underscores. Quotes and spaces around it are forgiven. */
function cleanToken(s: string): string | null {
  const t = s.trim().replace(/^["']+|["']+$/g, '').trim()
  return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}
