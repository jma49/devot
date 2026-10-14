// What the editor's floating bars share (the selection toolbar and the
// image size bar): a rounded panel with a notch pointing at the text, round
// icon buttons with an outline ring under the pointer, and a tooltip bubble
// with the button's name and key. CodeMirror styles them with constructed
// sheets (they live in the editor's shadow root); positions go through the
// CSSOM, which the production CSP allows.
import { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { closingRef } from '../closing'
import { sizes } from '../theme/tokens'
import { closingStyles, closingTooltips, fadeIn, motionKeyframes, tipIn } from './motion'
import type { Tip } from './toolbarButtons'

/**
 * How far the bar sits from its anchor's left edge: the notch's middle is
 * this far from the bar's left edge, so it points at the anchor.
 */
export const NOTCH_X = 13
/** The gap between a bar and the text it belongs to. */
export const BAR_GAP = 10

/** How long the pointer rests on a button before its tooltip shows (the app's tooltip delay), in ms. */
const SHOW_AFTER_MS = Number.parseFloat(sizes['motion.delay.tooltip'])

/** Room a tooltip bubble needs over its button (its height, gap and the window margin). */
const TIP_ROOM = 64

/** Where the bar's tooltip shows: over the button, or under it when there is no room. */
interface ShownTip {
  tip: Tip
  x: number
  below: boolean
}

/** The box the editor's popups stay in (see the note editor's tooltip space). */
function popupSpace(view: EditorView): DOMRect {
  const root = view.dom.getRootNode()
  return (root instanceof ShadowRoot ? root.host : view.dom).getBoundingClientRect()
}

/**
 * A bar's tooltip state: `show` for a button the pointer entered, `hide`
 * when it leaves; `bubble` draws the tooltip.
 */
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
    // After a rest on the button, as the app's other tooltips.
    timer.current = setTimeout(() => {
      if (!button.isConnected) return
      const b = button.getBoundingClientRect()
      const box = bar.getBoundingClientRect()
      setShown({
        tip,
        x: b.left + b.width / 2 - box.left,
        below: b.top - TIP_ROOM < popupSpace(view).top,
      })
    }, SHOW_AFTER_MS)
  }
  const bubble = shown ? <FloatTip {...shown} /> : null
  return { show, hide, bubble }
}

/** A bar button's tooltip fades out as it goes. */
const floatTipRef = closingRef('fade', 'cm-float-tip')

