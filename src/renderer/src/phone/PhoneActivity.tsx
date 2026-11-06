import { useEffect, useMemo, useState } from 'react'
import {
  ACTIVITY_LEVELS,
  WRITING_WEEKS,
  type Writing,
  type WritingWeekChoice,
} from '../../../core/activity'
import { monthLabels } from '../Activity'
import { formatNumber } from '../format'
import { displayTitle } from '../headlines'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { haptic } from './haptics'
import { SectionHead } from './PhoneNoteList'
import type { PhoneData } from './usePhoneData'

const RANKED_NOTES = 4
const CHOICES: readonly WritingWeekChoice[] = ['this', 'last']
const CHOICE_LABEL: Record<WritingWeekChoice, MessageKey> = {
  this: 'phone.activity.week.this',
  last: 'phone.activity.week.last',
}
const WORDS_LABEL: Record<WritingWeekChoice, MessageKey> = {
  this: 'phone.activity.words.this',
  last: 'phone.activity.words.last',
}
const RANKED_LABEL: Record<WritingWeekChoice, MessageKey> = {
  this: 'phone.activity.ranked.this',
  last: 'phone.activity.ranked.last',
}

function Heatmap(props: { writing: Writing | null }) {
  const locale = currentLocale()
  const { writing } = props
  const summary = format(t('phone.activity.summary'), {
    weeks: String(WRITING_WEEKS),
    words: formatNumber(writing?.days.reduce((sum, day) => sum + day.words, 0) ?? 0, locale),
    days: formatNumber(writing?.days.filter((day) => day.level > 0).length ?? 0, locale),
  })
  return (
    <div className="phone-heat-card">
      <div className="phone-heat-head">
        <h2 className="phone-heat-title">{t('phone.activity.writing')}</h2>
        <span className="phone-heat-note phone-figures">
          {format(t('phone.activity.span'), { weeks: String(WRITING_WEEKS) })}
        </span>
      </div>
      {writing && (
        <div aria-hidden="true" className="phone-heat-months phone-figures">
          {monthLabels(writing.first, WRITING_WEEKS, locale).map((label, week) => (
            <span key={week}>{label}</span>
          ))}
        </div>
      )}
      <div role="img" aria-label={summary} className="phone-heat-grid">
        {writing?.days.map((day) => (
          <span key={day.day} className="phone-heat-cell" data-level={day.level} />
        ))}
      </div>
      <div aria-hidden="true" className="phone-heat-legend phone-figures">
        {t('phone.activity.less')}
        {Array.from({ length: ACTIVITY_LEVELS + 1 }, (_, level) => (
          <span key={level} className="phone-heat-swatch" data-level={level} />
        ))}
        {t('phone.activity.more')}
      </div>
    </div>
  )
}

export function PhoneActivity(props: { data: PhoneData; onOpenNote: (id: string) => void }) {
  const { core, loadedAt, notes } = props.data
  const title = t('phone.tab.activity')
  const locale = currentLocale()
  const [writing, setWriting] = useState<Writing | null>(null)
  const [choice, setChoice] = useState<WritingWeekChoice>('this')
  const [choosing, setChoosing] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (!core) return
    let current = true
    core
      .writing(Date.now())
      .then((next) => {
        if (current) setWriting(next)
      })
      .catch(() => console.warn('W_PHONE_ACTIVITY_FAILED'))
    return () => {
      current = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each load of the lists counts the writing again.
  }, [core, loadedAt])

  const week = writing?.weeks[choice]
  const ranked = useMemo(() => {
    const byId = new Map(notes.map((note) => [note.id, note]))
    return (week?.mostEdited ?? [])
      .flatMap((growth) => {
        const note = byId.get(growth.noteId)
        return note ? [{ ...growth, title: displayTitle(note.title, undefined) }] : []
      })
      .slice(0, RANKED_NOTES)
  }, [notes, week])

  const stats: readonly [number, MessageKey][] = [
    [week?.words ?? 0, WORDS_LABEL[choice]],
    [week?.streak ?? 0, 'phone.activity.streak'],
    [week?.notesEdited ?? 0, 'phone.activity.edited'],
  ]
  const rankedTitle = t(RANKED_LABEL[choice])

  return (
    <section aria-label={title} className="phone-screen">
      <div className="phone-scroll phone-library">
        <Heatmap writing={writing} />
        <div className="phone-stats">
          {stats.map(([value, label]) => (
            <div key={label} className="phone-stat">
              <span className="phone-stat-label">{t(label)}</span>
              <p className="phone-stat-value phone-figures">{formatNumber(value, locale)}</p>
            </div>
          ))}
        </div>
        <section className="phone-section" aria-label={rankedTitle}>
          <SectionHead
            title={rankedTitle}
            collapsed={collapsed}
            onToggle={() => setCollapsed((was) => !was)}
          />
          <div
            className="phone-note-section-body phone-section-body"
            data-collapsed={collapsed || undefined}
            inert={collapsed}
          >
            <ul className="phone-card">
              {ranked.length === 0 && (
                <li className="phone-ranked-empty">{t('phone.activity.noGrowth')}</li>
              )}
              {ranked.map((note, place) => (
                <li key={note.noteId} className="phone-grouped-row">
                  <button
                    type="button"
                    className="phone-grouped-open"
                    onClick={() => props.onOpenNote(note.noteId)}
                  >
                    <span className="phone-ranked-place phone-figures">{place + 1}</span>
                    <span className="phone-grouped-label">{note.title}</span>
                    <span className="phone-ranked-growth phone-figures">
                      +{formatNumber(note.words, locale)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <h1 className="phone-topbar-title">{title}</h1>
        <div className="phone-glass phone-capsule">
          <button
            type="button"
            className="phone-capsule-button phone-capsule-text"
            aria-haspopup="menu"
            aria-expanded={choosing}
            onClick={() => setChoosing((shown) => !shown)}
          >
            {t('phone.activity.period')}
            <Icon name="popup.chevron" size="sm" weight="medium" />
          </button>
        </div>
      </header>
      {choosing && (
        <>
          <button
            type="button"
            className="phone-filter-scrim"
            aria-label={t('phone.close')}
            onClick={() => setChoosing(false)}
          />
          <div
            role="menu"
            aria-label={t('phone.activity.period')}
            className="phone-glass phone-peek-menu phone-filter-menu"
          >
            {CHOICES.map((next) => (
              <button
                key={next}
                type="button"
                role="menuitemradio"
                aria-checked={next === choice}
                className="phone-filter-item"
                onClick={() => {
                  if (next !== choice) haptic('selection')
                  setChoice(next)
                  setChoosing(false)
                }}
              >
                <span className="phone-filter-item-label">{t(CHOICE_LABEL[next])}</span>
                {next === choice && <Icon name="check" size="sm" />}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
