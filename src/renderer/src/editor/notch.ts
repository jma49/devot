// The notch of a floating bar: a small box behind the bar holding two clipped
// layers, the glass edge as a band along the slanted sides and the material as
// a triangle shifted EDGE pixels in, so the edge shows as a thin outline. The
// box sits at the bar's edge, outside its rectangle; the material reaches
// under the bar, so no pixel grid leaves a seam along the base. The bar's rim
// edge and shade go around it (`outsideNotch`), and on the top edge the rim's
// highlight stops either side of it (`highlightBesideNotch`). It is never
// turned: a transform would misalign the window-aligned gradient in its fill.
import { sizes } from '../theme/tokens'

export const NOTCH_WIDTH = Number.parseFloat(sizes['size.float-notch-width'])
export const NOTCH_HEIGHT = Number.parseFloat(sizes['size.float-notch-height'])
export const EDGE = 0.5

export const BAR_RADIUS = Number.parseFloat(sizes['radius.floating-bar'])
export const GLASS_BAR_RADIUS = Number.parseFloat(sizes['radius.glass-floating-bar'])
/**
 * How far the notch's tip is from the bar's left edge at rest, and the least it
 * is from either end: the notch's base (half its width each side of the tip)
 * stays on the straight part of the edge, clear of the rounded corners of
 * either interface's bar.
 */
export const NOTCH_X = Math.max(BAR_RADIUS, GLASS_BAR_RADIUS) + NOTCH_WIDTH / 2
export const BAR_GAP = NOTCH_HEIGHT

export const notchLeft = (tip: string, width: number) => `calc(${tip} - ${width / 2}px)`

export const BAR_NOTCH_TIP = `var(--float-notch-x, ${NOTCH_X}px)`
const tip = BAR_NOTCH_TIP
const half = NOTCH_WIDTH / 2
// Where the fill triangle's sides cross the edge triangle's base: the edge is clipped to the
// outline between the two, so the translucent material never shows the edge colour through it.
const inset = `${(half / NOTCH_HEIGHT) * EDGE}px`
const edge = 'var(--color-line-glass-edge)'
const tint = 'var(--glass-tint)'
// The bar's sheen is longer than the bar is tall; every bar is `size.float-toolbar-height` tall.
const sheenPastBar = `var(--glass-sheen) 0 calc(${EDGE}px - var(--size-float-toolbar-height)) / 100% var(--size-glass-sheen) no-repeat`

/** The edge band's outline, pointing down (the surface above its anchor) and up. */
export const NOTCH_EDGE_CLIP = {
  down: `polygon(0 0, ${inset} 0, 50% calc(100% - ${EDGE}px), calc(100% - ${inset}) 0, 100% 0, 50% 100%)`,
  up: `polygon(0 100%, ${inset} 100%, 50% ${EDGE}px, calc(100% - ${inset}) 100%, 100% 100%, 50% 0)`,
}

/**
 * The material's triangle on a surface with no clipping box: shifted EDGE
 * pixels in like the bar's, and cut where it meets the surface's edge so the
 * two translucent fills never overlap.
 */
export const NOTCH_FILL_CLIP = {
  down: `polygon(${inset} ${EDGE}px, calc(100% - ${inset}) ${EDGE}px, 50% 100%)`,
  up: `polygon(${inset} calc(100% - ${EDGE}px), calc(100% - ${inset}) calc(100% - ${EDGE}px), 50% 0)`,
}

// How far the hole for the notch reaches into the bar: a hole whose base lay on the bar's edge
// would leave a sliver of shade under the notch's base wherever the edge falls between device pixels.
const HOLE_OVERLAP = 1

/**
 * The clip of the layer behind a bar that casts its rim edge and shade: all
 * within `reach` of the bar but the notch with its tip `at`, whose translucent
 * material would show them through.
 */
export function outsideNotch(at: string, reach: string): { down: string; up: string } {
  const near = `calc(-1 * ${reach})`
  const far = `calc(100% + ${reach})`
  const around = `${near} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far}, ${near} ${near}`
  const reachIn = half + (half / NOTCH_HEIGHT) * HOLE_OVERLAP
  const left = `calc(${at} - ${reachIn}px)`
  const right = `calc(${at} + ${reachIn}px)`
  const bottom = `calc(100% - ${HOLE_OVERLAP}px)`
  const top = `${HOLE_OVERLAP}px`
  return {
    down: `polygon(evenodd, ${around}, ${left} ${bottom}, ${at} calc(100% + ${NOTCH_HEIGHT}px), ${right} ${bottom}, ${left} ${bottom})`,
    up: `polygon(evenodd, ${around}, ${left} ${top}, ${at} -${NOTCH_HEIGHT}px, ${right} ${top}, ${left} ${top})`,
  }
}

const highlight = 'var(--glass-highlight)'

/**
 * The rim's top highlight as two strips either side of a notch on the top
 * edge, `x` its tip from the left: an inset box shadow would run across the
 * notch's base. The surface then rims itself with `--glass-rim-edge` only.
 */
export const highlightBesideNotch = (x: string, width: string) =>
  [
    `${highlight} left top / max(0px, ${x} - ${width} / 2) 1px no-repeat`,
    `${highlight} right top / max(0px, 100% - ${x} - ${width} / 2) 1px no-repeat`,
  ].join(', ')

export const notchStyles = {
  '.cm-float-notch': {
    position: 'absolute',
    zIndex: '-1',
    boxSizing: 'border-box',
    width: `${NOTCH_WIDTH}px`,
    height: `${NOTCH_HEIGHT}px`,
    left: notchLeft(tip, NOTCH_WIDTH),
    pointerEvents: 'none',
  },
  '.cm-tooltip-above > .cm-float-notch': { top: '100%' },
  '.cm-tooltip-below > .cm-float-notch': { bottom: '100%' },
  '.cm-float-notch::before, .cm-float-notch::after': {
    content: '""',
    position: 'absolute',
    left: '0',
    width: '100%',
    height: '100%',
  },
  // Pointing down (the bar is above its anchor): the edge band, then the material EDGE up.
  '.cm-tooltip-above > .cm-float-notch::before': {
    top: '0',
    background: edge,
    clipPath: NOTCH_EDGE_CLIP.down,
  },
  '.cm-tooltip-above > .cm-float-notch::after': {
    top: `-${EDGE}px`,
    background: `${sheenPastBar}, ${tint}`,
    clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
  },
  // Pointing up, the notch meets the bar's top edge, where the sheen is at its strongest.
  '.cm-tooltip-below > .cm-float-notch::before': {
    bottom: '0',
    background: edge,
    clipPath: NOTCH_EDGE_CLIP.up,
  },
  '.cm-tooltip-below > .cm-float-notch::after': {
    bottom: `-${EDGE}px`,
    background: `var(--glass-sheen-top), ${tint}`,
    clipPath: 'polygon(0 100%, 100% 100%, 50% 0)',
  },
} satisfies Record<string, Record<string, string>>

export function notchElement(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-float-notch'
  el.setAttribute('aria-hidden', 'true')
  return el
}
