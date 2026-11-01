// What an import will do, before it writes anything: the picked folders as a tree with note and image counts and sizes, and which folders become notebooks
// (the rules at the top of import.ts).

import type { ImportKind, ImportScan } from './import'

// No runtime import of import.ts here: the window shows this tree without loading the Markdown pipeline.

export const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

export const isHtmlFile = (path: string) => /\.html?$/i.test(path)

export function noteFolder(kind: ImportKind, path: string): string {
  return kind === 'files' ? '' : folderOf(path)
}

export interface ImportFolder {
  name: string
  path: string
  notebook: boolean
  notes: number
  images: number
  bytes: number
  folders: ImportFolder[]
}

export function importTree(scan: ImportScan): ImportFolder {
  const root: ImportFolder = {
    name: scan.name,
    path: '',
    notebook: false,
    notes: 0,
    images: 0,
    bytes: 0,
    folders: [],
  }
  const byPath = new Map<string, ImportFolder>([['', root]])
  const folderAt = (path: string): ImportFolder => {
    const known = byPath.get(path)
    if (known) return known
    const cut = path.lastIndexOf('/')
    const parent = folderAt(folderOf(path))
    const made: ImportFolder = {
      name: path.slice(cut + 1),
      path,
      notebook: false,
      notes: 0,
      images: 0,
      bytes: 0,
      folders: [],
    }
    parent.folders.push(made)
    byPath.set(path, made)
    return made
  }
  const add = (path: string, bytes: number, note: boolean) => {
    let at: string | null = noteFolder(scan.kind, path)
    while (at !== null) {
      const node = folderAt(at)
      if (note) {
        node.notes += 1
        if (at !== '') node.notebook = true
      } else node.images += 1
      node.bytes += bytes
      at = at === '' ? null : folderOf(at)
    }
  }
  for (const file of scan.files) add(file.path, file.bytes, true)
  for (const image of scan.images) add(image.path, image.bytes, false)
  const sort = (node: ImportFolder) => {
    node.folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    node.folders.forEach(sort)
  }
  sort(root)
  return root
}

export function notebookCount(folder: ImportFolder): number {
  return folder.folders.reduce(
    (count, child) => count + notebookCount(child),
    folder.notebook ? 1 : 0,
  )
}
