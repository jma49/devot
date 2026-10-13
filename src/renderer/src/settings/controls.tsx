import { useState } from 'react'
import type { EditorSettings } from '../../../core/editorSettings'
import { errorCode } from '../backups'
import { changeEditorSettings } from '../editorSettings'
import { t, type MessageKey } from '../i18n'

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
