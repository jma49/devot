import { useRef } from 'react'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { shortcutLabel } from './commands/keys'
import { commandKeys } from './commands/registry'
import { t } from './i18n'
import { Icon } from './icons/Icon'
import { STATUS_ICONS } from './NoteRow'
import { PickerList, usePickerOpen, type PickerOption } from './Picker'
import { STATUS_COMMANDS } from './statusKeys'

/** The status pop-over's rows: each status's icon in its colour, its name and its key in grey. */
export function statusOptions(): PickerOption[] {
  return NOTE_STATUSES.map((status) => {
    const key = commandKeys(STATUS_COMMANDS[status])[0]
    return {
      id: status,
      className: `status-${status}`,
      content: (
        <>
          <Icon name={STATUS_ICONS[status]} size="sm" />
          <span className="picker-name">
            {t(status === 'none' ? 'status.pickNone' : `status.${status}`)}
          </span>
          {key ? (
            <kbd className="picker-key" aria-hidden="true">
              {shortcutLabel(key)}
            </kbd>
          ) : null}
        </>
      ),
    }
  })
}

/**
 * Pop-up button for the open note's status, or for several notes' (`mixed`:
 * they differ, and it reads Mixed until one is picked). With no status it
 * reads Status, in grey. It opens a pop-over of the five statuses, each
 * with its key.
 */
export function StatusPicker(props: {
  value: NoteStatus
  mixed?: boolean
  onChange: (status: NoteStatus) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = usePickerOpen(box)
  const shown = props.mixed ? 'none' : props.value
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  return (
    <div ref={box} className="picker">
      <button
        ref={button}
        type="button"
        className={`popup status-${shown}`}
        aria-label={t('note.statusLabel')}
        data-value={props.mixed ? '' : props.value}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return
          e.preventDefault()
          setOpen(true)
        }}
      >
        {shown === 'none' ? null : <Icon name={STATUS_ICONS[shown]} size="sm" />}
        <span className="popup-value">
          {props.mixed
            ? t('status.mixed')
            : props.value === 'none'
              ? t('note.statusLabel')
              : t(`status.${props.value}`)}
        </span>
        <Icon name="popup.chevron" size="xs" />
      </button>
      {open ? (
        <PickerList
          label={t('note.statusLabel')}
          options={statusOptions()}
          value={props.mixed ? undefined : props.value}
          onClose={close}
          onPick={(status) => {
            close()
            if (props.mixed || status !== props.value) props.onChange(status as NoteStatus)
          }}
        />
      ) : null}
    </div>
  )
}
