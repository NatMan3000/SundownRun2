// ============================================================
//  TRAY GUARD - a tap on the map closes the tray and does nothing else
// ------------------------------------------------------------
//  While the tool tray is open, a tap on the map only closes it: it
//  must not place a piece or draw a dot with whatever tool is in your
//  hand. But two fingers are always the map (spec/phone-editor/plan.md),
//  so a pinch that starts with the tray open still has to work.
//
//  So the first finger is held back from the map's handlers (they sit on
//  the canvas: this listens above them, first). If a second finger lands
//  while it is down, the first is handed over and the second follows, and
//  the gesture layer sees an ordinary pinch. If the first lifts alone, the
//  map never knew. It stays on after the tray has closed until that finger
//  has gone. A press on any other button folds the tray and does its job.
// ============================================================

/** Guards the map until the function it returns is called and any held finger has gone. */
export function guardMapWhileTrayOpen(onDismiss: () => void): () => void {
  const map = document.querySelector<HTMLElement>('.sre-overlay')
  const root = map?.parentElement
  if (!map || !root) return () => {}

  let trayOpen = true
  let held: PointerEvent | null = null
  let heldX = 0
  let heldY = 0
  let handingOver = false

  const stop = () => {
    root.removeEventListener('pointerdown', onDown, true)
    root.removeEventListener('pointermove', onHeld, true)
    root.removeEventListener('pointerup', onLift, true)
    root.removeEventListener('pointercancel', onLift, true)
  }

  const onDown = (e: PointerEvent) => {
    if (handingOver) return
    if (e.target !== map) {
      // Any other button: it does its job, and the tray folds (not the tray's own, or the tool button, which toggles it).
      if (trayOpen && !(e.target as Element).closest?.('.phone-tray, .phone-tool')) onDismiss()
      return
    }
    if (!held) {
      held = e
      heldX = e.clientX
      heldY = e.clientY
      e.stopPropagation()
      onDismiss()
      return
    }
    // A second finger: the first goes to the map where it is now, and this one follows it.
    const first = held
    held = null
    handingOver = true
    map.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: first.pointerId,
        pointerType: first.pointerType,
        isPrimary: first.isPrimary,
        clientX: heldX,
        clientY: heldY,
        button: first.button,
        buttons: first.buttons,
      }),
    )
    handingOver = false
    if (!trayOpen) stop()
  }

  const onHeld = (e: PointerEvent) => {
    if (held?.pointerId !== e.pointerId) return
    heldX = e.clientX
    heldY = e.clientY
    e.stopPropagation()
  }

  const onLift = (e: PointerEvent) => {
    if (held?.pointerId !== e.pointerId) return
    held = null
    e.stopPropagation()
    if (!trayOpen) stop()
  }

  root.addEventListener('pointerdown', onDown, true)
  root.addEventListener('pointermove', onHeld, true)
  root.addEventListener('pointerup', onLift, true)
  root.addEventListener('pointercancel', onLift, true)
  return () => {
    trayOpen = false
    if (!held) stop()
  }
}
