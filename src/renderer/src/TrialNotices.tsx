// What the windows say about the trial: one bar that stays while notes are read-only (the trial is
// over without a licence), and once, in the trial's last day, when it ends.
import { useEffect, useRef, useState } from 'react'
import { currentLocale, t } from './i18n'
import { openBuy, openLicenceSettings, useLicence, useTrialOver } from './licence'
import { reminderDue, reminderText, REMINDER_MS } from './licenceView'

const REMINDED_KEY = 'devot.trial.reminded'

/** The end of the trial whose reminder was dismissed; kept beside the window's other view state. */
function remindedFor(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(REMINDED_KEY))
    return Number.isSafeInteger(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

function remember(endsAt: number) {
  try {
    globalThis.localStorage?.setItem(REMINDED_KEY, String(endsAt))
  } catch {
    console.warn('W_TRIAL_REMINDER_NOT_KEPT')
  }
}

function TrialButtons() {
  return (
    <>
      <button type="button" className="button" onClick={openBuy}>
        {t('licenceSettings.buy')}
      </button>
      <button type="button" className="button" onClick={openLicenceSettings}>
        {t('licenceSettings.add')}
      </button>
    </>
  )
}

/** Stays while the trial is over without a licence; nothing dismisses it. */
export function TrialEndedBar() {
  const over = useTrialOver()
  const bar = useRef<HTMLDivElement>(null)
  // It floats over the foot of the panes for the whole read-only period, so the panes keep that much room
  // free and their last row or line can be seen and clicked.
  useEffect(() => {
    const el = bar.current
    if (!over || !el) return
    const root = document.documentElement
    const reserve = () => {
      // Layout, not the rect: the bar enters with a translate, and the stack holds it above the window's edge.
      const stack = el.parentElement
      const gap = Number.parseFloat(stack ? getComputedStyle(stack).bottom : '')
      root.style.setProperty('--trial-bar-inset', `${el.offsetHeight + (gap || 0)}px`)
    }
    reserve()
    const observer = new ResizeObserver(reserve)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--trial-bar-inset')
    }
  }, [over])
  if (!over) return null
  return (
    <div ref={bar} role="status" className="notice" data-devot-part="notice" data-devot-trial-ended>
      <span className="notice-text">{t('trial.ended')}</span>
      <TrialButtons />
    </div>
  )
}

const nextMidnight = (from: number) => {
  const date = new Date(from)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

/** Once, when less than a day of the trial is left; dismissed, it never comes back. */
export function TrialReminder() {
  const licence = useLicence()
  const [dismissed, setDismissed] = useState(remindedFor)
  const [now, setNow] = useState(Date.now)
  const endsAt = licence.trial?.state === 'running' ? licence.trial.endsAt : null

  // Shown when the last day begins, gone when the trial ends; its "today" and "tomorrow" turn over
  // at midnight too.
  useEffect(() => {
    if (endsAt === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = () => {
      const at = Date.now()
      const when = [endsAt - REMINDER_MS, endsAt, nextMidnight(at)]
        .filter((moment) => moment > at)
        .sort((a, b) => a - b)[0]
      if (when === undefined) return
      timer = setTimeout(
        () => {
          setNow(Date.now())
          wait()
        },
        Math.min(when - at, 2 ** 31 - 1),
      )
    }
    wait()
    return () => clearTimeout(timer)
  }, [endsAt])

  if (endsAt === null || !reminderDue(licence, now, dismissed)) return null
  return (
    <div role="alert" className="notice" data-devot-part="notice" data-devot-trial-reminder>
      <span className="notice-text">{reminderText(endsAt, now, currentLocale())}</span>
      <TrialButtons />
      <button
        type="button"
        className="button"
        onClick={() => {
          remember(endsAt)
          setDismissed(endsAt)
        }}
      >
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
