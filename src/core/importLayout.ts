// How an import names its notebooks and notes and where it puts each note, for folders other apps export in a shape of their own.
// - Notion's Markdown export names every page and folder with its page ID (`Plan 1a2b…32 hex.md`, `Plan 1a2b…/`): the ID is left out of notebook names and
//   titles, and a page with subpages goes into the notebook its subpages' folder becomes.
// - A TextBundle (`Note.textbundle/text.md` with its images in `assets/`, as Bear exports) is one note, in the folder the bundle is in.
// Any other folder is imported as it is laid out. The layout is read from the paths alone, so the import sheet shows the same tree the import makes.

import type { ImportItem, ImportKind } from './import'

export type ImportSourceApp = 'notion' | 'bear' | null

export interface ImportLayout {
  app: ImportSourceApp
  /** The folder whose notebook a note goes into ('' for the destination itself). */
  noteFolder(path: string): string
  /** A folder's notebook name, before it is made file-safe and clipped. */
  folderName(path: string): string
  /** A note's title when its text gives none, before it is made one line and clipped. */
  fileTitle(path: string): string
}

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const stemOf = (name: string) => name.replace(/\.[^.]+$/, '') || name

const NOTION_ID = / [0-9a-f]{32}$/
const BUNDLE_TEXT = /(?:^|\/)[^/]+\.textbundle\/text\.[^/.]+$/i
const BUNDLE = /\.textbundle$/i

const withoutNotionId = (name: string) => name.replace(NOTION_ID, '') || name

export function sourceAppOf(paths: readonly string[]): ImportSourceApp {
  if (paths.length === 0) return null
  if (paths.some((path) => BUNDLE_TEXT.test(path))) return 'bear'
  const named = paths.filter((path) => NOTION_ID.test(stemOf(nameOf(path)))).length
  return named * 2 >= paths.length ? 'notion' : null
}

export function importLayout(kind: ImportKind, files: readonly ImportItem[]): ImportLayout {
  const plain = (path: string) => (kind === 'files' ? '' : folderOf(path))
  const app = sourceAppOf(files.map((file) => file.path))
  if (app === 'bear') {
    const inBundle = (path: string) => BUNDLE_TEXT.test(path)
    return {
      app,
      noteFolder: (path) =>
        inBundle(path) && kind !== 'files' ? folderOf(folderOf(path)) : plain(path),
      folderName: nameOf,
      fileTitle: (path) =>
        inBundle(path) ? nameOf(folderOf(path)).replace(BUNDLE, '') : stemOf(nameOf(path)),
    }
  }
  if (app === 'notion') {
    const folders = new Set<string>()
    for (const file of files) {
      for (let at = folderOf(file.path); at !== ''; at = folderOf(at)) folders.add(at)
    }
    return {
      app,
      noteFolder(path) {
        if (kind === 'files') return ''
        const own = path.replace(/\.[^./]+$/, '')
        return NOTION_ID.test(own) && folders.has(own) ? own : folderOf(path)
      },
      folderName: (path) => withoutNotionId(nameOf(path)),
      fileTitle: (path) => withoutNotionId(stemOf(nameOf(path))),
    }
  }
  return { app, noteFolder: plain, folderName: nameOf, fileTitle: (path) => stemOf(nameOf(path)) }
}
