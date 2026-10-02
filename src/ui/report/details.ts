// ============================================================
//  REPORT DETAILS - what the game adds to a report by itself
// ------------------------------------------------------------
//  A bug report is far easier to fix when it says where you were
//  and what the game was doing. snapshotDetails() collects that the
//  moment the Report screen opens (before any typing, so the car's
//  position and speed are where the problem happened):
//
//    track, mode, car, car position and speed, graphics preset and
//    the measured frame rate, the graphics chip, browser and system,
//    window size, settings changed from their defaults, the last 20
//    game events (core/events.ts) and recent errors.
//
//  The screen shows all of it under "What gets sent" before sending.
//  Nothing private: no internet address, no computer user name, no
//  folder paths (scrubPrivate hides any that sneak into an error).
//
//  Recent errors: this file listens for errors nobody caught
//  (window 'error' and 'unhandledrejection'). Those only fire when
//  something breaks, so listening costs nothing per frame.
// ============================================================

import { getGame } from '../../core/store'
import type { GameMode, Phase } from '../../core/store'
import { getDefaults, getSettings } from '../../core/settings'
import type { Settings } from '../../core/settings'
import { telemetry } from '../../core/telemetry'
import { frameStats } from '../../core/perf'
import { recentEvents } from '../../core/events'
import type { AnyGameEvent } from '../../core/events'
import { apiInstalled, vehicle } from '../../core/api'
import { getTrackFile } from '../../track/registry'
import { gpuInfo } from '../gpu'
import { REPORT_LIMITS, scrubPrivate } from './protocol'
import type { ReportDetails } from './protocol'

const PHASE_WORD: Record<Phase, string> = {
  title: 'Title screen',
  loading: 'Loading a track',
  playing: 'Driving',
  paused: 'Pause menu',
  results: 'Results screen',
  editor: 'Road editor',
}

const MODE_WORD: Record<GameMode, string> = {
  free: 'Free Roam',
  timetrial: 'Time Trial',
  race: 'Race',
  stunt: 'Stunt Attack',
  tag: 'Tag',
}

// ---------------------------------------------------------------- recent errors

interface SeenError {
  text: string
  count: number
  at: number
}

/** The last few uncaught errors, newest last. A repeat bumps a count instead of a new row. */
const seenErrors: SeenError[] = []

/** "http://localhost:5201/src/ui/x.tsx?t=123" -> "x.tsx": file names help, addresses don't. */
function shortenUrls(s: string): string {
  return s.replace(/\b(?:https?|file|blob):\/\/[^\s)'"]*?([^/\s)'"?#]+)(?:[?#][^\s)'"]*)?(?=[\s)'"]|$)/g, '$1')
}

