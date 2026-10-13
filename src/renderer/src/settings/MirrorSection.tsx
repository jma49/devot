import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { SettingsFlag } from './controls'

/**
 * Settings > Markdown Mirror: the folder Devot keeps up to date with every
 * note as a Markdown file (off by default). Choose Folder… shows the folder
 * panel; a folder that is not empty is used only once the user agrees. On,
 * it shows the folder, the size of the files Devot wrote there (once Rust has
 * read the folder's manifest) and Turn Off; Include Attachments says whether
 * images are copied there. The folder is
 * written by Devot and never read back, which the section says. Changes made
 * elsewhere (the palette) show here as they happen.
 */
export function MirrorSection() {
  const status = useMirrorStatus()
  const [error, setError] = useState<{ message: MessageKey; code: string }>()
  const chooseFailed = useCallback(
    (code: string) => setError({ message: 'mirror.chooseFailed', code }),
    [],
  )
  const folderChoice = useMirrorFolderChoice(chooseFailed)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const hint = `${useId()}-attachments-hint`
  const locale = currentLocale()
  const on = status.folder !== null

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
      <h2 id="mirror-title">{t('mirror.title')}</h2>
      <p>{t('mirror.detail')}</p>
      <p>{t('mirror.notReadBack')}</p>
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
      {on ? (
        <>
          <p className="mirror-folder">
            {format(t('mirror.folder'), { folder: status.folder ?? '' })}
          </p>
          {status.size === null ? null : (
            <p>{format(t('mirror.size'), { size: fileSize(status.size, locale) })}</p>
          )}
        </>
      ) : (
        <p>{t('mirror.off')}</p>
      )}
      <SettingsFlag
        label="mirror.includeAttachments"
        checked={status.includeAttachments}
        hint={{ id: hint, text: 'mirror.includeAttachmentsHint' }}
        onChange={(checked) => void change({ includeAttachments: checked })}
      />
      <div className="settings-actions">
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
      {folderChoice.dialog}
    </section>
  )
}
