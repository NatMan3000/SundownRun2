// ============================================================
//  <AudioSystem /> - everything the player hears
// ------------------------------------------------------------
//  Mounted once inside the Canvas (App.tsx). It creates the
//  AudioRig (system.ts), plugs it into the shared audio API so
//  menus and the input system can call audio.ui() / audio.unlock(),
//  and ticks it once per rendered frame.
//
//  Every sound is synthesised in code: no audio files at all.
//
//  Dev handles (for checkers and the probe script):
//    window.__game.get('audio')        live state: context, faders,
//                                      engine readout, sounds played
//    window.__dev.audio('help')        list the test commands
//    ?nomusic=1                        mute the music
//    ?engine=muscle|rally|hover        pick the engine sound for this visit
//    ?motor=nodes                      force the node motor (what a LAN guest hears)
// ============================================================

import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { installAudio } from '../core/api'
import type { UiSound } from '../core/api'
import { registerDev, registerInspector } from '../core/devHandles'
import type { AnyGameEvent, GameEventType } from '../core/events'
import { createRig, destroyRig } from './system'
import type { AudioRig } from './system'
import type { EngineInput } from './engine'
import { encodeWav, measure, renderEffectsReel, renderEngineSweep, renderMix, renderMusic, renderRewind, rewindNumbers, toBase64 } from './render'
import type { MixStem, MotorChoice } from './render'
import { ENGINE_SOUND_IDS, isEngineSound, resolveEngineSound } from './engineVoicings'
import { isTestDrive } from './sweep'
import type { TestDriveId } from './sweep'
import type { MoodId } from './music/score'

const DEV_HELP = [
  "audio('start')                      start sound (the probe has no real gesture)",
  "audio('state')                      same as __game.get('audio')",
  "audio('ui', kind)                   play a menu sound: move select back toggle slide start error countdown go",
  "audio('play', type, payload)        play the sound for a game event without emitting it, e.g. audio('play','crash',{what:'wall',intensity:0.8,speedKmh:120})",
  "audio('engine', {rpm, throttle, speedKmh, gear, slip, airborne, offRoad, magStrength, boost})   drive the engine from values",
  "audio('engine', 'live')             back to live telemetry",
  "audio('mood', m)                   switch the music mood (fresh seed) from the next bar: cruise drive race hyper",
  "audio('section', s)                hold a music section: title intro groove build drop breakdown, or 'auto'",
  "audio('engine-sound', id)          play another engine now: muscle rally hover, or 'auto' (back to ?engine= / config.ts)",
  "audio('sweep')                      18 s scripted test drive: idle, blips, gears, cruise, lift-off, jump (free-rev), landing, drift, boost, off-road, mag grip",
  "audio('sweep', 'drift')             19 s tyre test drive: a long drift at 60 km/h, a big one at 120, a small slide, a slide on the grass",
  "audio('sweep', 'speed')             19 s top speed test drive: every gear to 250 km/h, held, a boost pad, a lift",
  "audio('render', what, arg?)        record offline, resolves to { wav (base64), peakDb, rmsDb, seconds, log }. what: engine | drift | speed (the engine, tyre or top speed test drive), arg: muscle | rally | hover (add ':nodes' for the node motor) | effects | title | cruise | drive | race | hyper (arg: night 0..1) | mix (arg: all | engine | music | fx) | rewind (rewind held 2-5 s over a cruise: adds the rewind sound's numbers)",
].join('\n')

export function AudioSystem() {
  const rigRef = useRef<AudioRig | null>(null)

  useEffect(() => {
    const rig = createRig()
    rigRef.current = rig
    installAudio({
      ui: (kind: UiSound) => rig.ui(kind),
      unlock: () => rig.unlock(),
      isRunning: () => rig.isRunning(),
    })
    const offInspector = registerInspector('audio', () => rig.inspect())
    const offDev = registerDev(
      'audio',
      ((cmd?: string, a?: unknown, b?: unknown) => devCommand(rig, cmd, a, b)) as (...args: never[]) => unknown,
      'audio(cmd, ...) - sound tests; audio("help") lists them',
    )
    return () => {
      offInspector()
      offDev()
      rigRef.current = null
      destroyRig(rig)
    }
  }, [])

  useFrame(() => {
    rigRef.current?.frame()
  })

  return null
}

function devCommand(rig: AudioRig, cmd?: string, a?: unknown, b?: unknown): unknown {
  switch (cmd) {
    case undefined:
    case 'help':
      return DEV_HELP
    case 'start':
      rig.unlock()
      return rig.inspect().state
    case 'state':
      return rig.inspect()
    case 'ui':
      rig.ui(a as UiSound)
      return true
    case 'play': {
      const payload = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
      return rig.testEvent({ type: a as GameEventType, t: performance.now(), ...payload } as unknown as AnyGameEvent)
    }
    case 'engine':
      rig.setOverride(a === 'live' ? null : (a as Partial<EngineInput>))
      return true
    case 'engine-sound':
      return rig.setEngineSound(String(a))
    case 'sweep': {
      const drive = a === undefined ? 'sweep' : String(a)
      if (!isTestDrive(drive)) return `unknown drive "${drive}" (sweep | drift | speed)`
      return rig.startSweep(drive)
    }
    case 'mood':
      return rig.setMood(String(a))
    case 'section':
      return rig.setSection(String(a))
    case 'render':
      return renderToWav(a as string, b)
    default:
      return `unknown audio command "${cmd}". ${DEV_HELP}`
  }
}

const MUSIC_RENDERS = ['title', 'cruise', 'drive', 'race', 'hyper']

async function renderToWav(what: string, arg: unknown): Promise<unknown> {
  const night = Number(arg ?? 0)
  if (what === 'mix') {
    const stem = (['all', 'engine', 'music', 'fx'].includes(String(arg)) ? arg : 'all') as MixStem
    const buf = await renderMix(stem)
    return { ...measure(buf), stem, wav: toBase64(encodeWav(buf)) }
  }
  // 'engine' records the engine test drive (named 'sweep'); 'drift' and 'speed' the others.
  const drive = what === 'engine' ? 'sweep' : what
  if (isTestDrive(drive)) return renderDrive(drive, arg)
  if (what === 'rewind') {
    const all = await renderRewind('all')
    const fx = await renderRewind('fx')
    return { ...measure(all), ...rewindNumbers(all, fx), wav: toBase64(encodeWav(all)) }
  }
  if (what === 'effects') {
    const buf = await renderEffectsReel()
    return { ...measure(buf), wav: toBase64(encodeWav(buf)) }
  }
  if (MUSIC_RENDERS.includes(what)) {
    const { buf, log } = await renderMusic(what as MoodId | 'title', Number.isFinite(night) ? night : 0)
    return { ...measure(buf), log, wav: toBase64(encodeWav(buf)) }
  }
  return `unknown render "${what}" (engine | drift | speed | effects | mix | rewind | ${MUSIC_RENDERS.join(' | ')})`
}

/** Record one of the scripted drives through the engine. arg: 'rally' or 'rally:nodes'. */
async function renderDrive(drive: TestDriveId, arg: unknown): Promise<unknown> {
  const [name, how] = String(arg ?? '').split(':')
  if (name && !isEngineSound(name)) return `unknown engine "${name}" (${ENGINE_SOUND_IDS.join(' | ')})`
  const id = resolveEngineSound(name)
  const motor: MotorChoice = how === 'nodes' ? 'nodes' : 'worklet'
  const { buf, log } = await renderEngineSweep(id, motor, drive)
  return { ...measure(buf), engine: id, motor, drive, log, wav: toBase64(encodeWav(buf)) }
}
