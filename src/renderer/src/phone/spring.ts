import { motionScale, springEasing } from '../motionTiming'
import { sizes } from '../theme/tokens'
import { isAccessibilitySize, textScaleFrom } from './navigation'

export type PhoneSpring = 'gentle' | 'bouncy'

export function phoneSpring(name: PhoneSpring, factor = motionScale()) {
  const { easing, ms } = springEasing(
    Number(sizes[`motion.spring.${name}-damping`]),
    Number(sizes[`motion.spring.${name}-response`]),
  )
  return { easing, ms: ms * factor }
}

const BAR_TEXT_LIMIT = 1.35

function applyTextScale(root: HTMLElement): void {
  const probe = document.createElement('span')
  // WebKit resolves this system font to the Dynamic Type size; `rem` and `em` do not follow it.
  probe.style.font = '-apple-system-body'
  root.append(probe)
  const scale = textScaleFrom(Number.parseFloat(getComputedStyle(probe).fontSize))
  probe.remove()
  root.style.setProperty('--phone-text-scale', String(scale))
  root.style.setProperty('--phone-bar-text-scale', String(Math.min(scale, BAR_TEXT_LIMIT)))
  root.dataset['textSize'] = isAccessibilitySize(scale) ? 'accessibility' : 'standard'
}

/** Puts the springs and the text scale on the phone layout's root, and follows the text size. */
export function startPhoneRoot(root: HTMLElement): () => void {
  for (const name of ['gentle', 'bouncy'] as const) {
    const { easing, ms } = phoneSpring(name)
    root.style.setProperty(`--phone-spring-${name}`, easing)
    root.style.setProperty(`--phone-spring-${name}-duration`, `${ms}ms`)
  }
  applyTextScale(root)
  const refresh = () => {
    if (document.visibilityState === 'visible') applyTextScale(root)
  }
  document.addEventListener('visibilitychange', refresh)
  return () => document.removeEventListener('visibilitychange', refresh)
}
