import { useId, useState, type ReactNode } from 'react'
import type { EditorSettings } from '../../../core/editorSettings'
import { errorCode } from '../backups'
import { changeEditorSettings } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'

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

/** A checkbox with its label, and a hint under it when there is one. */
export function SettingsFlag({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
}: {
  label: MessageKey
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: { id: string; text: MessageKey } | undefined
  disabled?: boolean
}) {
  return (
    <div className="settings-flag">
      <label className="settings-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint?.id}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        {t(label)}
      </label>
      {hint ? (
        <span id={hint.id} className="settings-hint">
          {t(hint.text)}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The label of a form row: the catalog text and a colon, right-aligned in
 * the form's label column.
 */
const rowLabel = (label: MessageKey) => format(t('settings.formLabel'), { label: t(label) })

/**
 * A row of a settings form: its label right-aligned in the label column,
 * its controls (and any hint, under them) left-aligned in the control
 * column. With `htmlFor` the label names that control; without it the
 * controls are a group the label names (a column of checkboxes); with no
 * label the label column stays empty.
 */
export function FormRow({
  label,
  htmlFor,
  children,
}: {
  label?: MessageKey
  htmlFor?: string
  children: ReactNode
}) {
  const id = useId()
  if (label === undefined) {
    return (
      <div className="settings-row">
        <span />
        <div className="settings-control">{children}</div>
      </div>
    )
  }
  if (htmlFor !== undefined) {
    return (
      <div className="settings-row">
        <label className="settings-label" htmlFor={htmlFor}>
          {rowLabel(label)}
        </label>
        <div className="settings-control">{children}</div>
      </div>
    )
  }
  return (
    <div className="settings-row">
      <span id={`${id}-label`} className="settings-label">
        {rowLabel(label)}
      </span>
      <div className="settings-control" role="group" aria-labelledby={`${id}-label`}>
        {children}
      </div>
    </div>
  )
}

/** Rows that belong together, set apart from the next group by space. */
export function FormGroup({ label, children }: { label?: MessageKey; children: ReactNode }) {
  return (
    <div
      className="settings-form-group"
      role={label ? 'group' : undefined}
      aria-label={label ? t(label) : undefined}
    >
      {children}
    </div>
  )
}

/** A hint under a row's control, in the secondary colour. */
export function FormHint({ id, children }: { id?: string | undefined; children: ReactNode }) {
  return (
    <span id={id} className="settings-hint">
      {children}
    </span>
  )
}
