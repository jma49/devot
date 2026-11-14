import { useRef, useState, type RefObject } from 'react'
import type { NoteSummary, TrashedNote } from '../../../core'
import { firstImported, openDestination } from '../cliOpen'
import type { CommandHandlers } from '../commands/registry'
import type { Core } from '../core-client'
import { noteTarget, useDeepLinks, type DeepLink } from '../deepLink'
import { DeepLinkNotice, type DeepLinkProblem } from '../DeepLinkNotice'
import { editorSettings } from '../editorSettings'
import { finishImport } from '../importer'
import type { useLicenceLink } from '../LicenceLink'
import type { useSheets } from '../sheets'
import type { Selection } from '../Sidebar'
import { DEFAULT_CHOICES } from '../importChoices'

/** Links other apps open: a note, a command, today's note, a licence or a folder handed over for import. */
export function useAppDeepLinks({
  ready,
  core,
  coreRef,
  editing,
  commands,
  licenceLink,
  startImport,
  showLibrary,
  showLibraryRef,
  select,
  openTrashed,
  listedSet,
  notes,
  templates,
  trash,
  inTrash,
}: {
  ready: boolean
  core: Core | undefined
  coreRef: RefObject<Core | undefined>
  editing: boolean
  commands: Partial<CommandHandlers>
  licenceLink: ReturnType<typeof useLicenceLink>
  startImport: ReturnType<typeof useSheets>['startImport']
  showLibrary: (next: Selection, options?: { clearFilter?: boolean }) => void
  showLibraryRef: RefObject<
    ((next: Selection, options?: { clearFilter?: boolean }) => void) | undefined
  >
  select: (id: string) => Promise<boolean>
  openTrashed: (id: string) => void
  listedSet: ReadonlySet<string>
  notes: NoteSummary[]
  templates: NoteSummary[]
  trash: TrashedNote[]
  inTrash: boolean
}) {
  const [linkNotice, setLinkNotice] = useState<DeepLinkProblem>()
  // Hand-offs that arrive close together run one after another, so the second finds the notebook the
  // first made instead of making another with the same name.
  const handoffWork = useRef<Promise<void>>(Promise.resolve())
  const runHandoff = async (link: Extract<DeepLink, { kind: 'import' }>) => {
    const c = coreRef.current
    if (!c) {
      void finishImport(link.scan.id)
      return
    }
    try {
      // The notebooks as storage has them now, not as the last render showed them.
      const listed = await c.listBooks()
      const to = openDestination(link.notebook, listed, editorSettings().defaultNotebook)
      const destination = to.kind === 'create' ? await c.createBook(to.name, null) : to.id
      const report = await startImport(link.scan, destination, () => {}, DEFAULT_CHOICES)
      const id = report ? firstImported(report.noteIds, link.scan.files, link.first) : undefined
      if (!id) {
        setLinkNotice('importFailed')
        return
      }
      if (!report?.bookId) showLibraryRef.current?.({ kind: 'all' }, { clearFilter: true })
      void select(id)
    } catch {
      void finishImport(link.scan.id)
      setLinkNotice('importFailed')
    }
  }
  const importHandedOver = (link: Extract<DeepLink, { kind: 'import' }>) => {
    handoffWork.current = handoffWork.current.then(() => runHandoff(link))
    return handoffWork.current
  }
  // Links other apps open (devot://note/<id>, devot://command/<id>), once the window has restored its view; sheets hold them back.
  useDeepLinks(ready, (link) => {
    setLinkNotice(undefined)
    if (link.kind === 'licence') {
      licenceLink.handle(link)
      return
    }
    if (link.kind === 'import') {
      if (editing) void importHandedOver(link)
      else setLinkNotice('commandUnavailable')
      return
    }
    if (link.kind === 'today') {
      const handler = commands['note.today']
      if (handler) return Promise.resolve(handler.run())
      setLinkNotice('commandUnavailable')
      return
    }
    if (link.kind === 'command') {
      const handler = commands[link.id]
      if (handler) void handler.run()
      else setLinkNotice('commandUnavailable')
      return
    }
    const id = link.id
    const target = noteTarget(id, {
      listed: listedSet,
      notes,
      templates,
      trash,
    })
    if (target.kind === 'missing') {
      // Not in the lists (yet: another writer may have made it a moment
      // ago, before the window took the change in): ask the core.
      core?.title(id).then(
        () => {
          showLibraryRef.current?.({ kind: 'all' }, { clearFilter: true })
          void select(id)
        },
        () => setLinkNotice('noteNotFound'),
      )
      return
    }
    if (target.kind === 'trash') {
      if (!inTrash) showLibrary({ kind: 'trash' })
      openTrashed(id)
      return
    }
    if (target.kind === 'library') showLibrary({ kind: target.library }, { clearFilter: true })
    void select(id)
  })
  return linkNotice ? (
    <DeepLinkNotice problem={linkNotice} onDismiss={() => setLinkNotice(undefined)} />
  ) : null
}
