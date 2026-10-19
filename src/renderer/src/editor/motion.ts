// How the editor's pop-ups appear and go, for its CodeMirror themes (they
// live in the editor's shadow root, so the app stylesheet's keyframes do not
// reach them). Durations, curves and the scales are design tokens; Reduce
// Motion sets `--popover-enter-scale` and `--popover-exit-scale` to 1
// (app.css), so a pop-up then only fades.
import { ViewPlugin } from '@codemirror/view'
import { dropClosingCopies, leaveClosingCopy, tooltipMotion } from '../closing'

/** Keyframes to spread into a theme that uses `popoverIn` or `fadeIn`, and the closing ones. */
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

/** Grows out of its notch or anchor (set `transformOrigin` there) as it fades in. */
export const popoverIn =
  'cm-popover-in var(--motion-duration-popover) var(--motion-easing-standard)'

/**
 * Only fades. For CodeMirror tooltips, which CodeMirror places from their
 * measured box: one that grew in would be measured, and placed, too small.
 */
export const fadeIn = 'cm-fade-in var(--motion-duration-fade) var(--motion-easing-standard)'

/** A button over the text (a code block's copy button) grows a little as it fades in. */
export const buttonIn = 'cm-popover-in var(--motion-duration-toggle) var(--motion-easing-standard)'

/** A button tooltip only fades, as the app's other tooltips (`.tool-tip`). */
export const tipIn = 'cm-fade-in var(--motion-duration-popover) var(--motion-easing-standard)'

/** Shrinks back toward its notch or anchor as it fades out (closing.ts keeps a copy for it). */
export const popoverOut =
  'cm-popover-out var(--motion-duration-popover) var(--motion-easing-standard) forwards'

/** A button tooltip only fades out. */
const tipOut = 'cm-fade-out var(--motion-duration-popover) var(--motion-easing-standard) forwards'

/** Only fades out: the floating bars and the completion lists. */
export const fadeOut =
  'cm-fade-out var(--motion-duration-fade) var(--motion-easing-standard) forwards'

/**
 * The closing copies' styles, for a theme: a CodeMirror tooltip fades out, a
 * bar button's tooltip shrinks toward its notch.
 */
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

/** Which closing copies a tooltip replaces when it opens: a bar's, or a completion list's. */
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
