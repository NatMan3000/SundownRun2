// ============================================================
//  MAP GESTURES - what fingers do on the map
// ------------------------------------------------------------
//  Stands in front of Overlay.tsx's pointer handlers. The rule:
//  one finger is the tool; two fingers are always the map.
//
//  A mouse or a pen goes straight through, the same moment, so a
//  computer can't tell this file is here. A finger does not reach
//  the tool at once, because the first finger of a pinch looks
//  exactly like a tool's finger for its first few milliseconds:
//
//    armed    the finger is down and the tool has not heard. The
//             tool starts when it moves ARM_PX, or after ARM_MS, or
//             when it lifts, and is handed every spot seen so far,
//             so the Pencil loses nothing. A second finger here
//             makes it the map's, and the tool never knew.
//    tool     the tool has the finger. A second finger within
//             TAKE_BACK_PX of where it started takes the press back
//             (nothing changed, no Undo step) and becomes the pinch.
//             Any later and it is ignored, so a thumb resting on the
//             glass can't wreck a long line. One finger panning the
//             map has no line to protect: a second finger always
//             joins it.
//    map      two fingers: pinch zooms at the fingers, dragging them
//             moves the view, and in 3D twisting them turns it. When
//             one lifts the other does nothing more until it lifts
//             too, so ending a pinch never leaves a mark. A new
//             finger next to it grips the map again.
//
//  A touch the system takes away (pointercancel, the page hidden, a
//  lift that never arrived) takes the press back too. It never commits
//  half a line. A mouse's pointercancel stays what it always was.
//  Safari's own pinch of the page is turned off while this is attached.
//
//  This file knows nothing about tools or views: Overlay.tsx passes
//  its handlers in. The tools themselves (what a press means, what
//  shows while the finger is down) stay in Overlay.tsx.
// ============================================================

// ---- the numbers a thumb might want changed (Nathan's phone is the judge of these) ----
/** A finger waits this long for a second finger before the tool hears about it, milliseconds. Longer: drawing feels late. Shorter: a slow pinch leaves a mark. */
const ARM_MS = 80
/** Moved this far, pixels, it is a tool's finger whatever the clock says. */
const ARM_PX = 6
/** A second finger takes the press back while the first has stayed within this many pixels of where it started. Further than that it is ignored. */
const TAKE_BACK_PX = 24
/** In 3D, fingers must turn this many degrees before the view starts to: every pinch twists a little by accident. */
const TWIST_START_DEG = 10
/** After the last finger on the page lifts, wait this long for its pointerup, milliseconds, then treat any finger still held as lost. */
const LOST_FINGER_MS = 100

/** What the map's handlers give this file. */
export interface GestureHands {
  down(e: PointerEvent): void
  move(e: PointerEvent): void
  up(e: PointerEvent): void
  leave(e: PointerEvent): void
  /** The tool's press is called off: put everything back as it was before the press. */
  takeBack(): void
  /** True while the finger the tool has is only moving the map (there is no line or drag to protect). */
  justPanning(): boolean
  /** Zoom about screen spot (sx, sy): a factor under 1 is closer. */
  zoom(sx: number, sy: number, factor: number): void
  /** Move the view with the fingers, screen pixels. */
  slide(dx: number, dy: number): void
  /** Fingers turned by this many radians, clockwise on screen. */
  twist(radians: number): void
}

/** What has happened, for checkers (`__game.get('editorGesture')`). */
export const gestureStats = {
  phase: 'idle' as 'idle' | 'armed' | 'tool' | 'map',
  /** Fingers handed to the tool. */
  toolStarts: 0,
  /** Spots handed over when the tool started (seen while armed). */
  handedOver: 0,
  /** Times two fingers became the map's. */
  mapGestures: 0,
  /** Presses taken back. */
  takeBacks: 0,
  /** Fingers ignored because the tool was too far along. */
  ignored: 0,
  /** Milliseconds between the first finger and the second, last time a second finger landed. */
  secondFingerMs: -1,
}

interface Finger {
  id: number
  x: number
  y: number
}

