// Export and print, from the note and notebook context menus (and the
// palette, File > Export > All Notes, and Shift+Cmd+P for Print). The core plans the files and writes
// the Markdown (core/export.ts) and turns the preview into a page
// (core/htmlExport.ts); this module draws the diagrams, styles the page and
// hands everything to Rust (src-tauri/src/export.rs), which shows the
// panels, writes the files and prints.
import { invoke } from './ipc'
import * as Comlink from 'comlink'
import type { Element, Root, RootContent } from 'hast'
import type { ExportPlan, ExportReport, ExportSink, ExportTarget, PageImage } from '../../core'
import { exportName, fileStem, relativeHref } from '../../core/export'
import { htmlDocument, pageBody } from '../../core/htmlExport'
import { errorCode } from './backups'
import type { Core } from './core-client'
import { currentLocale, t } from './i18n'
import type { ExportAction } from './noteMenu'
import contentCss from './preview/content.css?raw'
import { mermaidMarkup } from './preview/mermaid'
import pageCss from './preview/page.css?raw'
import { previewLabels } from './preview/Preview'
import { dark, light, sizes } from './theme/tokens'

/** What a notebook's context menu exports it as (also every note, or chosen notes). */
export type BookExport = 'exportMarkdown' | 'exportHtml'

/**
 * The panel Rust shows for a target: a file for a note, else a folder in
 * which the export makes a folder of its own (`export_begin`'s `notebook`).
 */
export const panelKind = (target: ExportTarget): 'note' | 'notebook' =>
  target.kind === 'note' ? 'note' : 'notebook'

interface Begun {
  id: number
  fileName: string | null
}

/**
 * The page's styles: the design tokens (light, and dark on screens set to
 * dark; printing is always light), the preview's note content rules and
 * the page's own.
 */
export function pageStyles(): string {
  const vars = (values: Readonly<Record<string, string>>, indent: string) =>
    Object.entries(values)
      .map(([key, value]) => `${indent}--${key.replaceAll('.', '-')}: ${value};`)
      .join('\n')
  return [
    `:root {\n${vars(sizes, '  ')}\n${vars(light, '  ')}\n}`,
    `@media screen and (prefers-color-scheme: dark) {\n  :root {\n${vars(dark, '    ')}\n  }\n}`,
    contentCss,
    pageCss,
  ].join('\n\n')
}

/** 32 random hex digits: the placeholders' nonce, new for every page. */
function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** The sources of the diagrams in a preview tree. */
function diagramSources(tree: Root): Set<string> {
  const sources = new Set<string>()
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element') {
      const el: Element = node
      if (el.properties['dataDevotIsland'] === 'mermaid') {
        sources.add(String(el.properties['dataIslandSource'] ?? ''))
      }
    }
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return sources
}

interface Page {
  title: string
  html: string
  images: PageImage[]
}

/**
 * A note as a page: the full document (`simple`: the bare markup without
 * classes or styles; `print`: a page to print, which loads nothing from the
 * web), with the images Rust puts in.
 */
async function notePage(
  core: Core,
  note: { title: string; bodyMd: string },
  options: { simple?: boolean; print?: boolean; noteHref?: (id: string) => string | null } = {},
): Promise<Page> {
  const tree = await core.renderPreview(note.bodyMd, {
    labels: previewLabels(),
    loadedEmbeds: [],
  })
  const drawings = new Map<string, string | null>()
  if (!options.simple) {
    for (const source of diagramSources(tree)) {
      drawings.set(source, await mermaidMarkup(source).catch(() => null))
    }
  }
  const print = options.print ?? false
  const body = pageBody(tree, {
    nonce: nonce(),
    simple: options.simple ?? false,
    print,
    island: (kind, source) => (kind === 'mermaid' ? (drawings.get(source) ?? null) : null),
    ...(options.noteHref ? { noteHref: options.noteHref } : {}),
  })
  const title = note.title || t('note.untitled')
  const html = options.simple
    ? body.html
    : htmlDocument({ title, body: body.html, css: pageStyles(), lang: currentLocale(), print })
  return { title, html, images: body.images }
}

const finish = (id: number) =>
  invoke('export_finish', { id }).catch(() => console.warn('W_EXPORT_FINISH_FAILED', id))

