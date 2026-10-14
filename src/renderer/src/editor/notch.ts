// The notch of a floating bar: a small clipped box behind the bar holding two
// zero-size border triangles, the edge colour and the fill colour shifted one
// pixel, so the edge shows as a one pixel outline along the slanted sides.
// The box sits at the bar's edge, outside its rectangle; a fill strip over the
// bar's outline at the notch base closes the seam where the two meet.
import { sizes } from '../theme/tokens'

/** The notch's width and height in pixels (the `--size-float-notch-*` tokens). */
export const NOTCH_WIDTH = Number.parseFloat(sizes['size.float-notch-width'])
export const NOTCH_HEIGHT = Number.parseFloat(sizes['size.float-notch-height'])
/** The outline's width, in pixels. */
export const EDGE = 1

/**
 * How far the notch's tip is from the bar's left edge at rest: the bar starts
 * one notch width left of the anchor, and the notch box one half width in.
 */
export const NOTCH_X = NOTCH_WIDTH
/** The gap between a bar and the line it belongs to: the notch's height. */
export const BAR_GAP = NOTCH_HEIGHT

/** Where the notch box and the seam strip start: the tip's x less half their width. */
export const notchLeft = (tip: string, width: number) => `calc(${tip} - ${width / 2}px)`

const tip = `var(--float-notch-x, ${NOTCH_X}px)`
const half = NOTCH_WIDTH / 2
const edge = 'var(--color-line-hairline)'
const fill = 'var(--color-surface-popover)'

/** The bar's outline colour and fill, and the notch and strip rules, as theme styles. */
export const notchStyles = {
  '.cm-float-notch': {
    position: 'absolute',
    zIndex: '-1',
    boxSizing: 'border-box',
    overflow: 'hidden',
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
    width: '0',
    height: '0',
    borderLeft: `${half}px solid transparent`,
    borderRight: `${half}px solid transparent`,
  },
  // Pointing down (the bar is above its anchor): the edge triangle, then the fill one pixel up.
  '.cm-tooltip-above > .cm-float-notch::before': {
    top: '0',
    borderTop: `${NOTCH_HEIGHT}px solid ${edge}`,
  },
  '.cm-tooltip-above > .cm-float-notch::after': {
    top: `-${EDGE}px`,
    borderTop: `${NOTCH_HEIGHT}px solid ${fill}`,
  },
  // Pointing up (the bar is below its anchor).
  '.cm-tooltip-below > .cm-float-notch::before': {
    bottom: '0',
    borderBottom: `${NOTCH_HEIGHT}px solid ${edge}`,
  },
  '.cm-tooltip-below > .cm-float-notch::after': {
    bottom: `-${EDGE}px`,
    borderBottom: `${NOTCH_HEIGHT}px solid ${fill}`,
  },
  // The seam: a strip of the fill over the bar's outline at the notch base,
  // a pixel short of the slanted edges at each end.
  '.cm-tooltip.cm-float-bar::after': {
    content: '""',
    position: 'absolute',
    zIndex: '1',
    left: notchLeft(tip, NOTCH_WIDTH - 2 * EDGE),
    width: `${NOTCH_WIDTH - 2 * EDGE}px`,
    height: `${EDGE}px`,
    backgroundColor: fill,
    pointerEvents: 'none',
  },
  '.cm-tooltip-above.cm-float-bar::after': { bottom: `-${EDGE}px` },
  '.cm-tooltip-below.cm-float-bar::after': { top: `-${EDGE}px` },
} satisfies Record<string, Record<string, string>>

/** The notch element, to append to a bar beside its content. */
export function notchElement(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-float-notch'
  el.setAttribute('aria-hidden', 'true')
  return el
}
