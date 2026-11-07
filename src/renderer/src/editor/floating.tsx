// What the editor's floating bars share (the selection toolbar and the
// image size bar): a rounded panel with a notch pointing at the text, round
// icon buttons with an outline ring under the pointer, and a tooltip bubble
// with the button's name and key. CodeMirror styles them with constructed
// sheets (they live in the editor's shadow root); positions go through the
// CSSOM, which the production CSP allows.
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { closingRef } from '../closing'
import { sizes } from '../theme/tokens'
import { closingStyles, closingTooltips, motionKeyframes, tipIn } from './motion'
import {
  BAR_GAP,
  BAR_NOTCH_TIP,
  EDGE,
  NOTCH_EDGE_CLIP,
  NOTCH_FILL_CLIP,
  NOTCH_HEIGHT,
  NOTCH_WIDTH,
  NOTCH_X,
  highlightBesideNotch,
  notchElement,
  notchLeft,
  notchStyles,
} from './notch'
import type { Tip } from './toolbarButtons'

export { BAR_GAP, NOTCH_X }

const SHOW_AFTER_MS = Number.parseFloat(sizes['motion.delay.tooltip'])

const TIP_ROOM = 64
/** Space between a tooltip bubble and the editor's frame when it has to shift. */
const TIP_EDGE = 4
/** The least room between the notch's tip and either end of the bubble, clear of its corner. */
const NOTCH_INSET = 8

/**
 * Where a tooltip bubble's left edge sits, and where its notch is along the
 * bubble. `x` and `room` are in the bar's coordinates. A bubble centred on a
 * button at the frame's edge would hang outside the editor; it shifts in, and
 * the notch stays on the button (kept off the bubble's own corner).
 */
export function placeFloatTip(
  x: number,
  width: number,
  room: { left: number; right: number },
): { left: number; notch: number } {
  const half = width / 2
  const min = room.left + TIP_EDGE + half
  const max = room.right - TIP_EDGE - half
  const centre = max < min ? min : Math.min(Math.max(x, min), max)
  const notch = Math.min(Math.max(x - centre + half, NOTCH_INSET), width - NOTCH_INSET)
  return { left: centre - half, notch }
}

interface ShownTip {
  tip: Tip
  x: number
  below: boolean
  /** Where the bubble fits, in the bar's coordinates. */
  room: { left: number; right: number }
}

function popupSpace(view: EditorView): DOMRect {
  const root = view.dom.getRootNode()
  return (root instanceof ShadowRoot ? root.host : view.dom).getBoundingClientRect()
}

export function useFloatTip(view: EditorView) {
  const [shown, setShown] = useState<ShownTip | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = undefined
    setShown(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = (button: HTMLElement, tip: Tip) => {
    const bar = button.closest('.cm-tooltip')
    if (!bar) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!button.isConnected) return
      const b = button.getBoundingClientRect()
      const box = bar.getBoundingClientRect()
      const frame = popupSpace(view)
      setShown({
        tip,
        x: b.left + b.width / 2 - box.left,
        below: b.top - TIP_ROOM < frame.top,
        room: { left: frame.left - box.left, right: frame.right - box.left },
      })
    }, SHOW_AFTER_MS)
  }
  const bubble = shown ? <FloatTip {...shown} /> : null
  return { show, hide, bubble }
}

const floatTipRef = closingRef('fade', 'cm-float-tip')

function FloatTip({ tip, x, below, room }: ShownTip) {
  const ref = useRef<HTMLDivElement>(null)
  // Both the closing fade (floatTipRef) and the width this measures.
  const setRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el
    return el ? floatTipRef(el) : undefined
  }, [])
  const [left, setLeft] = useState(x)
  const [notch, setNotch] = useState<number | null>(null)
  // Kept inside the editor's frame: a bubble over the first button of a bar at
  // the frame's edge would sit half outside it. Its notch follows its button.
  useLayoutEffect(() => {
    const width = ref.current?.getBoundingClientRect().width ?? 0
    if (!width) return
    const placed = placeFloatTip(x, width, room)
    setLeft(placed.left)
    setNotch(placed.notch)
  }, [x, room])
  return (
    <div
      ref={setRef}
      role="tooltip"
      className="cm-float-tip"
      data-side={below ? 'below' : 'above'}
      style={{
        left: `${left}px`,
        ...(notch === null ? {} : { '--tip-notch': `${notch}px` }),
      }}
    >
      <span className="cm-float-tip-title">{tip.title}</span>
      {tip.key !== undefined && <kbd className="cm-float-kbd">{tip.key}</kbd>}
    </div>
  )
}

