import { motionTiming } from '../motionTiming'

// The distance Edit and Preview cross over (design/motion.md, Edit and Preview).
const LIFT = 'translateY(8px)'
const REST = 'translateY(0)'

/**
 * Crossfades two panes already in their final state: the one coming fades in as it rises, the one
 * going fades out as it drops. Opacity and an added transform only, so the compositor runs it;
 * under Reduce Motion the panes only fade.
 */
export function crossfadePanes(
  incoming: HTMLElement,
  outgoing: HTMLElement,
  reduced: boolean,
): Promise<void> {
  const fade = motionTiming('motion.duration.phone-enter', 'motion.easing.standard')
  const moving = [incoming, outgoing]
  for (const pane of moving) {
    for (const running of pane.getAnimations()) running.cancel()
    pane.style.willChange = 'transform, opacity'
  }
  const animations = [
    incoming.animate([{ opacity: 0 }, { opacity: 1 }], fade),
    outgoing.animate([{ opacity: 1 }, { opacity: 0 }], fade),
  ]
  if (!reduced) {
    const rise = motionTiming('motion.duration.phone-enter', 'motion.easing.phone-enter')
    const drop = motionTiming('motion.duration.phone-enter', 'motion.easing.phone-pair')
    animations.push(
      incoming.animate([{ transform: LIFT }, { transform: REST }], { ...rise, composite: 'add' }),
      outgoing.animate([{ transform: REST }, { transform: LIFT }], { ...drop, composite: 'add' }),
    )
  }
  return Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
    () => {
      for (const pane of moving) pane.style.removeProperty('will-change')
    },
  )
}
