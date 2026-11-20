import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react'
import type { NoteSummary, TrashedNote } from '../../../core'
import { firstImported, openDestination } from '../cliOpen'
import type { CommandHandlers } from '../commands/registry'
import type { Core } from '../core-client'
import { noteTarget, useDeepLinks, type DeepLink } from '../deepLink'
import { DeepLinkNotice, type DeepLinkProblem } from '../DeepLinkNotice'
import { editorSettings } from '../editorSettings'
import { finishImport } from '../importer'
import { openPluginOffer } from '../plugins/api'
import type { useLicenceLink } from '../LicenceLink'
import type { useSheets } from '../sheets'
import type { Selection } from '../Sidebar'
import { DEFAULT_CHOICES } from '../importChoices'
import { droppedImport } from '../dropImport'
import { droppedFolders } from '../dropFolders'
import { storage } from '../core-client'
import { t } from '../i18n'
import { useStable } from '../stable'
import '../dropImport.css'

/** Links other apps open: a note, a command, today's note, a licence or a folder handed over for import. */
export function useAppDeepLinks({
  ready,
  core,
  coreRef,
  editing,
  commands,
  licenceLink,
  startImport,
  enqueueImport,
  showLibrary,
  showLibraryRef,
  select,
  openTrashed,
  listedSet,
  notes,
  templates,
  trash,
  inTrash,
  library,
}: {
  ready: boolean
  core: Core | undefined
  coreRef: RefObject<Core | undefined>
  editing: boolean
  commands: Partial<CommandHandlers>
  licenceLink: ReturnType<typeof useLicenceLink>
  startImport: ReturnType<typeof useSheets>['startImport']
  enqueueImport: ReturnType<typeof useSheets>['enqueueImport']
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
  library?: Selection
}) {
  const [linkNotice, setLinkNotice] = useState<DeepLinkProblem>()
  const [dragging, setDragging] = useState(false)
  // Hand-offs that arrive close together run one after another, so the second finds the notebook the
  // first made instead of making another with the same name.
  const handoffWork = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const runHandoff = useStable(
    async (
      link: Extract<DeepLink, { kind: 'import' }>,
      input?: Parameters<typeof startImport>[4],
      bookId?: string,
    ) => {
      const c = coreRef.current
      if (!c || !mounted.current) {
        if (input) await input.cleanup()
        else void finishImport(link.scan.id)
        return
      }
      try {
        // The notebooks as storage has them now, not as the last render showed them.
        const listed = await c.listBooks()
        if (!editing) throw new Error('E_LICENCE_REQUIRED')
        const to = openDestination(link.notebook, listed, editorSettings().defaultNotebook)
        const destination =
          bookId && listed.some((b) => b.id === bookId)
            ? bookId
            : to.kind === 'create'
              ? await c.createBook(to.name, null)
              : to.id
        const report = await startImport(link.scan, destination, () => {}, DEFAULT_CHOICES, input)
        if (!mounted.current) return
        const id = report ? firstImported(report.noteIds, link.scan.files, link.first) : undefined
        if (!id) {
          setLinkNotice(input ? 'dropFailed' : 'importFailed')
          return
        }
        if (!report?.bookId) showLibraryRef.current?.({ kind: 'all' }, { clearFilter: true })
        await select(id)
        if (input && report && report.problems.length > 0 && mounted.current)
          setLinkNotice('dropFailed')
      } catch {
        if (input) await input.cleanup()
        else void finishImport(link.scan.id)
        if (mounted.current) setLinkNotice(input ? 'dropFailed' : 'importFailed')
      }
    },
  )
  const importHandedOver = (link: Extract<DeepLink, { kind: 'import' }>) => {
    handoffWork.current = handoffWork.current.then(() => runHandoff(link))
    return handoffWork.current
  }
  const acceptFolder = useStable(
    (input: Awaited<ReturnType<typeof droppedFolders>>, bookId?: string) => {
      if (!mounted.current || !editing) {
        void input.cleanup()
        return
      }
      input.scan.destination = bookId ?? null
      enqueueImport(input.scan, input)
    },
  )
  const handleDrag = useEffectEvent((phase: 'over' | 'drop', event: DragEvent) => {
    const hasFiles = (drag: DragEvent) => drag.dataTransfer?.types.includes('Files')
    const editorImages = (drag: DragEvent) => {
      const editor = drag
        .composedPath()
        .some((target) => target instanceof Element && target.matches('.cm-editor'))
      const data = drag.dataTransfer
      return (
        editor &&
        data &&
        data.items.length > 0 &&
        Array.from(data.items).every(
          (item) => item.kind === 'file' && item.type.startsWith('image/'),
        )
      )
    }
    if (phase === 'over') {
      if (!hasFiles(event)) return
      if (editorImages(event)) {
        setDragging(false)
        return
      }
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = editing ? 'copy' : 'none'
      setDragging(editing)
      return
    } else {
      setDragging(false)
      if (!hasFiles(event) || editorImages(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setLinkNotice(undefined)
      if (!editing) {
        setLinkNotice('commandUnavailable')
        return
      }
      try {
        const items = Array.from(event.dataTransfer?.items ?? [])
        const entries = items.map((item) => item.webkitGetAsEntry?.())
        const directories = entries
          .filter((entry) => entry?.isDirectory)
          .filter((entry) => entry != null)
        const files = items.length
          ? items.flatMap((item, at) => {
              const file = entries[at]?.isDirectory ? null : item.getAsFile()
              return file ? [file] : []
            })
          : Array.from(event.dataTransfer?.files ?? [])
        const bookId = library?.kind === 'book' ? library.id : undefined
        handoffWork.current = handoffWork.current.then(async () => {
          try {
            if (!mounted.current) return
            if (directories.length)
              acceptFolder(
                await droppedFolders(directories, (meta, bytes) => storage.putFile(meta, bytes)),
                bookId,
              )
            if (files.length || !directories.length) {
              const input = droppedImport(files, (meta, bytes) => storage.putFile(meta, bytes))
              await runHandoff(
                {
                  kind: 'import',
                  scan: input.scan,
                  notebook: null,
                  first: input.scan.files[0]?.path ?? null,
                },
                input,
                bookId,
              )
            }
          } catch {
            if (mounted.current) setLinkNotice('dropFailed')
          }
        })
      } catch {
        setLinkNotice('dropFailed')
      }
    }
  })
  useEffect(() => {
    if (!ready) return
    const over = (event: DragEvent) => handleDrag('over', event)
    const drop = (event: DragEvent) => handleDrag('drop', event)
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false)
    }
    const clear = () => setDragging(false)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [ready])
  // Links other apps open (devot://note/<id>, devot://command/<id>), once the window has restored its view; sheets hold them back.
  useDeepLinks(ready, (link) => {
    setLinkNotice(undefined)
    if (link.kind === 'licence') {
      licenceLink.handle(link)
      return
    }
    if (link.kind === 'plugin') {
      void openPluginOffer(link.id).catch(() => setLinkNotice('commandUnavailable'))
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
  return (
    <>
      {dragging && (
        <div className="drop-import" role="status">
          {t('import.dropHint')}
        </div>
      )}
      {linkNotice && (
        <DeepLinkNotice problem={linkNotice} onDismiss={() => setLinkNotice(undefined)} />
      )}
    </>
  )
}
