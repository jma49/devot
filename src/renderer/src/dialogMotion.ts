// Modal dialogs close with motion (design/README.md, "Motion"): the dialog
// blurs and fades over `motion.duration.dialog` while the page's dim fades
// over `motion.duration.backdrop-exit`. A dialog goes at once, closed or taken
// off the page, so focus, keys and the accessibility tree move on; an inert
// copy that assistive tech does not see plays the motion where it was, as
// closing pop-ups do (closing.ts). Reduce Motion closes them at once. A
// dialog that opens again while its copy fades takes over from the copy and
// from the dim.
import {
  animationMs,
  enterFrom,
  rememberScrolls,
  restoreScroll,
  scrollOffsets,
  whenClosed,
} from './closing'
import { motionReduced } from './motionPreference'

const DIALOG_KINDS = ['dialog.confirm', 'dialog.sheet', 'dialog.link-dialog', 'dialog.palette']
/** The dialogs that open with motion (app.css), so close with it too. */
export const MOVING_DIALOGS = DIALOG_KINDS.join(', ')
const DIMMING = '.confirm, .sheet, .link-dialog'

const FALLBACK_SLACK_MS = 100

export interface DialogRecord {
  type: string
  target: unknown
  oldValue: string | null
  removed: readonly unknown[]
  added?: readonly unknown[]
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

/** The dialogs among `records` that were closed or away and are now open. */
export function openedDialogs<T>(
  records: readonly DialogRecord[],
  isDialog: (node: unknown) => node is T,
  dialogsIn: (node: unknown) => readonly T[],
  isOpen: (dialog: T) => boolean,
): T[] {
  const opened = new Set<T>()
  for (const record of records) {
    if (record.type === 'attributes' && record.oldValue === null && isDialog(record.target))
      opened.add(record.target)
    for (const node of record.added ?? []) for (const dialog of dialogsIn(node)) opened.add(dialog)
  }
  return [...opened].filter(isOpen)
}

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

function removeWhenDone(el: HTMLElement): void {
  const style = getComputedStyle(el)
  const ms = animationMs(style.animationDuration, style.animationDelay)
  if (ms <= 0 || style.animationName === 'none') return el.remove()
  whenClosed(el, () => el.remove(), ms + FALLBACK_SLACK_MS)
}

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
  const offsets = scrollOffsets(dialog)
  const copy = dialog.cloneNode(true) as HTMLDialogElement
  for (const node of [copy, ...Array.from(copy.querySelectorAll('[id]'))])
    node.removeAttribute('id')
  copy.setAttribute('open', '')
  copy.dataset['closing'] = 'dialog'
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  parent.append(copy)
  restoreScroll(copy, offsets)
  removeWhenDone(copy)
}

/** Drops what a takeover set on `dialog`, which closed, so its next opening starts afresh. */
function releaseTakeover(dialog: HTMLDialogElement): void {
  delete dialog.dataset['backdropFrom']
  dialog.style.removeProperty('--backdrop-from')
  dialog.style.removeProperty('animation-delay')
}

/**
 * Hands the fading copy of `dialog`'s kind and the fading dim over to
 * `dialog`, which opened while they faded: it starts at their opacity
 * (its `::backdrop` by `--backdrop-from`, app.css) rather than from nothing.
 */
function takeOverDialogCopy(dialog: HTMLDialogElement): void {
  if (dialog.matches(DIMMING)) {
    const dims = Array.from(
      document.body.querySelectorAll<HTMLElement>(':scope > .dialog-backdrop[data-closing]'),
    )
    const dim = dims.at(-1)
    if (dim) {
      dialog.style.setProperty('--backdrop-from', getComputedStyle(dim).opacity)
      dialog.dataset['backdropFrom'] = ''
    }
    for (const d of dims) d.remove()
  }
  const kind = DIALOG_KINDS.find((k) => dialog.matches(k))
  const copies = Array.from(
    document.body.querySelectorAll<HTMLElement>(':scope > dialog[data-closing="dialog"]'),
  ).filter((copy) => kind !== undefined && copy.matches(kind))
  const latest = copies.pop()
  for (const copy of copies) copy.remove()
  if (latest) enterFrom(dialog, latest)
}

export function watchDialogExits(root: Node = document.body): () => void {
  const forgetScrolls = rememberScrolls(root)
  const observer = new MutationObserver((mutations) => {
    const records = mutations.map((m) => ({
      type: m.type,
      target: m.target,
      oldValue: m.oldValue,
      removed: Array.from(m.removedNodes),
      added: Array.from(m.addedNodes),
    }))
    const closed = closedDialogs(
      records,
      isMovingDialog,
      openDialogsIn,
      (dialog) => dialog.isConnected && dialog.open,
    )
    for (const dialog of closed) {
      releaseTakeover(dialog)
      if (!motionReduced()) leaveDialogCopy(dialog)
    }
    const opened = openedDialogs(
      records,
      isMovingDialog,
      openDialogsIn,
      (dialog) => dialog.isConnected && dialog.open,
    )
    for (const dialog of opened) takeOverDialogCopy(dialog)
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
    attributeOldValue: true,
  })
  return () => {
    observer.disconnect()
    forgetScrolls()
  }
}
