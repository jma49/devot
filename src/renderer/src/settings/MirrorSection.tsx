import { useCallback, useEffect, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { fileSize } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import {
  changeMirror,
  pausedMessage,
  startMirrorStatus,
  useMirrorStatus,
  type MirrorPatch,
} from '../mirror'
import { useMirrorFolderChoice } from '../MirrorFolderChoice'
import { Setting, SettingToggle, SettingsNote, SettingsSection } from './controls'

export function MirrorSection() {
  const status = useMirrorStatus()
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const chooseFailed = useCallback(
    (code: string) => setError({ message: 'mirror.chooseFailed', code }),
    [],
  )
  const folderChoice = useMirrorFolderChoice(chooseFailed)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const locale = currentLocale()
  const on = status.folder !== null
  const mirrorSize = (size: number | null, loc: string) =>
    size === null
      ? t('mirror.folderLabel')
      : format(t('mirror.size'), { size: fileSize(size, loc) })

  useEffect(() => startMirrorStatus(), [])

  const choose = () => {
    setError(undefined)
    void folderChoice.choose()
  }

  const change = (patch: MirrorPatch) =>
    changeMirror(patch).then(
      () => setError(undefined),
      (e: unknown) => setError({ message: 'mirror.changeFailed', code: errorCode(e) }),
    )

  return (
    <section className="settings-section" aria-labelledby="mirror-title">
      <h2 id="mirror-title" className="visually-hidden">
        {t('mirror.title')}
      </h2>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t(error.message), { code: error.code })}
        </p>
      ) : null}
      {on && status.paused !== null ? (
        <p role="alert" className="settings-error">
          {pausedMessage(status.paused)}
        </p>
      ) : null}
      <SettingsSection icon="settings.mirror" title="mirror.title">
        <SettingsNote>{t('mirror.detail')}</SettingsNote>
        <Setting
          label="mirror.folderLabel"
          description={on ? mirrorSize(status.size, locale) : t('mirror.off')}
        >
          <div className="settings-buttons">
            <button ref={chooseButton} type="button" className="button" onClick={choose}>
              {t('mirror.chooseFolder')}
            </button>
            {on ? (
              <button
                type="button"
                className="button"
                onClick={(event) => {
                  // Turn Off goes as the mirror turns off: the keyboard it had
                  // moves to Choose Folder… rather than to the page.
                  if (event.currentTarget === document.activeElement) chooseButton.current?.focus()
                  void change({ turnOff: true })
                }}
              >
                {t('mirror.turnOff')}
              </button>
            ) : null}
          </div>
        </Setting>
        {on ? (
          <SettingsNote>
            <span className="mirror-folder">{status.folder}</span>
          </SettingsNote>
        ) : null}
        <SettingsNote>{t('mirror.notReadBack')}</SettingsNote>
        <SettingToggle
          label="mirror.includeAttachments"
          description="mirror.includeAttachmentsHint"
          checked={status.includeAttachments}
          onChange={(checked) => void change({ includeAttachments: checked })}
        />
      </SettingsSection>
      {folderChoice.dialog}
    </section>
  )
}
