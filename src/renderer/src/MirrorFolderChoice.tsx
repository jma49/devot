// Choosing the Markdown mirror's folder, from Settings or the palette: the
// folder panel over the window, and the confirmation a folder that is not
// empty (and has no manifest) needs before the mirror uses it.
import { useCallback, useState, type ReactNode } from 'react'
import { errorCode } from './backups'
import { ConfirmDialog } from './ConfirmDialog'
import { format, t } from './i18n'
import { chooseMirrorFolder, confirmMirrorFolder } from './mirror'

export interface MirrorFolderChoice {
  choose: () => Promise<void>
  dialog: ReactNode
}

export function useMirrorFolderChoice(failed: (code: string) => void): MirrorFolderChoice {
  const [confirming, setConfirming] = useState<{ token: number; name: string }>()

  const choose = useCallback(async () => {
    try {
      const choice = await chooseMirrorFolder()
      if (choice.kind === 'confirm') setConfirming({ token: choice.token, name: choice.name })
    } catch (error) {
      console.warn('W_MIRROR_CHOOSE_FAILED', errorCode(error))
      failed(errorCode(error))
    }
  }, [failed])

  const dialog = confirming ? (
    <ConfirmDialog
      message={format(t('mirror.confirm'), { name: confirming.name })}
      detail={t('mirror.confirmDetail')}
      confirm={t('mirror.confirmUse')}
      onConfirm={() => {
        const { token } = confirming
        setConfirming(undefined)
        confirmMirrorFolder(token).catch((error: unknown) => failed(errorCode(error)))
      }}
      onCancel={() => setConfirming(undefined)}
    />
  ) : null

  return { choose, dialog }
}
