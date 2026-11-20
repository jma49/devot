import type { ImportScan, ImportSource } from '../../core'
import { checkUpload, MAX_FILE_BYTES, type FileMeta } from '../../core/files'

let nextId = -1
export const importableName = (name: string) => /\.(md|markdown|html?|htm)$/i.test(name)
const imageName = (name: string) => /\.(png|jpe?g|gif|webp|avif|hei[cf])$/i.test(name)

export function droppedImport(
  files: readonly File[],
  putFile: (meta: FileMeta, data: Uint8Array) => Promise<unknown>,
): { scan: ImportScan; source: ImportSource; cleanup: () => Promise<void> } {
  const scan: ImportScan = {
    id: nextId--,
    name: '',
    kind: 'files',
    files: [],
    images: [],
    skipped: [],
  }
  const byPath = new Map<string, File>()
  for (const file of files) {
    const path = file.name.normalize('NFC')
    const code =
      !path ||
      path.startsWith('.') ||
      path.includes('/') ||
      /\p{Cc}/u.test(path) ||
      byPath.has(path)
        ? 'E_IMPORT_PATH_INVALID'
        : !importableName(path) && !imageName(path)
          ? 'E_IMPORT_FILE_TYPE'
          : file.size > MAX_FILE_BYTES
            ? 'E_IMPORT_FILE_TOO_LARGE'
            : null
    if (code) {
      scan.skipped.push({ path, code })
      continue
    }
    if (byPath.size >= 10_000) throw new Error('E_IMPORT_TOO_MANY_FILES')
    byPath.set(path, file)
    const target = importableName(path) ? scan.files : scan.images
    target.push({ path, bytes: file.size })
  }
  const get = (path: string) => {
    const file = byPath.get(path)
    if (!file) throw new Error('E_IMPORT_FILE_NOT_FOUND')
    return file
  }
  return {
    scan,
    source: {
      read: async (path) => get(path).text(),
      attach: async (path, ids) => {
        const file = get(path)
        const meta = {
          ...ids,
          name:
            [...file.name]
              .filter((c) => !/\p{Cc}/u.test(c))
              .slice(0, 200)
              .join('') || 'image',
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        checkUpload(meta, bytes)
        await putFile(meta, bytes)
      },
    },
    cleanup: async () => {
      byPath.clear()
    },
  }
}
