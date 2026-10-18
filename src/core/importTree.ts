// What an import will do, before it writes anything: the picked folders as
// a tree, each with how many notes and images it holds (with its
// subfolders) and how large they are, and which folders become notebooks
// (the rules at the top of import.ts).

import type { ImportKind, ImportScan } from './import'

// No runtime import of import.ts here: the window shows this tree without
// loading the Markdown pipeline.

/** Whether a picked file is HTML (else it is Markdown). */
export const isHtmlFile = (path: string) => /\.html?$/i.test(path)

/**
 * The folder (relative, `/`-separated) whose notebook a note at `path` goes
 * into; `''` is the destination itself (see the rules at the top of import.ts).
 */
export function noteFolder(kind: ImportKind, path: string): string {
  return kind === 'files' ? '' : path.split('/').slice(0, -1).join('/')
}

export interface ImportFolder {
  name: string
  /** Relative to what was picked, with `/`; `''` is the destination. */
  path: string
  /** Whether the import makes a notebook for it. */
  notebook: boolean
  /** Notes in it and its subfolders. */
  notes: number
  /** Images in it and its subfolders. */
  images: number
  /** Bytes of those notes and images. */
  bytes: number
  /** Its subfolders that hold notes or images, by name. */
  folders: ImportFolder[]
}

/** The tree an import of `scan` maps to (see the rules at the top of import.ts). */
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
    const parent = folderAt(cut === -1 ? '' : path.slice(0, cut))
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
    // Picked files are not grouped: they all go to the destination.
    let at: string | null = noteFolder(scan.kind, path)
    while (at !== null) {
      const node = folderAt(at)
      if (note) {
        node.notes += 1
        // A folder with a note under it becomes a notebook.
        if (at !== '') node.notebook = true
      } else node.images += 1
      node.bytes += bytes
      at = at === '' ? null : at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
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
