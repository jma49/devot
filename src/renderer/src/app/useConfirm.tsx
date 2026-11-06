import { useState, type Dispatch, type SetStateAction } from 'react'
import { ConfirmDialog } from '../ConfirmDialog'
import { bookDeleteDetail, noteCount } from '../format'
import { currentLocale, format, t } from '../i18n'
import type { ListSelection } from '../listSelection'
import type { LibraryChanges } from './useLibraryChanges'

/** A permanent delete waiting for the user to confirm it. */
export type Confirm =
  | { kind: 'empty' }
  | { kind: 'one'; id: string; title: string }
  | { kind: 'many'; ids: readonly string[] }
  | { kind: 'tag'; id: string; name: string; count: number }
  | { kind: 'savedSearch'; id: string; name: string }
  | { kind: 'book'; id: string; name: string; subs: number; notes: number }

export function useConfirm({
  trash,
  libraryChanges,
  setMulti,
  setSelected,
}: {
  trash: readonly unknown[]
  libraryChanges: LibraryChanges
  setMulti: (selection: ListSelection | undefined) => void
  setSelected: Dispatch<SetStateAction<string | undefined>>
}) {
  const { changeBooks, deleteBook, runBatch } = libraryChanges
  const [confirm, setConfirm] = useState<Confirm>()
  const runConfirmed = async () => {
    const pending = confirm
    setConfirm(undefined)
    if (!pending) return
    if (pending.kind === 'tag') return void (await changeBooks((c) => c.deleteTag(pending.id)))
    if (pending.kind === 'savedSearch') {
      return void (await changeBooks((c) => c.deleteSavedSearch(pending.id)))
    }
    if (pending.kind === 'book') return void (await deleteBook(pending.id))
    if (pending.kind === 'many') {
      await runBatch(pending.ids, { kind: 'purge' })
      setMulti(undefined)
      return setSelected(undefined)
    }
    await changeBooks((c) => (pending.kind === 'empty' ? c.emptyTrash() : c.purge(pending.id)))
    setSelected(undefined)
  }
  const dialog =
    confirm?.kind === 'savedSearch' ? (
      <ConfirmDialog
        destructive
        message={format(t('savedSearch.confirmDelete'), { name: confirm.name })}
        detail={t('savedSearch.deleteDetail')}
        confirm={t('savedSearchMenu.delete')}
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(undefined)}
      />
    ) : confirm?.kind === 'tag' ? (
      <ConfirmDialog
        destructive
        message={format(t('tag.confirmDelete'), { name: confirm.name })}
        detail={format(t('tag.deleteDetail'), {
          notes: noteCount(confirm.count, currentLocale()),
        })}
        confirm={t('tagMenu.delete')}
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(undefined)}
      />
    ) : confirm?.kind === 'book' ? (
      <ConfirmDialog
        destructive
        message={format(t('book.confirmDelete'), { name: confirm.name })}
        detail={bookDeleteDetail(confirm.subs, confirm.notes)}
        confirm={t('bookMenu.delete')}
        confirmFirst
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(undefined)}
      />
    ) : confirm ? (
      <ConfirmDialog
        destructive
        message={
          confirm.kind === 'empty'
            ? format(t('trash.confirmEmpty'), {
                notes: noteCount(trash.length, currentLocale()),
              })
            : confirm.kind === 'many'
              ? format(t('trash.confirmMany'), {
                  notes: noteCount(confirm.ids.length, currentLocale()),
                })
              : format(t('trash.confirmOne'), { title: confirm.title })
        }
        detail={t('trash.cannotUndo')}
        confirm={confirm.kind === 'empty' ? t('trash.empty') : t('trash.deleteForever')}

        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirm(undefined)}
      />
    ) : null
  return { setConfirm, dialog }
}