function FloatTip({ tip, x, below }: ShownTip) {
  return (
    <div
      ref={floatTipRef}
      role="tooltip"
      className="cm-float-tip"
      data-side={below ? 'below' : 'above'}
      style={{ left: `${x}px` }}
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
  pressed?: boolean
  popup?: boolean
  onShowTip: (button: HTMLElement, tip: Tip) => void
  onHideTip: () => void
  onPress: (button: HTMLElement) => void
}

/** A round icon button of a floating bar. Mouse only: focus stays in the editor. */
export function FloatButton(props: FloatButtonProps) {
  return (
    <button
      type="button"
      className="cm-float-button"
      tabIndex={-1}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-haspopup={props.popup ? 'menu' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={(e) => props.onShowTip(e.currentTarget, props.tip)}
      onMouseLeave={props.onHideTip}
      onClick={(e) => props.onPress(e.currentTarget)}
    >
      <Icon name={props.icon} size="toolbar" />
    </button>
  )
}

export function FloatSeparator(): ReactNode {
  return <div role="separator" aria-orientation="vertical" className="cm-float-separator" />
}

/**
 * The bar and its notch read as one shape: one hairline round both (the
 * notch lies over the bar's edge, its fill hiding the bar's hairline where
 * they join, and draws the hairline on its two outer sides), and one shadow
 * that follows the painted shape (a filter, not a box shadow).
 */
const hairline = '0.5px solid var(--color-line-hairline)'
const notchSize = 'var(--space-4)'
const notchOut = 'calc(var(--space-4) / -2)'
const popoverShadow = [
  'drop-shadow(0 var(--shadow-popover-y) var(--shadow-popover-key-blur) var(--color-shadow-popover-key))',
  'drop-shadow(0 var(--shadow-popover-y) var(--shadow-popover-ambient-blur) var(--color-shadow-popover-ambient))',
].join(' ')

/** The bars' styles (exported for the tests); `floatTheme` is the extension. */
export const floatStyles: Parameters<typeof EditorView.theme>[0] = {
  ...motionKeyframes,
  ...closingStyles,
  '.cm-tooltip.cm-float-bar': {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    height: 'var(--size-float-toolbar-height)',
    padding: 'var(--space-2) var(--space-3)',
    border: '0',
    borderRadius: 'var(--radius-floating-bar)',
    backgroundColor: 'var(--color-surface-popover)',
    boxShadow: '0 0 0 0.5px var(--color-line-hairline)',
    filter: popoverShadow,
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-family-ui)',
    // A bar only fades in; its tooltip grows out of its notch.
    animation: fadeIn,
  },
  // The notch: a turned square centred on the bar's edge, over it.
  '.cm-tooltip.cm-float-bar::after': {
    content: '""',
    position: 'absolute',
    zIndex: '1',
    boxSizing: 'border-box',
    // `--float-notch-x` is set by a bar held back at an edge, so the tip stays on its anchor.
    left: `calc(var(--float-notch-x, ${NOTCH_X}px) - ${notchSize} / 2)`,
    width: notchSize,
    height: notchSize,
    backgroundColor: 'var(--color-surface-popover)',
    transform: 'rotate(45deg)',
    pointerEvents: 'none',
  },
  '.cm-tooltip-above.cm-float-bar::after': {
    bottom: notchOut,
    borderRight: hairline,
    borderBottom: hairline,
  },
  '.cm-tooltip-below.cm-float-bar::after': {
    top: notchOut,
    borderLeft: hairline,
    borderTop: hairline,
  },
  '.cm-float-buttons': {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
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
  '.cm-float-button:hover': {
    borderColor: 'var(--color-line-control)',
    backgroundColor: 'var(--color-fill-tool-hover)',
  },
  '.cm-float-button[aria-pressed="true"]': {
    borderColor: 'var(--color-line-control)',
    backgroundColor: 'var(--color-fill-tool-hover)',
    color: 'var(--color-accent-text)',
  },
  '.cm-float-separator': {
    alignSelf: 'center',
    flexShrink: '0',
    width: '1px',
    height: 'var(--size-icon-toolbar)',
    margin: '0 var(--space-3)',
    background: 'var(--color-line-hairline)',
  },
  '.cm-float-label': {
    flexShrink: '0',
    padding: '0 var(--space-4) 0 var(--space-3)',
    fontSize: 'var(--font-size-body)',
    color: 'var(--color-text-tertiary)',
    whiteSpace: 'nowrap',
  },
  // The app's icon rules do not reach into the editor's shadow root.
  '.cm-float-button .icon': {
    display: 'inline-block',
    width: 'var(--size-icon-toolbar)',
    height: 'var(--size-icon-toolbar)',
    backgroundColor: 'currentColor',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  },
  '.cm-float-tip': {
    position: 'absolute',
    zIndex: '1',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-3) var(--space-5)',
    borderRadius: 'var(--radius-card)',
    backgroundColor: 'var(--color-surface-popover)',
    // Inside the bar: the bar's shadow (a filter) reaches it too.
    boxShadow: '0 0 0 0.5px var(--color-line-hairline)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-footnote)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    transform: 'translateX(-50%)',
    animation: tipIn,
  },
  '.cm-float-tip[data-side="below"]': {
    top: 'calc(100% + var(--tooltip-gap))',
  },
  '.cm-float-tip[data-side="above"]': {
    bottom: 'calc(100% + var(--tooltip-gap))',
  },
  // The tooltip's notch, pointing at its button, like the bar's.
  '.cm-float-tip::before': {
    content: '""',
    position: 'absolute',
    boxSizing: 'border-box',
    left: `calc(50% - ${notchSize} / 2)`,
    width: notchSize,
    height: notchSize,
    backgroundColor: 'inherit',
    transform: 'rotate(45deg)',
  },
  '.cm-float-tip[data-side="below"]::before': {
    top: notchOut,
    borderLeft: hairline,
    borderTop: hairline,
  },
  '.cm-float-tip[data-side="above"]::before': {
    bottom: notchOut,
    borderRight: hairline,
    borderBottom: hairline,
  },
  '.cm-float-kbd': {
    padding: '0 var(--space-3)',
    borderRadius: 'var(--radius-control)',
    boxShadow: 'inset 0 0 0 1px var(--color-line-control)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-caption)',
    lineHeight: 'var(--size-segment-height)',
    color: 'var(--color-text-secondary)',
  },
}

/** The bars' look, and their fading out when they close. */
export const floatTheme = [EditorView.theme(floatStyles), closingTooltips]
