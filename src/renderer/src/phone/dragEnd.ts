export type DragEnd = 'release' | 'cancel'

/**
 * Calls `onEnd` exactly once for the drag of `pointerId` on `element`: `release` when that finger
 * lets go, `cancel` when its touch is cancelled, the element loses its capture, the app leaves the
 * screen, or the returned stop is called. Other fingers are ignored.
 */
export function watchDragEnd(
  element: Element,
  pointerId: number,
  onEnd: (how: DragEnd, event: PointerEvent | null) => void,
): () => void {
  let done = false
  const finish = (how: DragEnd, event: PointerEvent | null) => {
    if (done) return
    done = true
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
    element.removeEventListener('lostpointercapture', lost)
    document.removeEventListener('visibilitychange', hidden)
    window.removeEventListener('blur', away)
    onEnd(how, event)
  }
  // On the window, so an up that WebKit sends elsewhere still ends the drag.
  const up = (event: PointerEvent) => {
    if (event.pointerId === pointerId) finish('release', event)
  }
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) finish('cancel', event)
  }
  // Touch captures the pressed child implicitly; only the element's own capture counts.
  const lost = (event: Event) => {
    const e = event as PointerEvent
    if (e.target === element && e.pointerId === pointerId) finish('cancel', e)
  }
  // A touch the system takes (an app switch, a call) may never send an up or a cancel.
  const hidden = () => {
    if (document.visibilityState === 'hidden') finish('cancel', null)
  }
  const away = () => finish('cancel', null)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', cancel, true)
  element.addEventListener('lostpointercapture', lost)
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('blur', away)
  return () => finish('cancel', null)
}
