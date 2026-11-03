import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Icon } from '../icons/Icon'
import type { EditorSettings } from '../../../core/editorSettings'
import { errorCode } from '../backups'
import { changeEditorSettings } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { ShowHint, useOnPhone } from './onPhone'

/**
 * Stores a change to the settings (see editorSettings.ts); returns the error
 * code of the last change that could not be stored, cleared by the next one
 * that could.
 */
export function useSettingsChange(): [
  error: string | undefined,
  change: (patch: Partial<EditorSettings>) => void,
] {
  const [error, setError] = useState<string>()
  const change = (patch: Partial<EditorSettings>) =>
    void changeEditorSettings(patch).then(
      () => setError(undefined),
      (e: unknown) => setError(errorCode(e)),
    )
  return [error, change]
}

/** On a phone a long explanation opens in a sheet from this button instead of sitting under its row. */
export function HintButton({ title, body }: { title: string; body: string }) {
  const show = useContext(ShowHint)
  return (
    <button
      type="button"
      className="phone-hint-button"
      aria-label={format(t('phone.hint.about'), { name: title })}
      onClick={() => show?.({ title, body })}
    >
      <Icon name="phone.info" size="md" />
    </button>
  )
}

export function SettingsSection({
  title,
  titleSuffix,
  footnote,
  titleHidden,
  children,
}: {
  title: MessageKey
  /** After the title in the secondary colour, such as Light Mode's "Active". */
  titleSuffix?: string | undefined
  /** Under the card, after an info glyph. */
  footnote?: string | undefined
  /** The screen's own title already says this: the section keeps it as its accessible name only. */
  titleHidden?: boolean | undefined
  children: ReactNode
}) {
  const id = useId()
  const hinted = useContext(ShowHint) !== null
  const heading = titleHidden ? null : (
    <h3 id={id} className="settings-block-title">
      {t(title)}
      {titleSuffix ? <span className="settings-block-suffix"> {titleSuffix}</span> : null}
    </h3>
  )
  return (
    <section
      className="settings-block"
      {...(titleHidden ? { 'aria-label': t(title) } : { 'aria-labelledby': id })}
    >
      {hinted && footnote ? (
        <div className="phone-block-head">
          {heading}
          <HintButton title={t(title)} body={footnote} />
        </div>
      ) : (
        heading
      )}
      <div className="settings-card">{children}</div>
      {footnote && !hinted ? (
        <p className="settings-footnote">
          <Icon name="settings.note" size="sm" />
          <span>{footnote}</span>
        </p>
      ) : null}
    </section>
  )
}

/** A pop-up as a capsule: the value, then a round button with the up and down chevron. */
export function Select(props: ComponentProps<'select'>) {
  const onPhone = useOnPhone()
  const select = useRef<HTMLSelectElement>(null)
  const [shown, setShown] = useState('')
  // A select is as wide as its widest option; a phone row shows the chosen one's text at its own width, under the invisible native control.
  useLayoutEffect(() => {
    if (onPhone) setShown(select.current?.selectedOptions[0]?.text ?? '')
  }, [onPhone, props.value, props.children])
  return (
    <span className="select">
      <select ref={select} {...props} />
      {onPhone ? (
        <span className="select-value" aria-hidden="true">
          {shown}
        </span>
      ) : null}
      <span className="select-chevron" aria-hidden="true">
        <Icon name="popup" size="sm" />
      </span>
    </span>
  )
}