export interface FloatButtonProps {
  label: string
  icon: IconName
  tip: Tip
  pressed?: boolean | undefined
  disabled?: boolean | undefined
  popup?: boolean
  onShowTip: (button: HTMLElement, tip: Tip) => void
  onHideTip: () => void
  onPress: (button: HTMLElement) => void
}

export function FloatButton(props: FloatButtonProps) {
  return (
    <button
      type="button"
      className="cm-float-button"
      tabIndex={-1}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      aria-haspopup={props.popup ? 'menu' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={(e) => props.onShowTip(e.currentTarget, props.tip)}
      onMouseLeave={props.onHideTip}
      onClick={(e) => props.onPress(e.currentTarget)}
    >
      <Icon name={props.icon} size="toolbar" weight="thin" />
    </button>
  )
}

export function FloatSeparator(): ReactNode {
  return <span role="separator" aria-orientation="vertical" className="cm-float-separator" />
}

/**
 * One bar element holds the glass material and a box shadow (on the bar only,
 * no filter): the glass rim, then one soft layer; its notch is a separate
 * element behind it (`notch.ts`). A tooltip bubble draws the same notch with
 * its two pseudo-elements, pointing at its button.
 */
const barShade =
  '0 var(--shadow-float-bar-y) var(--shadow-float-bar-blur) var(--color-shadow-float-bar)'
const barShadow = `var(--glass-rim), ${barShade}`
const popoverShadow = 'var(--glass-rim), var(--popover-shadow)'
const tipNotch = 'var(--tip-notch, 50%)'
const notchWidth = `${NOTCH_WIDTH}px`

export function barContent(dom: HTMLElement): HTMLElement {
  const content = document.createElement('div')
  content.className = 'cm-float-content'
  dom.append(content, notchElement())
  return content
}

export const floatStyles: Parameters<typeof EditorView.theme>[0] = {
  ...motionKeyframes,
  ...closingStyles,
  '.cm-tooltip.cm-float-bar': {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    height: 'var(--size-float-toolbar-height)',
    padding: 'var(--space-2) var(--space-3)',
    paddingInline: 'var(--size-float-toolbar-end)',
    border: '0',
    borderRadius: 'var(--radius-floating-bar)',
    background: 'var(--glass-material-bg)',
    backdropFilter: 'var(--glass-backdrop, none)',
    WebkitBackdropFilter: 'var(--glass-backdrop, none)',
    boxShadow: barShadow,
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-family-ui)',
  },
  '.cm-tooltip.cm-tooltip-below.cm-float-bar': {
    background: `${highlightBesideNotch(BAR_NOTCH_TIP, notchWidth)}, var(--glass-material-bg)`,
    boxShadow: `var(--glass-rim-edge), ${barShade}`,
  },
  '.cm-float-content': { display: 'flex', alignItems: 'center', minWidth: '0' },
  ...notchStyles,
  '.cm-float-buttons': {
    display: 'flex',
    alignItems: 'center',
    minWidth: '0',
  },
  '.cm-float-button': {
    display: 'flex',
    flexShrink: '0',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'var(--size-float-button)',
    height: 'var(--size-float-button)',
    padding: '0',
    border: '1px solid transparent',
    borderRadius: 'var(--radius-capsule)',
    backgroundColor: 'transparent',
    color: 'var(--color-text-secondary)',
    // The colour and the ring ease; the fill snaps.
    transition: [
      'color var(--motion-duration-color) var(--motion-easing-standard)',
      'border-color var(--motion-duration-ring) var(--motion-easing-out)',
    ].join(', '),
  },
  // Under the pointer and pressed (a format that applies) look the same: a ring over a fill.
  '.cm-float-button:hover:not(:disabled)': {
    borderColor: 'var(--color-line-control)',
    backgroundColor: 'var(--color-fill-tool-hover)',
  },
  '.cm-float-button:disabled': { opacity: 'var(--opacity-disabled)' },
  '.cm-float-button[aria-pressed="true"]': {
    borderColor: 'var(--color-line-control)',
    backgroundColor: 'var(--color-fill-tool-hover)',
    color: 'var(--color-accent-text)',
  },
  // Zero width, a left border only.
  '.cm-float-separator': {
    alignSelf: 'center',
    flexShrink: '0',
    display: 'block',
    width: '0',
    height: 'var(--size-float-separator-height)',
    margin: '0 var(--space-3)',
    borderLeft: '1px solid var(--color-line-separator)',
  },
  '.cm-float-label': {
    flexShrink: '0',
    padding: '0 var(--space-4) 0 var(--space-3)',
    fontSize: 'var(--font-size-body)',
    color: 'var(--color-text-tertiary)',
    whiteSpace: 'nowrap',
  },
  // The app's icon rules, sizes among them, do not reach into the editor's shadow root.
  '.cm-float-button .icon': {
    display: 'block',
    flexShrink: '0',
    width: 'var(--size-icon-toolbar)',
    height: 'var(--size-icon-toolbar)',
    backgroundColor: 'currentColor',
  },
  '.cm-float-button .icon-svg': { display: 'block', flexShrink: '0' },
  '.cm-float-tip': {
    position: 'absolute',
    zIndex: '1',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-3) var(--space-5)',
    borderRadius: 'var(--radius-glass-tooltip)',
    background: 'var(--glass-material-bg)',
    backdropFilter: 'var(--glass-backdrop, none)',
    WebkitBackdropFilter: 'var(--glass-backdrop, none)',
    boxShadow: popoverShadow,
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-footnote)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    animation: tipIn,
  },
  '.cm-float-tip[data-side="below"]': {
    top: 'calc(100% + var(--tooltip-gap))',
    background: `${highlightBesideNotch(tipNotch, notchWidth)}, var(--glass-material-bg)`,
    boxShadow: 'var(--glass-rim-edge), var(--popover-shadow)',
  },
  '.cm-float-tip[data-side="above"]': {
    bottom: 'calc(100% + var(--tooltip-gap))',
  },
  '.cm-float-tip::before, .cm-float-tip::after': {
    content: '""',
    position: 'absolute',
    // The bubble may shift to stay in the frame; the notch stays on its button.
    left: notchLeft(tipNotch, NOTCH_WIDTH),
    width: notchWidth,
    height: `${NOTCH_HEIGHT}px`,
    pointerEvents: 'none',
  },
  '.cm-float-tip[data-side="above"]::before': {
    top: '100%',
    background: 'var(--color-line-glass-edge)',
    clipPath: NOTCH_EDGE_CLIP.down,
  },
  '.cm-float-tip[data-side="above"]::after': {
    top: `calc(100% - ${EDGE}px)`,
    background: 'var(--glass-tint)',
    clipPath: NOTCH_FILL_CLIP.down,
  },
  // Below its button the notch meets the bubble's top edge, where the sheen is at its strongest.
  '.cm-float-tip[data-side="below"]::before': {
    bottom: '100%',
    background: 'var(--color-line-glass-edge)',
    clipPath: NOTCH_EDGE_CLIP.up,
  },
  '.cm-float-tip[data-side="below"]::after': {
    bottom: `calc(100% - ${EDGE}px)`,
    background: 'var(--glass-sheen-top), var(--glass-tint)',
    clipPath: NOTCH_FILL_CLIP.up,
  },
  // The app's tooltip keycap (app.css, .tool-tip).
  '.cm-float-kbd': {
    padding: '0 var(--space-3)',
    borderRadius: 'var(--radius-button)',
    backgroundColor: 'var(--color-fill-settings-card)',
    boxShadow: 'inset 0 0 0 0.5px var(--color-line-hairline)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    color: 'var(--color-text-secondary)',
  },
}

export const floatTheme = [EditorView.theme(floatStyles), closingTooltips]
