// How the editor's pop-ups appear and go, for its CodeMirror themes (they
// live in the editor's shadow root, so the app stylesheet's keyframes do not
// reach them). Durations, curves and the scales are design tokens; Reduce
// Motion sets `--popover-enter-scale` and `--popover-exit-scale` to 1
// (app.css), so a pop-up then only fades.
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { leaveClosingCopy, rememberScrolls, takeOverClosingCopy, tooltipMotion } from '../closing'

export const motionKeyframes = {
  '@keyframes cm-popover-in': {
    from: { opacity: '0', scale: 'var(--popover-enter-scale)' },
  },
  '@keyframes cm-fade-in': { from: { opacity: '0' } },
  '@keyframes cm-popover-out': {
    to: { opacity: '0', scale: 'var(--popover-exit-scale)' },
  },
  '@keyframes cm-fade-out': { to: { opacity: '0' } },
}

export const popoverIn = 'cm-popover-in var(--motion-duration-popover) var(--motion-easing-move)'

/**
 * Only fades. For CodeMirror tooltips, which CodeMirror places from their
 * measured box: one that grew in would be measured, and placed, too small.
 */
export const fadeIn = 'cm-fade-in var(--motion-duration-fade) var(--motion-easing-standard)'

export const buttonIn = 'cm-popover-in var(--motion-duration-toggle) var(--motion-easing-move)'

export const tipIn = 'cm-fade-in var(--motion-duration-popover) var(--motion-easing-standard)'

export const popoverOut =
  'cm-popover-out var(--motion-duration-popover) var(--motion-easing-standard) forwards'

const tipOut = 'cm-fade-out var(--motion-duration-popover) var(--motion-easing-standard) forwards'

export const fadeOut =
  'cm-fade-out var(--motion-duration-fade) var(--motion-easing-standard) forwards'

export const closingStyles = {
  '.cm-tooltip[data-closing][data-closing-motion="fade"]': {
    pointerEvents: 'none',
    animation: fadeOut,
  },
  '.cm-float-tip[data-closing][data-closing-motion="fade"]': {
    pointerEvents: 'none',
    animation: tipOut,
  },
}

const tooltipKind = (el: HTMLElement) =>
  el.classList.contains('cm-float-bar') ? 'cm-float-bar' : 'cm-tooltip-autocomplete'

/**
 * The element CodeMirror puts tooltips in when they have a `parent` (a
 * `tooltips()` option): a box with only the theme's classes, beside an
 * element around the editor.
 */
function tooltipContainer(view: EditorView): HTMLElement | null {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    for (const child of Array.from(el.children)) {
      if (
        child !== view.dom &&
        child instanceof HTMLElement &&
        child.className === view.themeClasses
      )
        return child
    }
  }
  return null
}

/**
 * Leaves a fading copy of a floating bar or completion list when CodeMirror
 * takes it out (it removes a tooltip's element at once), and hands over from
 * it when one of its kind opens again. Watches the elements tooltips are
 * added to: the editor's own, and the box they go in when given a parent.
 */
export const closingTooltips = ViewPlugin.define((view) => {
  const forgets: (() => void)[] = []
  const watched = new Set<Node>()
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) {
        if (!(node instanceof HTMLElement) || node.isConnected) continue
        const motion = tooltipMotion(node.classList)
        if (motion)
          leaveClosingCopy(node, motion, tooltipKind(node), {
            parent: record.target,
            before: record.nextSibling,
          })
      }
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement) || node.dataset['closing'] !== undefined) continue
        if (tooltipMotion(node.classList))
          takeOverClosingCopy(node, node.parentElement, tooltipKind(node))
      }
    }
  })
  const watchIn = (container: HTMLElement) => {
    if (watched.has(container)) return
    watched.add(container)
    watch.observe(container, { childList: true })
    // Offsets read after CodeMirror detaches a list are 0, so they are noted as it scrolls.
    forgets.push(rememberScrolls(container))
  }
  const findContainer = () => {
    const container = tooltipContainer(view)
    if (container) watchIn(container)
    return container !== null
  }
  watchIn(view.dom)
  let found = findContainer()
  return {
    update: () => {
      if (!found) found = findContainer()
    },
    destroy: () => {
      watch.disconnect()
      for (const forget of forgets) forget()
    },
  }
})
