import type { ImportScan } from '../../core'
import { MAX_FILE_BYTES } from '../../core/files'
import { droppedImport, droppedSource, imageName } from './dropImport'

export interface DropEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  file?: (done: (file: File) => void, fail: () => void) => void
  createReader?: () => {
    readEntries: (done: (entries: DropEntry[]) => void, fail: () => void) => void
  }
}

const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)
const compare = (a: string, b: string) => {
  const left = Array.from(a, (char) => char.codePointAt(0)!)
  const right = Array.from(b, (char) => char.codePointAt(0)!)
  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    if (left[at] !== right[at]) return left[at]! - right[at]!
  }
  return left.length - right.length
}
const readFile = (entry: DropEntry) =>
  new Promise<File>((resolve, reject) => {
    if (!entry.file) {
      reject(new Error('E_IMPORT_UNREADABLE'))
      return
    }
    entry.file(resolve, () => reject(new Error('E_IMPORT_UNREADABLE')))
  })

export async function droppedFolders(
  roots: readonly DropEntry[],
  putFile: Parameters<typeof droppedSource>[1],
  limits = { files: 10_000, entries: 200_000, depth: 64 },
) {
  if (!roots.length) throw new Error('E_IMPORT_ROOT_INVALID')
  const { scan } = droppedImport([], putFile)
  scan.kind = roots.length === 1 ? 'folder' : 'folders'
  scan.name = roots[0]?.name ?? ''
  const byPath = new Map<string, File>()
  const taken = new Set<string>()
  let entries = 0
  const children = async (dir: DropEntry, path: string, settings = false): Promise<DropEntry[]> => {
    const found: DropEntry[] = []
    try {
      const reader = dir.createReader?.()
      if (!reader) throw new Error('E_IMPORT_UNREADABLE')
      for (;;) {
        const batch = await new Promise<DropEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, () => reject(new Error('E_IMPORT_UNREADABLE'))),
        )
        if (batch.length === 0) break
        if (!settings) entries += batch.length
        if (entries > limits.entries) throw new Error('E_IMPORT_FOLDER_TOO_LARGE')
        found.push(...batch)
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'E_IMPORT_FOLDER_TOO_LARGE') throw error
      if (!settings) scan.skipped.push({ path, code: 'E_IMPORT_UNREADABLE' })
      return []
    }
    return found.sort((a, b) => compare(a.name, b.name))
  }
  for (const root of roots) {
    if (!root.isDirectory) throw new Error('E_IMPORT_ROOT_INVALID')
    const name = root.name
    const base = name.replace(/^\.+/, '') || 'Folder'
    let prefix = scan.kind === 'folder' ? '' : base
    let suffix = 1
    while (prefix && taken.has(prefix.toLowerCase())) prefix = `${base} ${++suffix}`
    taken.add(prefix.toLowerCase())
    const top = await children(root, prefix)
    const configDir = top.find((entry) => entry.name === '.obsidian' && entry.isDirectory)
    let vault: NonNullable<ImportScan['vault']>[number] | undefined
    if (configDir) {
      vault = {
        root: prefix,
        attachmentFolderPath: '',
        newLinkFormat: 'shortest',
        useMarkdownLinks: false,
      }
      try {
        const config = (await children(configDir, join(prefix, '.obsidian'), true)).find(
          (entry) => entry.name === 'app.json' && entry.isFile,
        )
        if (config) {
          const file = await readFile(config)
          if (file.size <= 65_536) {
            const value: unknown = JSON.parse(await file.text())
            if (value && typeof value === 'object') {
              const settings = value as Record<string, unknown>
              const path = settings['attachmentFolderPath']
              if (
                typeof path === 'string' &&
                new TextEncoder().encode(path).length <= 4096 &&
                !/\p{Cc}/u.test(path) &&
                !path
                  .split('/')
                  .some((part) => part === '..' || (part.startsWith('.') && part !== '.'))
              )
                vault.attachmentFolderPath = path
              const format = settings['newLinkFormat']
              if (format === 'shortest' || format === 'relative' || format === 'absolute')
                vault.newLinkFormat = format
              if (typeof settings['useMarkdownLinks'] === 'boolean')
                vault.useMarkdownLinks = settings['useMarkdownLinks']
            }
          }
        }
      } catch {
        /* Unreadable settings keep the vault defaults. */
      }
      ;(scan.vault ??= []).push(vault)
    }
    const walk = async (list: DropEntry[], parent: string, depth: number): Promise<void> => {
      for (const entry of list) {
        if (entry.name.startsWith('.')) continue
        const path = join(parent, entry.name)
        if (entry.isDirectory) {
          if (depth + 1 > limits.depth) scan.skipped.push({ path, code: 'E_IMPORT_TOO_DEEP' })
          else await walk(await children(entry, path), path, depth + 1)
        } else if (
          entry.isFile &&
          (/\.md$|\.markdown$/i.test(entry.name) ||
            imageName(entry.name) ||
            (vault && /\.canvas$/i.test(entry.name)))
        ) {
          let file: File
          try {
            file = await readFile(entry)
          } catch {
            scan.skipped.push({ path, code: 'E_IMPORT_UNREADABLE' })
            continue
          }
          if (file.size > MAX_FILE_BYTES) {
            scan.skipped.push({ path, code: 'E_IMPORT_FILE_TOO_LARGE' })
            continue
          }
          byPath.set(path, file)
          const target = imageName(entry.name) ? scan.images : scan.files
          target.push({ path, bytes: file.size })
          if (scan.files.length > limits.files) throw new Error('E_IMPORT_TOO_MANY_FILES')
        }
      }
    }
    await walk(top, prefix, 0)
  }
  for (const list of [scan.files, scan.images, scan.skipped])
    list.sort((a, b) => compare(a.path, b.path))
  return { scan, ...droppedSource(byPath, putFile) }
}
