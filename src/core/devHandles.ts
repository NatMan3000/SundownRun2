// ============================================================
//  DEV HANDLES - what checkers and the probe script can reach
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Present in dev AND production
//  builds (checkers verify a built preview), harmless to players.
//
//  window.__game   read-only inspection (getters: read them when you
//                  need them, do not snapshot and expect updates)
//  window.__dev    commands. Each system registers its own with
//                  registerDev(name, fn, help). List them with
//                  window.__dev.help().
//  window.__perf   PerfReport from the last recording (core/perf.ts)
//  window.__events recent game events (core/events.ts)
//
//  URL switches every build understands (handled by their owners):
//    ?track=<id>        load this track straight away (skips title)
//    ?mode=<mode>       free | timetrial | race | stunt
//    ?demo=1            scripted autopilot + perf recording (vehicle)
//    ?time=<0..1>       time-of-day override (world)
//    ?quality=<q>       low | medium | high (look)
//    ?cam=<bookmark>    fixed camera bookmark (vehicle camera)
//    ?ai=<n>            Ai racer count override (play)
//    ?mp=1&name=&color= multiplayer (net)
//    ?nomusic=1         mute music (audio) - handy for checkers
// ============================================================

import { cars, telemetry } from './telemetry'
import { frameStats } from './perf'
import { getGame } from './store'
import { getSettings } from './settings'
import { recentEvents } from './events'
import { apiInstalled } from './api'

type DevFn = (...args: never[]) => unknown

const commands = new Map<string, { fn: DevFn; help: string }>()

/** Register a dev command, reachable as window.__dev.<name>(...). */
export function registerDev(name: string, fn: DevFn, help: string): () => void {
  commands.set(name, { fn, help })
  return () => {
    if (commands.get(name)?.fn === fn) commands.delete(name)
  }
}

/** Extra read-only inspection getters other systems can add to window.__game. */
const inspectors = new Map<string, () => unknown>()

export function registerInspector(name: string, get: () => unknown): () => void {
  inspectors.set(name, get)
  return () => {
    if (inspectors.get(name) === get) inspectors.delete(name)
  }
}

/** URL query helper used by every owner of a switch above. */
export function urlParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

declare global {
  interface Window {
    __game?: Record<string, unknown>
    __dev?: Record<string, unknown>
  }
}

if (typeof window !== 'undefined') {
  const game: Record<string, unknown> = {}
  Object.defineProperties(game, {
    telemetry: { get: () => telemetry, enumerable: true },
    cars: { get: () => cars, enumerable: true },
    frame: { get: () => frameStats, enumerable: true },
    renderInfo: { value: () => ({ calls: frameStats.calls, triangles: frameStats.triangles }), enumerable: true },
    state: { get: () => getGame(), enumerable: true },
    settings: { get: () => getSettings(), enumerable: true },
    events: { get: () => recentEvents(), enumerable: true },
    apiInstalled: { value: () => apiInstalled(), enumerable: true },
    get: { value: (name: string) => inspectors.get(name)?.(), enumerable: true },
    inspectors: { value: () => [...inspectors.keys()], enumerable: true },
  })
  window.__game = game

  window.__dev = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'help') return () => [...commands.entries()].map(([k, v]) => `${k}: ${v.help}`).join('\n')
        const c = commands.get(prop)
        return c ? c.fn : undefined
      },
      has(_t, prop: string) {
        return prop === 'help' || commands.has(prop)
      },
      ownKeys() {
        return ['help', ...commands.keys()]
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true }
      },
    },
  )
}
