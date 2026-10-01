// ============================================================
//  TUNE - change a handling number live, without a rebuild
// ------------------------------------------------------------
//  The tables in src/vehicle/tuning.ts are plain objects, so a
//  number in them can be changed while the game runs and the very
//  next physics step uses it. That makes a sweep (try five values,
//  measure each) a few probe runs instead of five rebuilds:
//
//    window.__dev.tune('ASSIST.hsYawDamp')        read it
//    window.__dev.tune('ASSIST.hsYawDamp', 1500)  set it (returns the old value)
//
//  Dev only, and nothing is saved: a reload puts every value back.
//  When a swept value wins, write it into tuning.ts by hand.
// ============================================================

import { registerDev } from '../core/devHandles'
import * as T from '../vehicle/tuning'

const TABLES = T as unknown as Record<string, Record<string, unknown>>

function tune(path: string, value?: number): unknown {
  const [table, key] = String(path).split('.')
  const t = TABLES[table]
  if (!t || typeof t !== 'object' || !key || !(key in t)) return `no such number: ${path}`
  const old = t[key]
  if (value === undefined) return old
  if (typeof old !== 'number' || !Number.isFinite(Number(value))) return `${path} is not a number, or the new value is not`
  t[key] = Number(value)
  return old
}

registerDev('tune', tune as never, "tune('TABLE.key', value?): read or live-set a number in src/vehicle/tuning.ts (dev only, not saved)")