export function Setting({
  label,
  description,
  htmlFor,
  descriptionId,
  stacked = false,
  live = false,
  children,
}: {
  label: MessageKey
  description: string
  htmlFor?: string
  descriptionId?: string
  /** The control goes under the text, full width, for content too wide to sit beside it. */
  stacked?: boolean
  /** The description is the row's value or state, not an explanation: it stays in the row on a phone. */
  live?: boolean
  children: ReactNode
}) {
  const hinted = useContext(ShowHint) !== null && !live
  return (
    <div className={stacked ? 'setting setting-stacked' : 'setting'}>
      <div className="setting-text">
        {htmlFor === undefined ? (
          <span className="setting-label">{t(label)}</span>
        ) : (
          <label className="setting-label" htmlFor={htmlFor}>
            {t(label)}
          </label>
        )}
        {description && hinted ? (
          <>
            <span id={descriptionId} hidden>
              {description}
            </span>
            <HintButton title={t(label)} body={description} />
          </>
        ) : description ? (
          <span id={descriptionId} className="setting-description">
            {description}
          </span>
        ) : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function SettingToggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  note,
  values,
}: {
  label: MessageKey
  description: MessageKey
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  note?: MessageKey | undefined
  /** Placeholders the description is filled with. */
  values?: Readonly<Record<string, string>>
}) {
  const id = useId()
  const hinted = useContext(ShowHint) !== null
  const text = values ? format(t(note ?? description), values) : t(note ?? description)
  return (
    <div className="setting setting-toggle">
      <div className="setting-text">
        <label id={`${id}-label`} className="setting-label" htmlFor={`${id}-box`}>
          {t(label)}
        </label>
        {hinted ? (
          <>
            <span id={`${id}-description`} hidden>
              {text}
            </span>
            <HintButton title={t(label)} body={text} />
          </>
        ) : (
          <span id={`${id}-description`} className="setting-description">
            {text}
          </span>
        )}
      </div>
      <div className="setting-control">
        <input
          id={`${id}-box`}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      </div>
    </div>
  )
}

export function SettingsNote({ id, children }: { id?: string | undefined; children: ReactNode }) {
  return (
    <p id={id} className="settings-note">
      {children}
    </p>
  )
}

/**
 * A number with - and + beside it; the field takes typing too (the caller
 * stores what is typed once typing pauses). Both buttons use one icon set and
 * one stroke, so they match.
 */
export function NumberStepper({
  id,
  value,
  min,
  max,
  step = 1,
  onType,
  onLeave,
  describedBy,
}: {
  id: string
  value: string
  min: number
  max: number
  step?: number
  onType: (text: string) => void
  onLeave: () => void
  describedBy?: string | undefined
}) {
  const typed = Number(value)
  const current = value.trim() !== '' && Number.isFinite(typed) ? typed : min
  const stepBy = (delta: number) => {
    onType(String(Math.min(max, Math.max(min, current + delta))))
    onLeave()
  }
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper-button"
        aria-label={t('stepper.less')}
        disabled={current <= min}
        onClick={() => stepBy(-step)}
      >
        <Icon name="stepper.less" size="sm" />
      </button>
      <input
        id={id}
        type="number"
        className="stepper-field"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={describedBy}
        onChange={(e) => onType(e.currentTarget.value)}
        onBlur={onLeave}
      />
      <button
        type="button"
        className="stepper-button"
        aria-label={t('stepper.more')}
        disabled={current >= max}
        onClick={() => stepBy(step)}
      >
        <Icon name="stepper.more" size="sm" />
      </button>
    </div>
  )
}

export interface MoreMenuItem {
  label: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * A round "…" button with a menu under it: the arrow keys, Home and End move between the items,
 * Escape closes it and gives the button the keyboard back, and so does a pick, before the item acts
 * (a dialog it opens then gives the keyboard back to the button). A disabled item stays reachable.
 */
export function MoreMenu({ label, items }: { label: string; items: readonly MoreMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const entries = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ]

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (e: PointerEvent) => {
      const at = e.target as Node
      if (!menu.current?.contains(at) && !button.current?.contains(at)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open, button, menu])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = entries()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const to = (i: number) => {
      e.preventDefault()
      all[(i + all.length) % all.length]?.focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
    else if (e.key === 'ArrowDown') to(at + 1)
    else if (e.key === 'ArrowUp') to(at - 1)
    else if (e.key === 'Home') to(0)
    else if (e.key === 'End') to(all.length - 1)
  }

  return (
    <div className="more-menu">
      <button
        ref={button}
        type="button"
        className="settings-more"
        data-tauri-drag-region="false"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Icon name="settings.more" size="sm" weight="semibold" />
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className="more-menu-list"
          onKeyDown={onMenuKey}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="more-menu-item"
              aria-disabled={item.disabled || undefined}
              onClick={() => {
                if (item.disabled) return
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