/** Exports a note or a notebook as Markdown files; null when cancelled. */
async function exportMarkdown(core: Core, target: ExportTarget): Promise<ExportReport | null> {
  let session: number | undefined
  const sink: ExportSink = {
    async begin(name) {
      const begun = await invoke<Begun | null>('export_begin', {
        kind: panelKind(target),
        format: 'markdown',
        name,
      })
      if (!begun) return null
      session = begun.id
      return { fileName: begun.fileName }
    },
    attach: (fileId) => invoke<string>('export_attach', { id: session, fileId }),
    write: (path, text) =>
      invoke<null>('export_write', { id: session, path, text, images: [] }).then(() => undefined),
  }
  try {
    return await core.exportMarkdown(target, Comlink.proxy(sink), t('note.untitled'))
  } finally {
    if (session !== undefined) await finish(session)
  }
}

/**
 * Exports a note or a notebook as HTML pages, one per note, each standing
 * alone (images in it); links between exported notes point at their pages.
 * Null when cancelled.
 */
async function exportHtml(core: Core, target: ExportTarget): Promise<ExportReport | null> {
  // A folder whose name is known asks first, before every note is read.
  const known = exportName(target)
  const ask = (name: string) =>
    invoke<Begun | null>('export_begin', { kind: panelKind(target), format: 'html', name })
  const asked = known === null ? undefined : await ask(known)
  if (asked === null) return null
  let plan: ExportPlan
  try {
    plan = await core.planExport(target, t('note.untitled'))
  } catch (error) {
    // The session asked for first ends with the failure.
    if (asked) await finish(asked.id)
    throw error
  }
  const begun = asked ?? (await ask(plan.name))
  if (!begun) return null
  const report: ExportReport = { notes: 0, attachments: 0, problems: [] }
  try {
    const paths = new Map(
      plan.entries.map((entry) => [
        entry.noteId,
        [
          ...entry.folder,
          target.kind === 'note' && begun.fileName ? begun.fileName : `${entry.stem}.html`,
        ],
      ]),
    )
    const attachments = new Set<string>()
    for (const entry of plan.entries) {
      const path = paths.get(entry.noteId)!
      try {
        const page = await notePage(core, entry, {
          noteHref: (id) => {
            const to = paths.get(id)
            return to ? relativeHref(entry.folder, to) : null
          },
        })
        await invoke('export_write', {
          id: begun.id,
          path: path.join('/'),
          text: page.html,
          images: page.images,
        })
        report.notes += 1
        page.images.forEach((image) => attachments.add(image.fileId))
      } catch (error) {
        report.problems.push({ noteId: entry.noteId, code: errorCode(error) })
      }
    }
    report.attachments = attachments.size
  } finally {
    await finish(begun.id)
  }
  return report
}

/**
 * Runs a note's export or print action. Resolves once it is done (or the
 * user cancelled a panel); rejects with the error code of the first problem.
 */
export async function runNoteExport(core: Core, action: ExportAction, noteId: string) {
  let report: ExportReport | null = null
  switch (action) {
    case 'exportMarkdown':
      report = await exportMarkdown(core, { kind: 'note', noteId })
      break
    case 'exportHtml':
      report = await exportHtml(core, { kind: 'note', noteId })
      break
    default: {
      const simple = action === 'copySimpleHtml'
      const print = action === 'print' || action === 'exportPdf'
      const page = await notePage(core, await core.read(noteId), { simple, print })
      const { html, images, title } = page
      if (action === 'copyHtml' || action === 'copySimpleHtml') {
        await invoke('clipboard_write_html', { html, images })
      } else if (action === 'print') {
        await invoke<boolean>('note_print', { title, html, images })
      } else {
        const name = fileStem(title, t('note.untitled'))
        await invoke<boolean>('export_pdf', { name, title, html, images })
      }
    }
  }
  const problem = report?.problems[0]
  if (problem) throw new Error(problem.code)
}

/** Exports a notebook and its sub-notebooks; rejects like `runNoteExport`. */
export const runBookExport = (core: Core, action: BookExport, bookId: string) =>
  runTargetExport(core, action, { kind: 'notebook', bookId })

/**
 * Exports every note (File > Export > All Notes): each top-level notebook a
 * folder, notes in no notebook at the top; rejects like `runNoteExport`.
 */
export const runAllExport = (core: Core, action: BookExport) =>
  runTargetExport(core, action, { kind: 'all', name: t('export.allName') })

/** Exports chosen notes side by side in one folder; rejects like `runNoteExport`. */
export const runSelectionExport = (core: Core, action: BookExport, noteIds: readonly string[]) =>
  runTargetExport(core, action, { kind: 'notes', noteIds, name: t('export.selectionName') })

async function runTargetExport(core: Core, action: BookExport, target: ExportTarget) {
  const report =
    action === 'exportMarkdown'
      ? await exportMarkdown(core, target)
      : await exportHtml(core, target)
  const problem = report?.problems[0]
  if (problem) throw new Error(problem.code)
}
