// ============================================================
//  PERF - the measurement handles the performance checks read
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Mount <PerfProbe /> once inside
//  the Canvas. It measures EVERY frame, whatever is rendering it
//  (plain r3f render or the post-processing composer):
//
//    cpu    main-thread frame work: r3f's global effect (before any
//           useFrame) -> its after-effect (after the frame rendered).
//           Includes physics, game logic and draw submission.
//    gpu    GPU time for the whole frame from
//           EXT_disjoint_timer_query_webgl2 (null where unsupported).
//    cost   max(cpu, gpu) - the number the budget is judged on.
//    delta  wall-clock gap between frames (what the player sees).
//    calls / triangles  across ALL passes of the frame (shadow, scene,
//           post). renderer.info.autoReset is switched off and reset
//           here once per frame, so a post stack cannot hide them.
//
//  Live:      frameStats (read by the auto-quality manager, FPS meter)
//  Recorded:  startPerfRecording({...}) -> window.__perf (PerfReport)
//             The ?demo=1 drive starts it after its warm-up; a checker
//             can also call window.__perfStart(seconds) by hand.
//
//  Budgets mirror CONSTITUTION.md section 2.
// ============================================================

import { useEffect } from 'react'
import { addAfterEffect, addEffect, useThree } from '@react-three/fiber'

export type QualityPreset = 'low' | 'medium' | 'high'

export const PERF_BUDGET: Record<QualityPreset, { avgMs: number; p99Ms: number; calls: number; triangles: number }> = {
  high: { avgMs: 12, p99Ms: 16.6, calls: 250, triangles: 1_500_000 },
  medium: { avgMs: 10, p99Ms: 14, calls: 180, triangles: 1_000_000 },
  low: { avgMs: 8, p99Ms: 12, calls: 120, triangles: 600_000 },
}

/** Live per-frame numbers (mutated in place every frame). */
export const frameStats = {
  frame: 0,
  cpuMs: 0,
  /** Latest GPU result that came back (a few frames old), or -1 if unsupported. */
  gpuMs: -1,
  costMs: 0,
  deltaMs: 16.7,
  calls: 0,
  triangles: 0,
  /** Smoothed values for meters (EMA over ~0.5 s). */
  fpsEma: 60,
  costEma: 0,
  gpuSupported: false,
}

export interface PerfReport {
  running: boolean
  done: boolean
  label: string
  track: string
  quality: string
  /** git commit the build came from (if the app knows it). */
  commit: string
  frames: number
  seconds: number
  cpuAvgMs: number
  cpuP99Ms: number
  /** null when the GPU timer extension is unavailable. */
  gpuAvgMs: number | null
  gpuP99Ms: number | null
  gpuSamples: number
  costAvgMs: number
  costP99Ms: number
  deltaAvgMs: number
  deltaP99Ms: number
  fps: number
  /** Frames whose delta exceeded 25 ms. */
  longFrames: number
  callsAvg: number
  callsMax: number
  trianglesAvg: number
  trianglesMax: number
  budget: (typeof PERF_BUDGET)[QualityPreset]
  /** Every budget line held (cost avg/p99, calls max, triangles max). */
  pass: boolean
}

declare global {
  interface Window {
    __perf?: PerfReport
    __perfStart?: (seconds?: number, label?: string) => void
  }
}

// ---------------------------------------------------------------- recording buffers (preallocated)

const MAX = 12000 // 30 s at 400 fps
const recCpu = new Float32Array(MAX)
const recGpu = new Float32Array(MAX) // -1 = no result
const recDelta = new Float32Array(MAX)
const recCalls = new Float32Array(MAX)
const recTris = new Float32Array(MAX)
const scratch = new Float32Array(MAX)

const rec = {
  active: false,
  startFrame: 0,
  n: 0,
  endAt: 0,
  label: '',
  track: '',
  quality: '',
  finishing: 0, // frames left to wait for late GPU results
}

// Rolling window for the auto-quality manager (cost of the last ~5 s).
const ROLL = 1200
const rollCost = new Float32Array(ROLL)
const rollSort = new Float32Array(ROLL)
let rollN = 0
let rollI = 0

