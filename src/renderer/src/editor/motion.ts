// How the editor's pop-ups appear and go, for its CodeMirror themes (they
// live in the editor's shadow root, so the app stylesheet's keyframes do not
// reach them). Durations, curves and the scales are design tokens; Reduce
// Motion sets `--popover-enter-scale` and `--popover-exit-scale` to 1
// (app.css), so a pop-up then only fades.
import { ViewPlugin } from '@codemirror/view'
import { dropClosingCopies, leaveClosingCopy, tooltipMotion } from '../closing'

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
 * Leaves a fading copy of a floating bar or completion list when CodeMirror
 * takes it out (it removes a tooltip's element at once), and drops it when
 * one of its kind opens again. Watches the element tooltips are added to,
 * the editor's own.
 */
export const closingTooltips = ViewPlugin.define((view) => {
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
        if (tooltipMotion(node.classList)) dropClosingCopies(view.dom, tooltipKind(node))
      }
    }
  })
  watch.observe(view.dom, { childList: true })
  return { destroy: () => watch.disconnect() }
})
