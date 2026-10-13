import { useKeymap } from '../commands/shortcutSettings'
import { titleWithKey } from '../commands/titles'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { countOf } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import type { FindStatus } from './target'

interface Props {
  fieldRef: RefObject<HTMLInputElement | null>
  barRef: RefObject<HTMLDivElement | null>
  query: string
  replacement: string
  regexp: boolean
  caseSensitive: boolean
  /** Shows the replace row (only for a pane that can replace). */
  replace: boolean
  status: FindStatus
  onQuery: (query: string) => void
  onReplacement: (replacement: string) => void
  onToggleRegexp: () => void
  onToggleCase: () => void
  onNext: () => void
  onPrevious: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}

/** What the bar says about the matches, or nothing before a query. */
export function statusText(query: string, status: FindStatus, locale: string): string {
  if (query === '') return ''
  if (status.invalid) return t('find.invalid')
  if (status.total === 0) return t('find.none')
  const number = new Intl.NumberFormat(locale)
  if (status.capped) return format(t('find.capped'), { count: number.format(status.total) })
  if (status.current === null)
    return countOf(status.total, locale, 'find.countOne', 'find.countOther')
  return format(t('find.position'), {
    current: number.format(status.current + 1),
    total: number.format(status.total),
  })
}

/** Keeps the keyboard in the field when a button is clicked. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()

function BarButton(props: {
  label: MessageKey
  /** The tooltip; the label without one. */
  title?: string
  pressed?: boolean
  className: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={props.className}
      aria-label={t(props.label)}
      title={props.title ?? t(props.label)}
      aria-pressed={props.pressed}
      // Not `disabled`: a focused button that disables itself (Replace All
      // from the keyboard) would drop the focus out of the bar.
      aria-disabled={props.disabled || undefined}
      onMouseDown={keepFocus}
      onClick={props.disabled ? undefined : props.onClick}
    >
      {props.children}
    </button>
  )
}

/** Field props shared by the find and replace fields: text, not prose. */
const textField = {
  type: 'text',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const

/**
 * The find bar over the open note: a query with its options, the matches,
 * and (for the editor) replacing. Escape is handled by `useFind`.
 */
export function FindBar({ fieldRef, barRef, ...props }: Props) {
  useKeymap()
  const { status } = props
  const said = statusText(props.query, status, currentLocale())
  const none = status.total === 0
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isImeKey(e.nativeEvent)) return
    e.preventDefault()
    if (e.shiftKey) props.onPrevious()
    else props.onNext()
  }
  const onReplaceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isImeKey(e.nativeEvent)) return
    e.preventDefault()
    props.onReplace()
  }
  return (
    <div
      ref={barRef}
      className="find-bar"
      role="search"
      aria-label={t('find.label')}
      data-devot-part="find-bar"
    >
      <div className="find-row">
        <input
          {...textField}
          ref={fieldRef}
          className="find-field"
          aria-label={t('find.field')}
          placeholder={t('find.field')}
          aria-invalid={status.invalid || undefined}
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={onFindKey}
        />
        <span className="find-status" role="status" data-error={status.invalid || undefined}>
          {said}
        </span>
        <BarButton
          className="find-toggle"
          label="find.matchCase"
          title={titleWithKey('find.matchCaseTitle', 'find.caseSensitive')}
          pressed={props.caseSensitive}
          onClick={props.onToggleCase}
        >
          {t('find.matchCaseGlyph')}
        </BarButton>
        <BarButton
          className="find-toggle"
          label="find.regexp"
          title={titleWithKey('find.regexpTitle', 'find.regexp')}
          pressed={props.regexp}
          onClick={props.onToggleRegexp}
        >
          {t('find.regexpGlyph')}
        </BarButton>
        <BarButton
          className="tool tool-small"
          label="find.previous"
          title={titleWithKey('find.previousTitle', 'find.previous')}
          disabled={none}
          onClick={props.onPrevious}
        >
          <Icon name="find.previous" size="sm" />
        </BarButton>
        <BarButton
          className="tool tool-small"
          label="find.next"
          title={titleWithKey('find.nextTitle', 'find.next')}
          disabled={none}
          onClick={props.onNext}
        >
          <Icon name="find.next" size="sm" />
        </BarButton>
        <BarButton className="button" label="find.done" onClick={props.onClose}>
          {t('find.done')}
        </BarButton>
      </div>
      {props.replace ? (
        <div className="find-row">
          <input
            {...textField}
            className="find-field"
            aria-label={t('find.replaceField')}
            placeholder={t('find.replaceField')}
            value={props.replacement}
            onChange={(e) => props.onReplacement(e.target.value)}
            onKeyDown={onReplaceKey}
          />
          <BarButton
            className="button"
            label="find.replace"
            disabled={none}
            onClick={props.onReplace}
          >
            {t('find.replace')}
          </BarButton>
          <BarButton
            className="button"
            label="find.replaceAll"
            disabled={none}
            onClick={props.onReplaceAll}
          >
            {t('find.replaceAll')}
          </BarButton>
        </div>
      ) : null}
    </div>
  )
}