/** p95 of frame cost over roughly the last 5 seconds (sorts a preallocated copy). */
export function rollingCostP95(): number {
  const n = Math.min(rollN, ROLL)
  if (n === 0) return 0
  rollSort.set(rollCost.subarray(0, n))
  const view = rollSort.subarray(0, n)
  view.sort()
  return view[Math.min(n - 1, Math.floor(0.95 * n))]
}

export function resetRollingCost(): void {
  rollN = 0
  rollI = 0
}

function pct(src: Float32Array, n: number, p: number): number {
  if (n <= 0) return 0
  scratch.set(src.subarray(0, n))
  const v = scratch.subarray(0, n)
  v.sort()
  return v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]
}

function avg(src: Float32Array, n: number): number {
  let s = 0
  for (let i = 0; i < n; i++) s += src[i]
  return n > 0 ? s / n : 0
}

function maxOf(src: Float32Array, n: number): number {
  let m = 0
  for (let i = 0; i < n; i++) if (src[i] > m) m = src[i]
  return m
}

let commitHash = ''
/** The app sets this at boot if it knows its build commit. */
export function setPerfCommit(hash: string): void {
  commitHash = hash
}

/** Start recording. Results land in window.__perf when `seconds` have passed. */
export function startPerfRecording(opts: { seconds: number; label?: string; track?: string; quality?: string }): void {
  rec.active = true
  rec.startFrame = frameStats.frame + 1
  rec.n = 0
  rec.endAt = performance.now() + opts.seconds * 1000
  rec.label = opts.label ?? 'manual'
  rec.track = opts.track ?? ''
  rec.quality = opts.quality ?? ''
  rec.finishing = 0
  recGpu.fill(-1)
  window.__perf = {
    ...emptyReport(),
    running: true,
    label: rec.label,
    track: rec.track,
    quality: rec.quality,
  }
}

function emptyReport(): PerfReport {
  return {
    running: false,
    done: false,
    label: '',
    track: '',
    quality: '',
    commit: commitHash,
    frames: 0,
    seconds: 0,
    cpuAvgMs: 0,
    cpuP99Ms: 0,
    gpuAvgMs: null,
    gpuP99Ms: null,
    gpuSamples: 0,
    costAvgMs: 0,
    costP99Ms: 0,
    deltaAvgMs: 0,
    deltaP99Ms: 0,
    fps: 0,
    longFrames: 0,
    callsAvg: 0,
    callsMax: 0,
    trianglesAvg: 0,
    trianglesMax: 0,
    budget: PERF_BUDGET.high,
    pass: false,
  }
}

function finishRecording(): void {
  const n = rec.n
  // cost per frame = max(cpu, gpu); frames without a GPU result use cpu only
  const cost = new Float32Array(n)
  const gpuVals = new Float32Array(n)
  let g = 0
  for (let i = 0; i < n; i++) {
    const gpu = recGpu[i]
    cost[i] = gpu >= 0 ? Math.max(recCpu[i], gpu) : recCpu[i]
    if (gpu >= 0) gpuVals[g++] = gpu
  }
  let seconds = 0
  let long = 0
  for (let i = 0; i < n; i++) {
    seconds += recDelta[i]
    if (recDelta[i] > 25) long++
  }
  seconds /= 1000
  const quality = (rec.quality || 'high') as QualityPreset
  const budget = PERF_BUDGET[quality] ?? PERF_BUDGET.high
  const report: PerfReport = {
    running: false,
    done: true,
    label: rec.label,
    track: rec.track,
    quality,
    commit: commitHash,
    frames: n,
    seconds,
    cpuAvgMs: avg(recCpu, n),
    cpuP99Ms: pct(recCpu, n, 0.99),
    gpuAvgMs: g > 0 ? avg(gpuVals, g) : null,
    gpuP99Ms: g > 0 ? pct(gpuVals, g, 0.99) : null,
    gpuSamples: g,
    costAvgMs: avg(cost, n),
    costP99Ms: pct(cost, n, 0.99),
    deltaAvgMs: avg(recDelta, n),
    deltaP99Ms: pct(recDelta, n, 0.99),
    fps: seconds > 0 ? n / seconds : 0,
    longFrames: long,
    callsAvg: avg(recCalls, n),
    callsMax: maxOf(recCalls, n),
    trianglesAvg: avg(recTris, n),
    trianglesMax: maxOf(recTris, n),
    budget,
    pass: false,
  }
  report.pass =
    report.costAvgMs <= budget.avgMs &&
    report.costP99Ms <= budget.p99Ms &&
    report.callsMax <= budget.calls &&
    report.trianglesMax <= budget.triangles
  window.__perf = report
  console.info('[perf]', JSON.stringify(report))
}

