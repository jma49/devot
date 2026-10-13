import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { t } from './i18n'
import { Icon } from './icons/Icon'

/** The value the pop-up shows while the notes' statuses differ. */
const MIXED = ''

/**
 * Pop-up button for the open note's status, or for several notes' (`mixed`:
 * they differ, and it reads Mixed until one is picked).
 */
export function StatusPicker(props: {
  value: NoteStatus
  mixed?: boolean
  onChange: (status: NoteStatus) => void
}) {
  return (
    <label className={`popup status-${props.mixed ? 'none' : props.value}`}>
      <span className="status-dot" aria-hidden="true" />
      <select
        aria-label={t('note.statusLabel')}
        value={props.mixed ? MIXED : props.value}
        onChange={(e) => {
          if (e.target.value !== MIXED) props.onChange(e.target.value as NoteStatus)
        }}
      >
        {props.mixed ? (
          <option value={MIXED} disabled>
            {t('status.mixed')}
          </option>
        ) : null}
        {NOTE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </select>
      <Icon name="popup" size="sm" />
    </label>
  )
}
