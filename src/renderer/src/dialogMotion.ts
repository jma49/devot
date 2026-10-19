// Modal dialogs close with motion (design/README.md, "Motion"): the dialog
// blurs and fades over `motion.duration.dialog` while the page's dim fades
// over `motion.duration.backdrop-exit`. A dialog goes at once, closed or taken
// off the page, so focus, keys and the accessibility tree move on; an inert
// copy that assistive tech does not see plays the motion where it was, as
// closing pop-ups do (closing.ts). Reduce Motion closes them at once.
import { animationMs, whenClosed } from './closing'

/** The dialogs that open with motion (app.css), so close with it too. */
export const MOVING_DIALOGS = 'dialog.confirm, dialog.sheet, dialog.link-dialog, dialog.palette'
/** Those that dim the page behind them. */
const DIMMING = '.confirm, .sheet, .link-dialog'

/** Extra time past the animation's length before a copy goes anyway. */
const FALLBACK_SLACK_MS = 100

/** What a batch of DOM changes did to dialogs: the open ones that closed or left the page. */
export interface DialogRecord {
  type: string
  target: unknown
  oldValue: string | null
  removed: readonly unknown[]
}

/**
 * The dialogs among `records` that were open and are now closed or gone.
 * `isDialog` tells a moving dialog (one of MOVING_DIALOGS, not a copy).
 */
export function closedDialogs<T>(
  records: readonly DialogRecord[],
  isDialog: (node: unknown) => node is T,
  dialogsIn: (node: unknown) => readonly T[],
  stillOpen: (dialog: T) => boolean,
): T[] {
  const closed = new Set<T>()
  for (const record of records) {
    // The `open` attribute went: the dialog closed.
    if (record.type === 'attributes' && record.oldValue !== null && isDialog(record.target))
      closed.add(record.target)
    // A dialog that left the page open (or a page part holding one).
    for (const node of record.removed) for (const dialog of dialogsIn(node)) closed.add(dialog)
  }
  return [...closed].filter((dialog) => !stillOpen(dialog))
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const isMovingDialog = (node: unknown): node is HTMLDialogElement =>
  node instanceof HTMLDialogElement &&
  node.matches(MOVING_DIALOGS) &&
  node.dataset['closing'] === undefined

const openDialogsIn = (node: unknown): HTMLDialogElement[] => {
  if (!(node instanceof Element)) return []
  return [node, ...Array.from(node.querySelectorAll('dialog'))].filter(
    (el): el is HTMLDialogElement => isMovingDialog(el) && el.hasAttribute('open'),
  )
}

/** Leaves `el` on the page until its closing animation ends. */
function removeWhenDone(el: HTMLElement): void {
  const style = getComputedStyle(el)
  const ms = animationMs(style.animationDuration, style.animationDelay)
  if (ms <= 0 || style.animationName === 'none') return el.remove()
  whenClosed(el, () => el.remove(), ms + FALLBACK_SLACK_MS)
}

/** Plays a closed dialog's exit with an inert copy of it (and of its dim). */
function leaveDialogCopy(dialog: HTMLDialogElement): void {
  const parent = document.body
  if (dialog.matches(DIMMING)) {
    const dim = document.createElement('div')
    dim.className = 'dialog-backdrop'
    dim.dataset['closing'] = 'backdrop'
    dim.setAttribute('aria-hidden', 'true')
    parent.append(dim)
    removeWhenDone(dim)
  }
  const copy = dialog.cloneNode(true) as HTMLDialogElement
  for (const node of [copy, ...Array.from(copy.querySelectorAll('[id]'))])
    node.removeAttribute('id')
  copy.setAttribute('open', '')
  copy.dataset['closing'] = 'dialog'
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  parent.append(copy)
  removeWhenDone(copy)
}

/** Watches the page for moving dialogs that close, and plays their exit. Returns a stop. */
export function watchDialogExits(root: Node = document.body): () => void {
  const observer = new MutationObserver((mutations) => {
    if (reducedMotion()) return
    const records = mutations.map((m) => ({
      type: m.type,
      target: m.target,
      oldValue: m.oldValue,
      removed: Array.from(m.removedNodes),
    }))
    const closed = closedDialogs(
      records,
      isMovingDialog,
      openDialogsIn,
      (dialog) => dialog.isConnected && dialog.open,
    )
    for (const dialog of closed) leaveDialogCopy(dialog)
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
    attributeOldValue: true,
  })
  return () => observer.disconnect()
}