// ---------------------------------------------------------------- GPU timer pool

interface PendingQuery {
  q: WebGLQuery
  /** Recording slot this frame belongs to, or -1 if not recording. */
  slot: number
  busy: boolean
}

/** Mount once inside <Canvas>. Renders nothing. */
export function PerfProbe(): null {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const ctx = gl.getContext() as WebGL2RenderingContext
    const ext = (ctx.getExtension('EXT_disjoint_timer_query_webgl2') as {
      TIME_ELAPSED_EXT: number
      GPU_DISJOINT_EXT: number
    } | null)
    frameStats.gpuSupported = !!ext
    gl.info.autoReset = false

    const POOL = 12
    const pool: PendingQuery[] = []
    if (ext) for (let i = 0; i < POOL; i++) pool.push({ q: ctx.createQuery()!, slot: -1, busy: false })
    let active: PendingQuery | null = null
    let frameStart = 0
    let lastTs = 0

    const pollQueries = () => {
      if (!ext) return
      const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT)
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i]
        if (!p.busy || p === active) continue
        if (!ctx.getQueryParameter(p.q, ctx.QUERY_RESULT_AVAILABLE)) continue
        const ns = ctx.getQueryParameter(p.q, ctx.QUERY_RESULT) as number
        p.busy = false
        if (disjoint) continue
        const ms = ns / 1e6
        frameStats.gpuMs = ms
        if (p.slot >= 0 && p.slot < MAX) recGpu[p.slot] = ms
      }
    }

    const before = addEffect((ts: number) => {
      frameStart = performance.now()
      if (lastTs > 0) frameStats.deltaMs = ts - lastTs
      lastTs = ts
      gl.info.reset()
      pollQueries()
      if (ext) {
        active = null
        for (let i = 0; i < pool.length; i++) {
          if (!pool[i].busy) {
            active = pool[i]
            break
          }
        }
        if (active) {
          active.busy = true
          active.slot = rec.active && rec.finishing === 0 ? rec.n : -1
          ctx.beginQuery(ext.TIME_ELAPSED_EXT, active.q)
        }
      }
    })

    const after = addAfterEffect(() => {
      if (ext && active) {
        ctx.endQuery(ext.TIME_ELAPSED_EXT)
        active = null
      }
      const cpu = performance.now() - frameStart
      frameStats.frame++
      frameStats.cpuMs = cpu
      frameStats.calls = gl.info.render.calls
      frameStats.triangles = gl.info.render.triangles
      const cost = frameStats.gpuMs >= 0 ? Math.max(cpu, frameStats.gpuMs) : cpu
      frameStats.costMs = cost
      const d = frameStats.deltaMs > 0 ? frameStats.deltaMs : 16.7
      frameStats.fpsEma += (1000 / d - frameStats.fpsEma) * 0.05
      frameStats.costEma += (cost - frameStats.costEma) * 0.05
      rollCost[rollI] = cost
      rollI = (rollI + 1) % ROLL
      rollN++

      if (rec.active) {
        if (rec.finishing > 0) {
          rec.finishing--
          if (rec.finishing === 0) {
            rec.active = false
            finishRecording()
          }
        } else if (rec.n < MAX) {
          const i = rec.n++
          recCpu[i] = cpu
          recDelta[i] = d
          recCalls[i] = frameStats.calls
          recTris[i] = frameStats.triangles
          if (performance.now() >= rec.endAt) rec.finishing = 10 // let late GPU results land
        }
      }
    })

    window.__perfStart = (seconds = 30, label = 'manual') => startPerfRecording({ seconds, label })

    return () => {
      before()
      after()
      if (ext) for (const p of pool) ctx.deleteQuery(p.q)
      gl.info.autoReset = true
    }
  }, [gl])

  return null
}
