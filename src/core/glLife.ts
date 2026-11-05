// ============================================================
//  GL LIFE - the browser can take the 3D picture away
// ------------------------------------------------------------
//  A browser may take the WebGL context away at any moment (a phone
//  going to the background, a graphics chip that hung) and usually
//  gives it back. While it is gone its reads answer null, so nothing
//  that builds GL things may build; and when it comes back whatever
//  had been drawn into a texture is gone, so those get built again.
//  three brings back everything else by itself.
//
//  How to use it: put `generation` in the deps of anything built from
//  the context, and inside ask the context itself
//  (`gl.getContext().isContextLost()`). The event comes a moment after
//  the loss, so between the two only the context knows.
//
//  A context that stays gone shows the crash screen (App.tsx,
//  CrashGuard.tsx), because a dead picture with a live menu looks like
//  a game that ignores you.
// ============================================================

import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { create } from 'zustand'

/**
 * How long the picture may stay gone while someone is looking, before the
 * crash screen. The one restore seen in Safari took 13 ms, so this is a long
 * way past it, and a wrong guess only costs a reload (a road being drawn is
 * kept).
 */
const GIVE_UP_MS = 8000
const CLOCK_MS = 250

export const useGlLife = create(() => ({
  /** Moves every time the context goes or comes back. */
  generation: 0,
  /** The context stayed gone: App.tsx swaps the game for the crash screen. */
  gaveUp: false,
}))

/** Mount once inside <Canvas>. Renders nothing, and costs nothing until a context is lost. */
export function GlWatch(): null {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const canvas = gl.domElement
    let clock = 0

    const stopClock = () => {
      window.clearInterval(clock)
      clock = 0
    }
    // Only time someone could see counts: iOS can sit on a context for as long as the page is hidden.
    const startClock = () => {
      stopClock()
      let seen = 0
      let last = performance.now()
      clock = window.setInterval(() => {
        const now = performance.now()
        // A long gap is a frozen or suspended page, not time spent looking at a dead picture.
        if (document.visibilityState === 'visible') seen += Math.min(now - last, CLOCK_MS * 2)
        last = now
        if (seen < GIVE_UP_MS) return
        stopClock()
        useGlLife.setState({ gaveUp: true })
      }, CLOCK_MS)
    }

    const moved = () => useGlLife.setState((s) => ({ generation: s.generation + 1 }))
    const onLost = () => {
      startClock()
      moved()
    }
    const onRestored = () => {
      stopClock()
      moved()
    }
    // (three's own listeners were added when the renderer was made, so they run first:
    // by the time ours hears of a restore, the renderer is ready to build on.)
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    if (gl.getContext().isContextLost()) startClock()

    return () => {
      stopClock()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [gl])

  return null
}
