// ============================================================
//  PLAY INSPECTORS - read-outs for window.__game.get('play')
// ------------------------------------------------------------
//  Each play system (props, posts, cores, traps) registers a small
//  function here that describes its state as plain JSON. The 'play'
//  inspector merges them, so a checker sees everything in one call.
// ============================================================

const sources = new Map<string, () => unknown>()

/** Register a section of the play inspector. Returns an unregister function. */
export function registerPlayInspector(name: string, fn: () => unknown): () => void {
  sources.set(name, fn)
  return () => {
    if (sources.get(name) === fn) sources.delete(name)
  }
}

export function playInspectors(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, fn] of sources) out[k] = fn()
  return out
}
