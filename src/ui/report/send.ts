// ============================================================
//  REPORT SENDER - hands a report to the game's server
// ------------------------------------------------------------
//  The browser never talks to GitHub itself (the key must stay on
//  the server). It sends the report to the game's own server at
//  /api/report (server/issues.ts), which posts it or saves it.
//
//  If even the game's server can't be reached (its window was
//  closed while the game was still open), the report is kept in
//  this browser and handed over the next time the Report screen
//  opens and the server answers. A report is never just dropped.
// ============================================================

import { REPORT_ENDPOINT } from './protocol'
import type { ReportInfo, ReportRequest, ReportResult } from './protocol'

/** Reports waiting in this browser because the server wasn't answering. */
const QUEUE_KEY = 'sr2.reports.unsent'
const QUEUE_MAX = 10
/** The server waits up to 15 s for GitHub, so give it a bit longer than that. */
const SEND_TIMEOUT_MS = 30_000

function readQueue(): ReportRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? (list as ReportRequest[]) : []
  } catch (err) {
    console.error('[report] could not read the reports waiting in this browser', err)
    return []
  }
}

function writeQueue(list: ReportRequest[]): boolean {
  try {
    if (list.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(list))
    else localStorage.removeItem(QUEUE_KEY)
    return true
  } catch (err) {
    console.error('[report] could not save reports in this browser', err)
    return false
  }
}

/** How many reports are waiting in this browser. */
export function browserQueueLength(): number {
  return readQueue().length
}

function isResult(x: unknown): x is ReportResult {
  const s = (x as { status?: unknown } | null)?.status
  return s === 'sent' || s === 'saved' || s === 'rejected'
}

/** One POST. Null when the server could not be reached or didn't answer like the game's server. */
async function post(req: ReportRequest): Promise<ReportResult | null> {
  let res: Response
  try {
    res = await fetch(REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (err) {
    console.warn('[report] the game server did not answer', err)
    return null
  }
  // 500s (other than "too many waiting", which is a real answer) mean the server itself is in trouble.
  if (res.status >= 500 && res.status !== 507) {
    console.warn(`[report] the game server had a problem (${res.status})`)
    return null
  }
  try {
    const body: unknown = await res.json()
    if (isResult(body)) return body
  } catch (err) {
    console.warn('[report] the answer was not from the game server', err)
    return null
  }
  console.warn(`[report] the game server answered ${res.status} with something unexpected`)
  return null
}

/**
 * Send a report. Always resolves: sent, saved (on this computer or in this
 * browser), or rejected with a message to show (too many, too big, ...).
 */
export async function sendReport(req: ReportRequest): Promise<ReportResult> {
  const answer = await post(req)
  if (answer) return answer
  const queue = readQueue()
  if (queue.length >= QUEUE_MAX || !writeQueue([...queue, req])) {
    return {
      status: 'rejected',
      reason: 'full',
      message: "The game's server isn't answering and this report couldn't be kept. Start the game again and send it then.",
    }
  }
  return { status: 'saved', reason: 'no-server', waiting: queue.length + 1 }
}

/** Is reporting switched on? Null when the game's server can't be reached. */
export async function fetchReportInfo(): Promise<ReportInfo | null> {
  try {
    const res = await fetch(REPORT_ENDPOINT, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.warn(`[report] the game server answered ${res.status} when asked about reporting`)
      return null
    }
    const info = (await res.json()) as ReportInfo
    return typeof info?.ready === 'boolean' ? info : null
  } catch (err) {
    console.warn('[report] could not ask the game server about reporting', err)
    return null
  }
}

/** Hand reports kept in this browser to the server, oldest first. Returns how many it took. */
export async function flushBrowserQueue(): Promise<number> {
  if (flushing) return 0 // one at a time, or a report could be handed over twice
  flushing = true
  try {
    return await handOver()
  } finally {
    flushing = false
  }
}

let flushing = false

async function handOver(): Promise<number> {
  let handed = 0
  for (let first = readQueue()[0]; first; first = readQueue()[0]) {
    const answer = await post(first)
    if (!answer) break // still not answering: try again next time
    if (answer.status === 'rejected' && answer.reason === 'too-many') break // the server's rate limit: later
    if (answer.status === 'rejected') console.error(`[report] dropped a report kept in this browser: ${answer.message}`)
    else handed++
    // Read again before removing it: a new report may have joined the end meanwhile.
    if (!writeQueue(readQueue().slice(1))) break
  }
  return handed
}