/** Puts the layer in front of the handlers on `el`. Returns the function that takes it off again. */
export function attachMapGestures(el: HTMLElement, hands: GestureHands): () => void {
  const stats = gestureStats
  let phase: 'idle' | 'armed' | 'tool' | 'map' = 'idle'
  const setPhase = (p: typeof phase) => {
    phase = p
    stats.phase = p
  }
  // Armed: the press and the moves since, waiting to be handed over.
  let press: PointerEvent | null = null
  let moves: PointerEvent[] = []
  let armTimer = 0
  // Tool: which finger the tool has, where it started, how far from there it has been.
  let toolId = -1
  let toolX = 0
  let toolY = 0
  let toolFar = 0
  let toolLandedAt = 0
  // Where the finger is now, armed or with the tool (a pinch starts from here).
  let fingerX = 0
  let fingerY = 0
  /** The finger the tool had last: its pointerleave is the tool's, anybody else's isn't. */
  let leaveId = -1
  // Map: the one or two fingers on the map, and how they sat last time the view moved.
  let grip: Finger[] = []
  let was: { mx: number; my: number; d: number; a: number } | null = null
  let twistHeld = 0
  let twisting = false
  /** Fingers nobody listens to: too late for the tool, or a third on the map. */
  const ignored = new Set<number>()
  let lostTimer = 0

  const stopArmTimer = () => {
    if (armTimer) clearTimeout(armTimer)
    armTimer = 0
  }

  /** The tool hears about the finger, and everything it has done so far. */
  const startTool = () => {
    const first = press
    if (!first) return
    stopArmTimer()
    const seen = moves
    press = null
    moves = []
    setPhase('tool')
    toolId = first.pointerId
    toolX = first.clientX
    toolY = first.clientY
    toolLandedAt = first.timeStamp
    toolFar = 0
    leaveId = toolId
    stats.toolStarts++
    stats.handedOver += seen.length
    hands.down(first)
    for (const m of seen) {
      toolFar = Math.max(toolFar, Math.hypot(m.clientX - toolX, m.clientY - toolY))
      hands.move(m)
    }
  }

  /** Two fingers are on the map now. */
  const gripMap = (a: Finger, b: Finger) => {
    grip = [a, b]
    was = null
    twistHeld = 0
    twisting = false
    setPhase('map')
    stats.mapGestures++
    // Measured from here, so the very first move of either finger counts.
    followFingers()
  }

  /** The view follows the two fingers. Called with every finger move, so the steps add up exactly to where the fingers went. */
  const followFingers = () => {
    if (grip.length < 2) return
    const [a, b] = grip
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    if (was) {
      // Zoom about where the middle was, then move it to where it is: whatever was between the fingers stays between them.
      if (d > 1 && was.d > 1 && d !== was.d) hands.zoom(was.mx, was.my, was.d / d)
      if (mx !== was.mx || my !== was.my) hands.slide(mx - was.mx, my - was.my)
      let turn = ang - was.a
      if (turn > Math.PI) turn -= Math.PI * 2
      else if (turn < -Math.PI) turn += Math.PI * 2
      if (!twisting) {
        twistHeld += turn
        if (Math.abs(twistHeld) >= (TWIST_START_DEG * Math.PI) / 180) {
          twisting = true
          turn = 0
        }
      }
      if (twisting && turn) hands.twist(turn)
    }
    was = { mx, my, d, a: ang }
  }

  /** Everything still held is gone: a press with the tool is taken back, nothing else needs saying. */
  const letGoOfEverything = () => {
    stopArmTimer()
    press = null
    moves = []
    if (phase === 'tool') {
      stats.takeBacks++
      hands.takeBack()
    }
    grip = []
    was = null
    ignored.clear()
    setPhase('idle')
  }

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      hands.down(e)
      return
    }
    // The first finger since all were lifted: anything still held here is a lift that never arrived.
    if (e.isPrimary && (phase !== 'idle' || ignored.size)) letGoOfEverything()
    if (lostTimer) clearTimeout(lostTimer)
    lostTimer = 0
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // The finger has already gone: its pointerup or pointercancel says so next.
    }
    if (phase === 'idle') {
      setPhase('armed')
      press = e
      moves = []
      fingerX = e.clientX
      fingerY = e.clientY
      armTimer = window.setTimeout(startTool, ARM_MS)
    } else if (phase === 'armed' && press) {
      // Two fingers before the tool heard about either: the map's. The tool never knows.
      stats.secondFingerMs = e.timeStamp - press.timeStamp
      const first = press.pointerId
      stopArmTimer()
      press = null
      moves = []
      gripMap({ id: first, x: fingerX, y: fingerY }, { id: e.pointerId, x: e.clientX, y: e.clientY })
    } else if (phase === 'tool') {
      stats.secondFingerMs = e.timeStamp - toolLandedAt
      if (toolFar <= TAKE_BACK_PX || hands.justPanning()) {
        stats.takeBacks++
        hands.takeBack()
        gripMap({ id: toolId, x: fingerX, y: fingerY }, { id: e.pointerId, x: e.clientX, y: e.clientY })
      } else {
        stats.ignored++
        ignored.add(e.pointerId)
      }
    } else if (grip.length === 1) {
      // One finger left over from a pinch, and a new one beside it: grip the map again.
      gripMap(grip[0], { id: e.pointerId, x: e.clientX, y: e.clientY })
    } else {
      stats.ignored++
      ignored.add(e.pointerId)
    }
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      hands.move(e)
      return
    }
    if (ignored.has(e.pointerId)) return
    if (phase === 'armed' && press && e.pointerId === press.pointerId) {
      moves.push(e)
      fingerX = e.clientX
      fingerY = e.clientY
      if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) >= ARM_PX) startTool()
    } else if (phase === 'tool' && e.pointerId === toolId) {
      toolFar = Math.max(toolFar, Math.hypot(e.clientX - toolX, e.clientY - toolY))
      fingerX = e.clientX
      fingerY = e.clientY
      hands.move(e)
    } else if (phase === 'map') {
      const f = grip.find((g) => g.id === e.pointerId)
      if (!f) return
      f.x = e.clientX
      f.y = e.clientY
      followFingers()
    }
  }

  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      hands.up(e)
      return
    }
    if (ignored.delete(e.pointerId)) return
    if (phase === 'armed' && press && e.pointerId === press.pointerId) {
      // A quick tap: the tool hears the press and the lift together.
      startTool()
      setPhase('idle')
      hands.up(e)
    } else if (phase === 'tool' && e.pointerId === toolId) {
      setPhase('idle')
      hands.up(e)
    } else if (phase === 'map') {
      fingerOffMap(e.pointerId)
    }
  }

  const fingerOffMap = (id: number) => {
    grip = grip.filter((g) => g.id !== id)
    was = null
    if (!grip.length) setPhase('idle')
  }

  const onCancel = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      hands.up(e)
      return
    }
    if (ignored.delete(e.pointerId)) return
    if (phase === 'armed' && press && e.pointerId === press.pointerId) {
      stopArmTimer()
      press = null
      moves = []
      setPhase('idle')
    } else if (phase === 'tool' && e.pointerId === toolId) {
      stats.takeBacks++
      hands.takeBack()
      setPhase('idle')
    } else if (phase === 'map') {
      fingerOffMap(e.pointerId)
    }
  }

  const onLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || e.pointerId === leaveId) hands.leave(e)
  }

  // Lifts that never arrive: the last finger on the page has gone, and a moment later we still think one is down.
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length || lostTimer) return
    lostTimer = window.setTimeout(() => {
      lostTimer = 0
      if (phase !== 'idle' || ignored.size) letGoOfEverything()
    }, LOST_FINGER_MS)
  }
  const onHidden = () => {
    if (document.hidden) letGoOfEverything()
  }
  // Safari's own pinch of the page: `touch-action: none` stops it on the map, but a pinch that lands on a panel makes the
  // whole page bulge and spring back. Only where there are fingers: a Mac's trackpad sends this too.
  const onPagePinch = (e: Event) => {
    if (navigator.maxTouchPoints > 0) e.preventDefault()
  }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onCancel)
  el.addEventListener('pointerleave', onLeave)
  window.addEventListener('touchend', onTouchEnd, { passive: true })
  window.addEventListener('touchcancel', onTouchEnd, { passive: true })
  window.addEventListener('blur', letGoOfEverything)
  document.addEventListener('visibilitychange', onHidden)
  document.addEventListener('gesturestart', onPagePinch, { passive: false })
  return () => {
    stopArmTimer()
    if (lostTimer) clearTimeout(lostTimer)
    setPhase('idle')
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onCancel)
    el.removeEventListener('pointerleave', onLeave)
    window.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('touchcancel', onTouchEnd)
    window.removeEventListener('blur', letGoOfEverything)
    document.removeEventListener('visibilitychange', onHidden)
    document.removeEventListener('gesturestart', onPagePinch)
  }
}