function rememberError(text: string): void {
  const clean = scrubPrivate(shortenUrls(text)).replace(/\s+/g, ' ').trim().slice(0, REPORT_LIMITS.error)
  if (!clean) return
  const same = seenErrors.find((e) => e.text === clean)
  if (same) {
    same.count++
    same.at = performance.now()
    return
  }
  seenErrors.push({ text: clean, count: 1, at: performance.now() })
  if (seenErrors.length > REPORT_LIMITS.errors) seenErrors.shift()
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`
  try {
    return typeof reason === 'string' ? reason : JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

const onError = (e: ErrorEvent) => {
  const where = e.filename ? ` (${shortenUrls(e.filename)}:${e.lineno})` : ''
  rememberError(`${e.message || reasonText(e.error)}${where}`)
}
const onRejection = (e: PromiseRejectionEvent) => rememberError(`Unhandled promise: ${reasonText(e.reason)}`)

if (typeof window !== 'undefined') {
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  // A hot reload of this file must not leave the old listeners behind.
  import.meta.hot?.dispose(() => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  })
}

// ---------------------------------------------------------------- the snapshot

function fixed(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '?'
}

/** "Chrome 141 on Windows 10 or 11" from the browser's user agent. */
function browserWords(ua: string): string {
  const os = /Windows NT 10/.test(ua)
    ? 'Windows 10 or 11'
    : /Windows/.test(ua)
      ? 'Windows'
      : /CrOS/.test(ua)
        ? 'ChromeOS'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : /Mac OS X/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'an unknown system'
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua)
    return m ? `${name} ${m[1]}` : null
  }
  const browser =
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/OPR\/(\d+)/, 'Opera') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+).*Safari/, 'Safari') ??
    'An unknown browser'
  return `${browser} on ${os}`
}

/** "grip 1.2 (normally 1)": every setting that differs from config.ts's default. */
function changedSettings(s: Settings): string {
  const d = getDefaults()
  const out: string[] = []
  // The defaults hold only the settings themselves (the live store also has its functions).
  for (const key of Object.keys(d) as (keyof Settings)[]) {
    const now = s[key]
    const was = d[key]
    if (key === 'trackParams' || typeof now === 'function' || typeof now === 'object') continue
    const differs = typeof now === 'number' && typeof was === 'number' ? Math.abs(now - was) > 1e-6 : now !== was
    if (differs) out.push(`${key} ${typeof now === 'number' ? Number(now.toFixed(3)) : String(now)} (normally ${typeof was === 'number' ? Number(was.toFixed(3)) : String(was)})`)
  }
  return out.length ? out.join(', ') : 'none'
}

/** One event as a short line: "-3.2s lap.complete {"lap":2,"ms":61234}". Player names are left out. */
function eventLine(e: AnyGameEvent, now: number): string {
  const { type, t, ...rest } = e as unknown as { type: string; t: number } & Record<string, unknown>
  const payload = JSON.stringify(rest, (key, v: unknown) => {
    if (key === 'name') return '(name)'
    if (key === 'results' && Array.isArray(v)) return `${v.length} results`
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100
    return v
  })
  const line = `${fixed((t - now) / 1000, 1)}s ${type}${payload && payload !== '{}' ? ` ${payload}` : ''}`
  return line.length > REPORT_LIMITS.event ? `${line.slice(0, REPORT_LIMITS.event - 1)}…` : line
}

/** Everything the game attaches to a report, as it is right now. */
export function snapshotDetails(): ReportDetails {
  const now = performance.now()
  const g = getGame()
  const s = getSettings()
  const lines: [string, string][] = []
  const add = (label: string, value: string) => {
    const v = scrubPrivate(value)
    lines.push([label, v.length > REPORT_LIMITS.lineValue ? `${v.slice(0, REPORT_LIMITS.lineValue - 1)}…` : v])
  }

  add('Where', `${PHASE_WORD[g.phase]}${g.multiplayer ? ', multiplayer' : ''}`)
  const trackName = g.trackName || getTrackFile(g.trackId)?.name || g.trackId
  add('Track', `${trackName} (${g.trackId})`)
  add('Mode', MODE_WORD[g.mode] ?? g.mode)

  const bodyName = apiInstalled().vehicle ? vehicle.bodies().find((b) => b.id === s.carBody)?.name : undefined
  add('Car', `${bodyName ?? s.carBody} (${s.carBody}), paint ${s.paint}, underglow ${s.glow}, trail ${s.trail}`)
  const p = telemetry.carPosition
  const where = telemetry.onRoad ? 'on the road' : `off the road (${telemetry.surface})`
  add('Car position', `x ${fixed(p.x, 1)}, y ${fixed(p.y, 1)}, z ${fixed(p.z, 1)}, ${where}${telemetry.airborne ? ', in the air' : ''}, road distance ${fixed(telemetry.trackS, 0)} m`)
  add('Speed', `${fixed(telemetry.speedKmh, 0)} km/h`)

  const quality = s.quality === 'auto' ? `Auto (running ${g.qualityLevel})` : s.quality
  add('Graphics', quality)
  const gpuMs = frameStats.gpuMs >= 0 ? `${fixed(frameStats.gpuMs, 1)} ms` : 'not measured'
  add('Frame rate', `${fixed(frameStats.fpsEma, 0)} fps, frame cost ${fixed(frameStats.costEma, 1)} ms (CPU ${fixed(frameStats.cpuMs, 1)} ms, GPU ${gpuMs})`)
  add('Drawing', `${frameStats.calls} draw calls, ${Math.round(frameStats.triangles / 1000)}k triangles`)
  add('Graphics chip', gpuInfo()?.raw ?? 'unknown')

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  add('Browser', browserWords(ua))
  add('Browser details', ua || 'unknown')
  add('Screen', `${window.innerWidth}x${window.innerHeight} window, ${window.screen.width}x${window.screen.height} screen, pixel ratio ${fixed(window.devicePixelRatio, 2)}`)
  add('Controls', g.inputDevice === 'gamepad' ? 'controller' : 'keyboard')
  add('Time of day', fixed(s.timeOfDay, 2))
  add('Changed settings', changedSettings(s))

  const events = recentEvents().slice(-REPORT_LIMITS.events).map((e) => eventLine(e, now))
  const errors = seenErrors.map((e) => `${fixed((e.at - now) / 1000, 0)}s ${e.text}${e.count > 1 ? ` (x${e.count})` : ''}`)
  return { lines, events, errors }
}
