import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import type { ImportKind, ImportProblem, ImportReport, ImportScan } from '../../core'
// Imported directly (not through the core index) so the main bundle does not
// pull in the Markdown pipeline.
import { importTree, isHtmlFile, type ImportFolder } from '../../core/importTree'
import type { BookNode } from '../../core/books'
import { bookOptions, filterBooks, NO_BOOK, type BookOption } from './BookPicker'
import { countOf, fileSize, noteCount } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { useScanFound } from './importProgress'
import { importReason } from './importReasons'
import { fieldStep } from './Picker'

export interface ImportJob {
  id: number | null
  name: string
  kind: ImportKind
  scan: ImportScan | null
  failed: string | null
}

type Stage =
  | { kind: 'review' }
  | { kind: 'destination' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done'; report: ImportReport | null }
  | { kind: 'failed'; code: string }

const optionId = (i: number) => `import-destination-${i}`

function titleKey(job: ImportJob): MessageKey {
  if (job.kind === 'folders') return 'import.title.folders'
  if (job.kind === 'folder') return 'import.title'
  const paths = [
    ...(job.scan?.files ?? []).map((f) => f.path),
    ...(job.scan?.skipped ?? []).map((p) => p.path),
  ]
  return paths.some(isHtmlFile) ? 'import.title.html' : 'import.title.markdown'
}

function Problems(props: { problems: ImportProblem[]; title: MessageKey }) {
  if (props.problems.length === 0) return null
  return (
    <>
      <h3 id="import-problems" className="import-problems-title">
        {t(props.title)}
      </h3>
      <ul className="import-problems" aria-labelledby="import-problems">
        {props.problems.map((p, i) => {
          const reason = importReason(p.code)
          return (
            <li key={`${p.path}:${p.image ?? ''}:${i}`} className="import-problem">
              <span className="import-path">
                {p.path}
                {p.image ? <span className="import-image">{p.image}</span> : null}
              </span>
              <span className="import-reason">
                {reason
                  ? format(t('import.reasonWithCode'), { reason: t(reason), code: p.code })
                  : format(t('import.reason.other'), { code: p.code })}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function summaryKey(report: ImportReport): MessageKey {
  if (report.books === 0) {
    return report.attachments > 0 ? 'import.summaryNoBooksWithImages' : 'import.summaryNoBooks'
  }
  return report.attachments > 0 ? 'import.summaryWithImages' : 'import.summary'
}

function folderCounts(node: ImportFolder, locale: string) {
  return format(t('import.folderCounts'), {
    files: countOf(node.notes, locale, 'import.markdownOne', 'import.markdownOther'),
    images: countOf(node.images, locale, 'import.imageCountOne', 'import.imageCountOther'),
    size: fileSize(node.bytes, locale),
  })
}

function FolderRows(props: { nodes: ImportFolder[]; depth: number; locale: string }) {
  return (
    <>
      {props.nodes.map((node) => (
        <li key={node.path} className="import-folder">
          <div
            className="import-folder-row"
            style={{ '--import-depth': props.depth } as CSSProperties}
          >
            <span className="import-folder-name">{node.name}</span>
            {node.notebook ? (
              <span className="import-badge">{t('import.notebookBadge')}</span>
            ) : null}
            <span className="import-folder-counts">{folderCounts(node, props.locale)}</span>
          </div>
          {node.folders.length > 0 ? (
            <ul className="import-tree-group">
              <FolderRows nodes={node.folders} depth={props.depth + 1} locale={props.locale} />
            </ul>
          ) : null}
        </li>
      ))}
    </>
  )
}

function Preview(props: { scan: ImportScan; locale: string }) {
  const root = useMemo(() => importTree(props.scan), [props.scan])
  const { scan, locale } = props
  return (
    <>
      <p className="sheet-detail import-summary">
        {format(t('import.found'), {
          files: countOf(root.notes, locale, 'import.markdownOne', 'import.markdownOther'),
          images: countOf(root.images, locale, 'import.imageCountOne', 'import.imageCountOther'),
          size: fileSize(root.bytes, locale),
        })}
      </p>
      <p className="sheet-detail import-mapping">
        {t(scan.kind === 'folders' ? 'import.mapping.folders' : 'import.mapping.folder')}
      </p>
      <ul aria-label={t('import.treeLabel')} className="import-tree">
        <FolderRows
          nodes={scan.kind === 'folders' ? root.folders : [root]}
          depth={0}
          locale={locale}
        />
      </ul>
      <Problems problems={scan.skipped} title="import.willSkip" />
    </>
  )
}

function destinationOptions(tree: BookNode[]): BookOption[] {
  return [
    { id: NO_BOOK, name: t('note.noBook'), depth: 0, ancestors: [], icon: null, iconColor: null },
    ...bookOptions(tree),
  ]
}

/** The notebook the import goes into. The filter (`query`) is the sheet's, so it knows whether the choice is shown: one the filter hides is never imported into. */
function Destination(props: {
  all: BookOption[]
  query: string
  onQuery: (query: string) => void
  value: string
  onChange: (id: string) => void
  onSubmit: () => void
}) {
  const { all, query } = props
  const matches = filterBooks(all, query)
  const index = matches.findIndex((o) => o.id === props.value)

  useEffect(() => {
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return
    const next = fieldStep(e.key, index, matches.length)
    if (next !== undefined) {
      e.preventDefault()
      const chosen = next >= 0 ? matches[next] : undefined
      if (chosen) props.onChange(chosen.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      props.onSubmit()
    }
  }

  return (
    <>
      <input
        className="pick-filter"
        type="text"
        role="combobox"
        aria-label={t('import.destinationFilter')}
        placeholder={t('import.destinationFilter')}
        aria-expanded="true"
        aria-controls="import-destinations"
        aria-autocomplete="list"
        aria-activedescendant={index >= 0 ? optionId(index) : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(e) => {
          props.onQuery(e.target.value)
          // The choice stays while it matches; else the first match is chosen.
          const left = filterBooks(all, e.target.value)
          if (left[0] && !left.some((o) => o.id === props.value)) props.onChange(left[0].id)
        }}
        onKeyDown={onKeyDown}
      />
      <ul
        id="import-destinations"
        className="pick-list"
        role="listbox"
        aria-label={t('import.destination')}
      >
        {matches.map((o, i) => (
          <li
            key={o.id || 'none'}
            id={optionId(i)}
            className="pick-row"
            role="option"
            aria-selected={o.id === props.value}
            style={{ paddingInlineStart: `calc(var(--space-4) + ${o.depth} * var(--space-7))` }}
            onClick={() => props.onChange(o.id)}
            onDoubleClick={props.onSubmit}
          >
            <span className="pick-name">{o.name}</span>
            {o.id === props.value ? <Icon name="check" size="sm" /> : null}
          </li>
        ))}
      </ul>
      {matches.length === 0 ? <p className="sheet-detail">{t('moveNote.noMatches')}</p> : null}
    </>
  )
}

export function resultCounts(report: ImportReport, skipped: number) {
  const later = report.problems.slice(skipped)
  const stopped = later.filter((p) => p.code === 'E_IMPORT_STOPPED').length
  const failed = new Set(
    later.filter((p) => p.code !== 'E_IMPORT_STOPPED' && !p.image).map((p) => p.path),
  ).size
  return { imported: report.notes, skipped: skipped + stopped, failed }
}

/**
 * The import sheet, one step at a time: the scan with its progress (it can
 * be cancelled), what it found as a tree, the notebook to import into,
 * then the import with its progress and its result. Nothing is written
 * before Import is pressed; Cancel ends the session at any step before
 * that. Picked files skip the tree. An import started from a notebook's
 * menu (`scan.destination`) skips choosing a notebook: a folder's tree
 * offers Import into that notebook, and picked files import at once. Give
 * each job its own `key`.
 */
export function ImportDialog(props: {
  job: ImportJob
  tree: BookNode[]
  initialDestination: string | null
  onImport: (
    scan: ImportScan,
    destination: string | null,
    onProgress: (done: number, total: number) => void,
  ) => Promise<ImportReport | null>
  onClose: (cancelled: boolean) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { job } = props
  const locale = currentLocale()
  const [stage, setStage] = useState<Stage>({ kind: 'review' })
  const [destination, setDestination] = useState(() =>
    props.initialDestination !== null &&
    bookOptions(props.tree).some((o) => o.id === props.initialDestination)
      ? props.initialDestination
      : NO_BOOK,
  )
  const [query, setQuery] = useState('')
  const all = useMemo(() => destinationOptions(props.tree), [props.tree])
  // Import goes only into a destination the filter shows.
  const chosenShown = filterBooks(all, query).some((o) => o.id === destination)
  const found = useScanFound(job.id)
  const closed = useRef(false)
  const close = (cancelled: boolean) => {
    if (closed.current) return
    closed.current = true
    props.onClose(cancelled)
  }
  const finished = stage.kind === 'done' || stage.kind === 'failed'
  const cancel = () => close(!finished)

  // Closing it (not only removing it) gives the keyboard back to what had it.
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const scan = job.scan
  const files = scan?.files.length ?? 0
  // Started from a notebook's menu: it goes there, with no notebook to
  // choose (unless that notebook has gone meanwhile).
  const presetId = scan?.destination ?? null
  const preset = useMemo(
    () => (presetId === null ? undefined : bookOptions(props.tree).find((o) => o.id === presetId)),
    [presetId, props.tree],
  )
  // Picked files come with their scan, so whether they import at once is
  // settled when the sheet opens (the notebook going later changes nothing).
  const [autoInto] = useState(() =>
    scan?.kind === 'files' && files > 0 && preset ? preset.id : undefined,
  )
  const autoStart = autoInto !== undefined
  // Picked files have no tree to look at: they start at the destination,
  // or straight away into the notebook they were picked for.
  const step =
    stage.kind === 'review' && scan && scan.kind === 'files' && files > 0
      ? autoStart
        ? ({ kind: 'running', done: 0, total: files } as const)
        : ({ kind: 'destination' } as const)
      : stage
  const running = step.kind === 'running'

  const started = useRef(false)
  const launch = (from: ImportScan, chosen: string | null) => {
    started.current = true
    const progress = (done: number, total: number) =>
      setStage((s) =>
        s.kind === 'done' || s.kind === 'failed' ? s : { kind: 'running', done, total },
      )
    props.onImport(from, chosen, progress).then(
      (report) => setStage({ kind: 'done', report }),
      (e: unknown) =>
        setStage({ kind: 'failed', code: e instanceof Error ? e.message : 'E_IMPORT_FAILED' }),
    )
  }
  const start = () => {
    if (!scan || files === 0 || started.current) return
    if (!preset && !chosenShown) return
    setStage({ kind: 'running', done: 0, total: files })
    launch(scan, preset ? preset.id : destination === NO_BOOK ? null : destination)
  }

  // Picked files for a notebook import as soon as the sheet shows them (the
  // step already shows them running).
  const launchNow = useEffectEvent(launch)
  useEffect(() => {
    if (autoInto !== undefined && scan && !started.current) launchNow(scan, autoInto)
  }, [autoInto, scan])

  let content
  let actions
  const cancelButton = (
    <button type="button" className="button" onClick={cancel}>
      {t('dialog.cancel')}
    </button>
  )
  const doneButton = (
    <button type="button" className="button button-default" onClick={cancel} autoFocus>
      {t('import.done')}
    </button>
  )
  if (job.failed !== null && step.kind !== 'running' && step.kind !== 'done') {
    const reason = importReason(job.failed)
    content = (
      <>
        <p role="alert" className="sheet-error">
          {format(t('import.failed'), { code: job.failed })}
        </p>
        {reason ? <p className="sheet-detail">{t(reason)}</p> : null}
      </>
    )
    actions = doneButton
  } else if (!scan) {
    content = (
      <>
        <p className="sheet-detail">{format(t('import.scanning'), { name: job.name })}</p>
        <progress className="import-progress" aria-label={t('import.scanLabel')} />
        <p className="sheet-detail import-count" aria-live="polite">
          {format(t('import.scanFound'), {
            files: countOf(found.files, locale, 'import.markdownOne', 'import.markdownOther'),
            images: countOf(found.images, locale, 'import.imageCountOne', 'import.imageCountOther'),
          })}
        </p>
      </>
    )
    actions = cancelButton
  } else if (step.kind === 'review') {
    if (files === 0) {
      content = (
        <>
          <p className="sheet-detail">{format(t('import.empty'), { name: scan.name })}</p>
          <Problems problems={scan.skipped} title="import.willSkip" />
        </>
      )
      actions = doneButton
    } else {
      content = <Preview scan={scan} locale={locale} />
      actions = (
        <>
          {cancelButton}
          {preset ? (
            <button type="button" className="button button-default" onClick={start} autoFocus>
              {format(t('import.importInto'), { name: preset.name })}
            </button>
          ) : (
            <button
              type="button"
              className="button button-default"
              onClick={() => setStage({ kind: 'destination' })}
              autoFocus
            >
              {t('import.continue')}
            </button>
          )}
        </>
      )
    }
  } else if (step.kind === 'destination') {
    content = (
      <>
        <p className="sheet-detail">
          {format(t('import.destinationDetail'), { notes: noteCount(files, locale) })}
        </p>
        <Destination
          all={all}
          query={query}
          onQuery={setQuery}
          value={destination}
          onChange={setDestination}
          onSubmit={start}
        />
        {scan.kind === 'files' ? (
          <Problems problems={scan.skipped} title="import.willSkip" />
        ) : null}
      </>
    )
    actions = (
      <>
        {scan.kind === 'files' ? null : (
          <button type="button" className="button" onClick={() => setStage({ kind: 'review' })}>
            {t('import.back')}
          </button>
        )}
        {cancelButton}
        <button
          type="button"
          className="button button-default"
          onClick={start}
          disabled={!chosenShown}
        >
          {t('import.import')}
        </button>
      </>
    )
  } else if (step.kind === 'running') {
    content = (
      <>
        <p className="sheet-detail">{format(t('import.running'), { name: scan.name })}</p>
        <progress
          className="import-progress"
          aria-label={t('import.progressLabel')}
          max={Math.max(step.total, 1)}
          value={step.done}
        />
        <p className="sheet-detail import-count">
          {format(t('import.progress'), {
            done: new Intl.NumberFormat(locale).format(step.done),
            files: countOf(step.total, locale, 'import.filesOne', 'import.filesOther'),
          })}
        </p>
      </>
    )
    actions = null
  } else if (step.kind === 'failed') {
    const reason = importReason(step.code)
    content = (
      <>
        <p role="alert" className="sheet-error">
          {format(t('import.failed'), { code: step.code })}
        </p>
        {reason ? <p className="sheet-detail">{t(reason)}</p> : null}
      </>
    )
    actions = doneButton
  } else if (step.report === null) {
    content = (
      <>
        <p className="sheet-detail">{format(t('import.empty'), { name: scan.name })}</p>
        <Problems problems={scan.skipped} title="import.problems" />
      </>
    )
    actions = doneButton
  } else {
    const { report } = step
    const counts = resultCounts(report, scan.skipped.length)
    content = (
      <>
        <p className="sheet-detail import-summary">
          {format(t(summaryKey(report)), {
            notes: noteCount(report.notes, locale),
            books: countOf(report.books, locale, 'import.booksOne', 'import.booksOther'),
            images: countOf(report.attachments, locale, 'import.imagesOne', 'import.imagesOther'),
          })}
        </p>
        <p className="sheet-detail import-counts">
          {format(t('import.counts'), {
            imported: new Intl.NumberFormat(locale).format(counts.imported),
            skipped: new Intl.NumberFormat(locale).format(counts.skipped),
            failed: new Intl.NumberFormat(locale).format(counts.failed),
          })}
        </p>
        <Problems problems={report.problems} title="import.problems" />
      </>
    )
    actions = doneButton
  }

  return (
    <dialog
      ref={dialog}
      className="sheet import"
      aria-labelledby="import-title"
      aria-busy={running || !scan}
      onCancel={(e) => {
        e.preventDefault()
        if (!running) cancel()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row
      // and closes the dialog itself: reopen it while importing.
      onClose={() => {
        // Closed by the window going away (see the layout effect): it is gone.
        if (!dialog.current || dialog.current.open) return
        if (running) dialog.current.showModal()
        else cancel()
      }}
    >
      <h2 id="import-title" className="sheet-title">
        {t(titleKey(job))}
      </h2>
      {content}
      {actions ? <div className="confirm-actions">{actions}</div> : null}
    </dialog>
  )
}
