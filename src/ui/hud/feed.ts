// ============================================================
//  HUD FEED - toasts and trick pops, fed by the game-event feed
// ------------------------------------------------------------
//  Gameplay systems announce moments through src/core/events.ts
//  ("lap.complete", "trick.land", "mp.join" ...). This file is the
//  HUD's one listener: it turns those facts into short messages
//  on screen. Nothing in gameplay code knows the HUD exists.
//
//  Two lists, both tiny and short-lived:
//    toasts  top-centre pills (best lap, lap void, player joined)
//    pops    the trick feed in the bottom-left corner
//  They change a few times a lap, so plain React state is fine.
// ============================================================

import { create } from 'zustand'
import { subscribe } from '../../core/events'
import type { AnyGameEvent } from '../../core/events'
import { getCar } from '../../core/telemetry'
import { getGame } from '../../core/store'
import { getSettings } from '../../core/settings'
import { formatLap, formatScore } from '../format'

export type ToastKind = 'info' | 'gold' | 'warn' | 'it'

export interface Toast {
  id: number
  text: string
  sub?: string
  kind: ToastKind
}

export interface TrickPop {
  id: number
  /** "Big Air + Flip" */
  label: string
  points: number
  combo: number
  kind: 'trick' | 'drift' | 'wipeout'
  big: boolean
}

export interface TrapReadout {
  id: number
  kmh: number
  best: boolean
  bestKmh: number | null
}

interface FeedState {
  toasts: Toast[]
  pops: TrickPop[]
  trap: TrapReadout | null
}

export const useFeed = create<FeedState>(() => ({ toasts: [], pops: [], trap: null }))

const TOAST_MS = 2600
const POP_MS = 2400
const TRAP_MS = 4200
const MAX_TOASTS = 3
const MAX_POPS = 4
/** A landing worth a bigger, hotter pop. */
const BIG_POINTS = 1000

let seq = 0

export function pushToast(text: string, kind: ToastKind = 'info', sub?: string): void {
  const t: Toast = { id: ++seq, text, kind, sub }
  useFeed.setState((s) => ({ toasts: [...s.toasts.slice(-(MAX_TOASTS - 1)), t] }))
  setTimeout(() => useFeed.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), TOAST_MS)
}

function pushPop(p: Omit<TrickPop, 'id'>): void {
  const pop: TrickPop = { ...p, id: ++seq }
  useFeed.setState((s) => ({ pops: [...s.pops.slice(-(MAX_POPS - 1)), pop] }))
  setTimeout(() => useFeed.setState((s) => ({ pops: s.pops.filter((x) => x.id !== pop.id) })), POP_MS)
}

function showTrap(kmh: number, best: boolean, previous: number | null): void {
  const r: TrapReadout = { id: ++seq, kmh, best, bestKmh: best ? kmh : previous }
  useFeed.setState({ trap: r })
  setTimeout(() => {
    if (useFeed.getState().trap?.id === r.id) useFeed.setState({ trap: null })
  }, TRAP_MS)
}

/** "You" for our own car, the car's name for anyone else. */
function nameOf(carId: string | null | undefined, fallback = 'Someone'): string {
  if (!carId) return fallback
  if (carId === 'player') return 'You'
  return getCar(carId)?.name ?? fallback
}

const VOID_WHY = {
  'skipped-sector': 'You skipped part of the track',
  reset: 'A reset ends the lap',
  restart: 'Restarted',
} as const

/** Turn one game event into HUD messages. */
function onEvent(e: AnyGameEvent): void {
  const g = getGame()
  if (g.phase !== 'playing' && !(g.multiplayer && g.phase === 'paused')) return
  switch (e.type) {
    case 'lap.complete':
      if (e.best && !e.dirty) {
        pushToast(`Best lap ${formatLap(e.ms)}`, 'gold', e.previousBestMs !== null ? `${((e.previousBestMs - e.ms) / 1000).toFixed(3)} s faster` : 'New record')
      } else if (e.dirty) {
        pushToast(`Lap ${e.lap} ${formatLap(e.ms)}`, 'warn', 'Off road too long, so it can\'t be a record')
      } else if (g.mode !== 'race') {
        pushToast(`Lap ${e.lap} ${formatLap(e.ms)}`, 'info')
      }
      return
    case 'lap.void':
      if (e.reason !== 'restart') pushToast('Lap void', 'warn', VOID_WHY[e.reason])
      return
    case 'lap.dirty':
      pushToast('Off road', 'warn', 'This lap still counts, but it can\'t set a record')
      return
    case 'trick.land': {
      if (!getSettings().tricks || e.tricks.length === 0) return
      const label = e.tricks.map((t) => t.label).join(' + ')
      pushPop({ label, points: e.points, combo: e.combo, kind: 'trick', big: e.points >= BIG_POINTS })
      return
    }
    case 'trick.wipeout':
      if (!getSettings().tricks) return
      pushPop({ label: 'Wipeout', points: -e.lostPoints, combo: 0, kind: 'wipeout', big: false })
      return
    case 'drift.end':
      if (!getSettings().tricks || e.points <= 0) return
      pushPop({ label: `Drift ${e.seconds.toFixed(1)} s`, points: e.points, combo: 0, kind: 'drift', big: false })
      return
    case 'speedtrap':
      showTrap(e.kmh, e.best, e.previousBestKmh)
      return
    case 'hunt.complete':
      pushToast(`All cores ${formatLap(e.ms)}`, 'gold', e.best ? 'New best!' : e.previousBestMs !== null ? `Best ${formatLap(e.previousBestMs)}` : undefined)
      return
    case 'race.lap':
      if (e.lap >= e.laps) return
      pushToast(e.lap === e.laps - 1 ? 'Final lap' : `Lap ${e.lap + 1} of ${e.laps}`, e.lap === e.laps - 1 ? 'gold' : 'info')
      return
    case 'stunt.end':
      pushToast(`Stunt score ${formatScore(e.score)}`, 'gold', e.best ? 'New best!' : undefined)
      return
    case 'mp.join':
      pushToast(`${e.name} joined`, 'info')
      return
    case 'mp.leave':
      pushToast(`${e.name} left`, 'info')
      return
    case 'mp.track':
      if (e.fromHost) pushToast(`Track: ${e.trackName}`, 'info', 'Picked by the host')
      return
    case 'tag.it':
      if (e.id === 'player') pushToast('You\'re it!', 'it', 'Bump someone to pass it on')
      else pushToast(`${nameOf(e.id, e.name)} is it`, 'info', e.byId === 'player' ? 'You tagged them' : undefined)
      return
    case 'reset':
      if (e.kind === 'auto') pushToast('Back on the road', 'info', e.reason)
      return
    default:
      return
  }
}

let installed = false

/** Start listening to the game-event feed (once, from the HUD). */
export function installFeed(): () => void {
  if (installed) return () => {}
  installed = true
  const off = subscribe(onEvent)
  return () => {
    off()
    installed = false
  }
}
