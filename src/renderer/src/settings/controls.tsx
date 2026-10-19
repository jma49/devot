import { useId, useState, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
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

export function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: IconName
  title: MessageKey
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="settings-block" aria-labelledby={id}>
      <h3 id={id} className="settings-block-title">
        <Icon name={icon} size="md" />
        {t(title)}
      </h3>
      {children}
    </section>
  )
}

export function Setting({
  label,
  description,
  htmlFor,
  descriptionId,
  children,
}: {
  label: MessageKey
  description: string
  htmlFor?: string
  descriptionId?: string
  children: ReactNode
}) {
  return (
    <div className="setting">
      <div className="setting-text">
        {htmlFor === undefined ? (
          <span className="setting-label">{t(label)}</span>
        ) : (
          <label className="setting-label" htmlFor={htmlFor}>
            {t(label)}
          </label>
        )}
        <span id={descriptionId} className="setting-description">
          {description}
        </span>
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
}: {
  label: MessageKey
  description: MessageKey
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  note?: MessageKey | undefined
}) {
  const id = useId()
  return (
    <div className="setting setting-toggle">
      <div className="setting-text">
        <label id={`${id}-label`} className="setting-label" htmlFor={`${id}-box`}>
          {t(label)}
        </label>
        <span id={`${id}-description`} className="setting-description">
          {t(note ?? description)}
        </span>
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
