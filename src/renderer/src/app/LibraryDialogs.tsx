import { lazy, Suspense } from 'react'
import type { BookNode } from '../../../core/books'
import { BackupsDialog } from '../BackupsDialog'
import type { Core } from '../core-client'
import { RestoreSyncChoice } from '../RestoreSyncChoice'
import type { useSheets } from '../sheets'
import type { Selection } from '../Sidebar'
import type { SyncSnapshot } from '../sync'

const ImportDialog = lazy(() =>
  import('../ImportDialog').then((module) => ({ default: module.ImportDialog })),
)

/** Import, Backups, and the choice a restore leaves for sync: the sheets that act on the whole library. */
export function LibraryDialogs({
  sheets,
  tree,
  library,
  editing,
  syncCore,
  syncSnapshot,
}: {
  sheets: ReturnType<typeof useSheets>
  tree: BookNode[]
  library: Selection
  editing: boolean
  /** The core, in the window that runs sync. */
  syncCore: Core | undefined
  syncSnapshot: SyncSnapshot
}) {
  const { importJob, importKey, startImport, closeImport, backupsOpen, restore, closeBackups } =
    sheets
  return (
    <>
      {importJob ? (
        <Suspense fallback={null}>
          <ImportDialog
            key={importKey}
            job={importJob}
            tree={tree}
            initialDestination={library.kind === 'book' ? library.id : null}
            onImport={startImport}
            onClose={closeImport}
          />
        </Suspense>
      ) : null}
      {backupsOpen ? (
        <BackupsDialog onRestore={restore} onClose={closeBackups} readOnly={!editing} />
      ) : null}
      {syncCore ? (
        <RestoreSyncChoice
          snapshot={syncSnapshot}
          onChoose={(choice) => syncCore.syncAfterRestore(choice)}
        />
      ) : null}
    </>
  )
}
