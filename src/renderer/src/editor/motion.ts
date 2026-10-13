// How the editor's pop-ups appear, for its CodeMirror themes (they live in the
// editor's shadow root, so the app stylesheet's keyframes do not reach them).
// Durations, curves and the starting scale are design tokens; Reduce Motion
// sets `--popover-enter-scale` to 1 (app.css), so a pop-up then only fades.

/** Keyframes to spread into a theme that uses `popoverIn` or `fadeIn`. */
export const motionKeyframes = {
  '@keyframes cm-popover-in': {
    from: { opacity: '0', scale: 'var(--popover-enter-scale)' },
  },
  '@keyframes cm-fade-in': { from: { opacity: '0' } },
}

/** Grows out of its notch or anchor (set `transformOrigin` there) as it fades in. */
export const popoverIn =
  'cm-popover-in var(--motion-duration-popover) var(--motion-easing-standard)'

/**
 * Only fades. For CodeMirror tooltips, which CodeMirror places from their
 * measured box: one that grew in would be measured, and placed, too small.
 */
export const fadeIn = 'cm-fade-in var(--motion-duration-fade) var(--motion-easing-standard)'
