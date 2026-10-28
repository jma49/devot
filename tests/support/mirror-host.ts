// Stand-in for Rust's Markdown mirror (src-tauri/src/mirror.rs) in core tests: the same checks on a real folder,
// with note bodies and attachments read from the test's SQLite database.
import { createHash, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'
import type {
  DiskState,
  MirrorHost,
  MirrorManifest,
  MirrorOp,
  MirrorOpened,
  MirrorResult,
} from '../../src/core/mirror'
import type { SqliteAdapter } from './sqlite-adapter'

export const MANIFEST = '.devot-mirror.json'
const EDITED = ' (edited outside Devot)'

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fail = (code: string) => new Error(code)
/** Whether `error` says a name is taken (Rust's `AlreadyExists`). */
const taken = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'

/** Rust's `atomic_file::Place`. */
type Place = 'new' | 'replace'

/**
 * Rust's `atomic_file::rename`. For `new`, a rename cannot refuse a taken name, so an empty file claims it first
 * (EEXIST on any name, links included); a failed rename releases the claim.
 */
function moveFile(from: string, to: string, place: Place) {
  if (place === 'replace') return renameSync(from, to)
  writeFileSync(to, '', { flag: 'wx' })
  const claimed = lstatSync(to).ino
  try {
    renameSync(from, to)
  } catch (error) {
    if (lstatSync(to, { throwIfNoEntry: false })?.ino === claimed) unlinkSync(to)
    throw error
  }
}

/** Rust's `atomic_file::write_unflushed`: a random hidden temp file created new (never through a link), then put in place. */
function writeThroughTemp(dir: string, path: string, data: string | Buffer, place: Place) {
  const partial = join(dir, `.devot-${randomUUID().replaceAll('-', '')}.tmp`)
  writeFileSync(partial, data, { flag: 'wx' })
  try {
    moveFile(partial, path, place)
  } finally {
    try {
      unlinkSync(partial)
    } catch {
      // Put in place: gone already.
    }
  }
}

/** Rust's `attachment_name`. */
export function attachmentName(stored: string, mime: string): string {
  const cleaned = [...stored]
    .map((c) => (/[\p{Cc}/\\:]/u.test(c) ? '-' : c))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  const dot = cleaned.lastIndexOf('.')
  let stem = cleaned
  let ext =
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/heic': 'heic',
    }[mime] ?? 'bin'
  if (dot > 0 && dot < cleaned.length - 1) {
    stem = cleaned.slice(0, dot)
    ext = cleaned.slice(dot + 1)
  }
  let bytes = 0
  let clipped = ''
  for (const c of stem) {
    bytes += Buffer.byteLength(c)
    if (bytes > 200) break
    clipped += c
  }
  stem = clipped.trim() || 'image'
  return `${stem}.${[...ext].slice(0, 16).join('')}`
}

/** Rust's path check. */
function plain(path: string): boolean {
  if (!path || Buffer.byteLength(path) > 4096) return false
  return path
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        !part.startsWith('.') &&
        Buffer.byteLength(part) <= 255 &&
        !/[\p{Cc}\\:]/u.test(part),
    )
}
const notePath = (path: string) =>
  plain(path) && /\.md$/i.test(path) && path.split('/')[0]!.toLowerCase() !== 'attachments'
const filePath = (path: string) =>
  plain(path) && path.split('/').length === 2 && path.startsWith('attachments/')

export interface FolderHostLog {
  written: string[]
  moved: [string, string][]
  removed: string[]
  /** Paths files were kept under. */
  kept: string[]
}

export interface FolderHost extends MirrorHost {
  log: FolderHostLog
  clear(): void
  manifest(): MirrorManifest
  setFolder(root: string | null): void
  setIncludeAttachments(on: boolean): void
  paused(): string | null
  size(): number
  /** Runs once, right after the next note file moves (a test makes the rewrite fail there). */
  afterMove?: (() => void) | undefined
}

export function folderHost(sqlite: SqliteAdapter, root: string | null): FolderHost {
  let folder = root
  let include = true
  let generation = 1
  let manifest: MirrorManifest | null = null
  // The manifest changed but could not be written back.
  let dirty = false
  let paused: string | null = null
  const log: FolderHostLog = { written: [], moved: [], removed: [], kept: [] }

  const abs = (rel: string) => join(folder!, rel)
  const lstat = (path: string): Stats | null => {
    try {
      return lstatSync(path)
    } catch {
      return null
    }
  }

  /** What is at `rel`; a folder on the way that is a link or a file makes it `other`. */
  const state = (rel: string): DiskState => {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const at = lstat(abs(parts.slice(0, i).join('/')))
      if (!at) return null
      if (!at.isDirectory() || at.isSymbolicLink()) return 'other'
    }
    const at = lstat(abs(rel))
    if (!at) return null
    if (at.isSymbolicLink()) return 'other'
    if (at.isDirectory()) return 'dir'
    if (!at.isFile()) return 'other'
    return sha(readFileSync(abs(rel)))
  }

  const sameFile = (a: string, b: string) => {
    const x = lstat(abs(a))
    const y = lstat(abs(b))
    return !!x && !!y && x.ino === y.ino && x.dev === y.dev
  }

  /** Writes `data` at `rel`: a new file only where nothing is yet, or over Devot's own. */
  const writeFile = (rel: string, data: string | Buffer, place: Place) => {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    writeThroughTemp(join(folder!, dir), abs(rel), data, place)
  }

  /** What is in the way of a write or move to `rel`. */
  const inTheWayAt = (rel: string, error: unknown): MirrorResult => {
    if (taken(error)) return { code: 'E_MIRROR_EXISTS', path: rel, state: state(rel) }
    throw error
  }

  const inTheWay = (rel: string): MirrorResult | null => {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/')
      const at = lstat(abs(sub))
      if (!at) return null
      if (!at.isDirectory() || at.isSymbolicLink()) {
        return { code: 'E_MIRROR_EXISTS', path: sub, state: state(sub) }
      }
    }
    return null
  }

  const makeFolders = (rel: string): MirrorResult | null => {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/')
      const at = lstat(abs(sub))
      if (!at) mkdirSync(abs(sub))
      else if (!at.isDirectory() || at.isSymbolicLink()) {
        return { code: 'E_MIRROR_EXISTS', path: sub, state: state(sub) }
      }
    }
    return null
  }

  const prune = (rel: string) => {
    const parts = rel.split('/').slice(0, -1)
    while (parts.length > 0) {
      const at = lstat(abs(parts.join('/')))
      if (!at?.isDirectory() || at.isSymbolicLink()) return
      try {
        rmdirSync(abs(parts.join('/')))
      } catch {
        return
      }
      parts.pop()
    }
  }

  /** Renames a file changed outside Devot to a free "edited outside Devot" name. */
  const keepAside = (rel: string): string => {
    const slash = rel.lastIndexOf('/')
    const dir = slash < 0 ? '' : rel.slice(0, slash + 1)
    const name = rel.slice(slash + 1)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let n = 1; n < 1000; n += 1) {
      const kept = `${dir}${stem}${EDITED}${n === 1 ? '' : ` ${n}`}${ext}`
      // Only to a name nothing holds: one taken is passed over, never replaced.
      try {
        moveFile(abs(rel), abs(kept), 'new')
      } catch (error) {
        if (taken(error)) continue
        throw error
      }
      log.kept.push(kept)
      return kept
    }
    throw fail('E_MIRROR_NAME_TAKEN')
  }

  const manifestText = () => JSON.stringify({ version: 1, ...manifest })
  const save = () => writeFile(MANIFEST, manifestText(), 'replace')

  /** Rust's `probe_writable`. */
  const probe = (dir: string) => {
    const name = join(dir, `.devot-${randomUUID().replaceAll('-', '')}.tmp`)
    writeFileSync(name, '', { flag: 'wx' })
    unlinkSync(name)
  }

  const writable = () => {
    try {
      probe(folder!)
      return true
    } catch {
      return false
    }
  }

  const runOp = (m: MirrorManifest, op: MirrorOp): MirrorResult => {
    switch (op.kind) {
      case 'keep': {
        const entry = op.entry === 'note' ? m.notes[op.id] : m.files[op.id]
        if (!entry || entry.path !== op.path || entry.sha256 === null) {
          return { code: 'E_MIRROR_STALE' }
        }
        const now = state(op.path)
        // Unchanged after all: nothing to keep; the plan learns it.
        if (now !== null && now === entry.sha256) {
          return { code: 'E_MIRROR_CHANGED', path: op.path, state: now }
        }
        const result: MirrorResult = {}
        if (now !== null && now !== 'dir' && now !== 'other') result.kept = keepAside(op.path)
        if (op.entry === 'note') delete m.notes[op.id]
        else delete m.files[op.id]
        return result
      }
      case 'forget':
        if (op.entry === 'note') delete m.notes[op.id]
        else delete m.files[op.id]
        return {}
      case 'remove': {
        const entry = op.entry === 'note' ? m.notes[op.id] : m.files[op.id]
        if (!entry || entry.path !== op.path || entry.sha256 !== op.sha256) {
          return { code: 'E_MIRROR_STALE' }
        }
        const now = state(op.path)
        if (now !== null && now !== 'dir' && now !== 'other') {
          if (now !== op.sha256) return { code: 'E_MIRROR_CHANGED', path: op.path, state: now }
          unlinkSync(abs(op.path))
          log.removed.push(op.path)
          prune(op.path)
        }
        if (op.entry === 'note') delete m.notes[op.id]
        else delete m.files[op.id]
        return {}
      }
      case 'note': {
        if (
          !notePath(op.path) ||
          (op.from !== null && !notePath(op.from)) ||
          !/^[0-9a-f]{64}$/.test(op.sha256) ||
          (op.text !== undefined && sha(op.text) !== op.sha256)
        ) {
          return { code: 'E_MIRROR_OP_INVALID' }
        }
        const entry = m.notes[op.id]
        let from: string | null = null
        let fromState: DiskState = null
        if (op.from !== null) {
          if (!entry || entry.path !== op.from) return { code: 'E_MIRROR_STALE' }
          fromState = state(op.from)
          if (fromState !== null) {
            if (fromState !== entry.sha256 && fromState !== op.sha256) {
              return { code: 'E_MIRROR_CHANGED', path: op.from, state: fromState }
            }
            from = op.from
          }
        } else if (entry) {
          const old = state(entry.path)
          if (old !== null) return { code: 'E_MIRROR_CHANGED', path: entry.path, state: old }
        }
        const record = (size: number): MirrorResult => {
          m.notes[op.id] = {
            path: op.path,
            sha256: op.sha256,
            size,
            source: op.source,
            files: op.files,
          }
          return { size }
        }
        if (from !== null && from === op.path) {
          if (fromState === op.sha256) return record(lstat(abs(op.path))!.size)
          if (op.text === undefined) {
            return { code: 'E_MIRROR_CHANGED', path: op.path, state: fromState }
          }
          writeFile(op.path, op.text, 'replace')
          log.written.push(op.path)
          return record(Buffer.byteLength(op.text))
        }
        const blockedAt = inTheWay(op.path)
        if (blockedAt) return blockedAt
        const target = state(op.path)
        // The same file under another case of its name.
        const renamed = target !== null && from !== null && sameFile(from, op.path)
        let adopt = false
        let finishMove = false
        if (target !== null && !renamed) {
          if (target === op.sha256) adopt = true
          // A move cut short before the manifest was saved: what Devot last wrote went here.
          else if (from === null && entry?.sha256 === target) finishMove = true
          else return { code: 'E_MIRROR_EXISTS', path: op.path, state: target }
        }
        // Without the text only a file that holds it already can go there; checked before anything changes.
        const holdsIt = adopt || (from !== null && fromState === op.sha256)
        if (op.text === undefined && !holdsIt) {
          return { code: 'E_MIRROR_CHANGED', path: op.from ?? op.path, state: fromState }
        }
        const blocked = makeFolders(op.path)
        if (blocked) return blocked
        if (adopt) {
          if (from !== null) {
            unlinkSync(abs(from))
            log.removed.push(from)
            prune(from)
          }
          return record(lstat(abs(op.path))!.size)
        }
        if (from === null) {
          if (op.text === undefined) return { code: 'E_MIRROR_CHANGED', path: op.path, state: null }
          try {
            writeFile(op.path, op.text, finishMove ? 'replace' : 'new')
          } catch (error) {
            return inTheWayAt(op.path, error)
          }
          log.written.push(op.path)
          return record(Buffer.byteLength(op.text))
        }
        try {
          moveFile(abs(from), abs(op.path), renamed ? 'replace' : 'new')
        } catch (error) {
          return inTheWayAt(op.path, error)
        }
        log.moved.push([from, op.path])
        prune(from)
        if (fromState === op.sha256) return record(lstat(abs(op.path))!.size)
        // Listed where it went, with what it holds, should its new text fail.
        m.notes[op.id] = {
          ...entry!,
          path: op.path,
          sha256: fromState!,
          size: lstat(abs(op.path))!.size,
        }
        if (op.text === undefined) {
          return { code: 'E_MIRROR_CHANGED', path: op.path, state: null, moved: true }
        }
        const hook = host.afterMove
        host.afterMove = undefined
        hook?.()
        // Moved: Devot's own file is there now, and its new text goes over it.
        try {
          writeFile(op.path, op.text, 'replace')
        } catch (error) {
          throw Object.assign(error as object, { moved: true })
        }
        log.written.push(op.path)
        return record(Buffer.byteLength(op.text))
      }
      case 'file': {
        if (!filePath(op.path)) return { code: 'E_MIRROR_OP_INVALID' }
        const entry = m.files[op.id]
        if (entry?.sha256 != null && state(entry.path) === entry.sha256) {
          return { code: 'E_MIRROR_STALE' }
        }
        if (!op.copy) {
          m.files[op.id] = { path: op.path, sha256: null, size: 0 }
          return { size: 0, sha256: null }
        }
        const row = sqlite.db.prepare('SELECT data FROM files WHERE id = ?').get(op.id) as
          | { data: Buffer }
          | undefined
        if (!row) return { code: 'E_FILE_NOT_FOUND' }
        const data = Buffer.from(row.data)
        const hash = sha(data)
        const blockedAt = inTheWay(op.path)
        if (blockedAt) return blockedAt
        const target = state(op.path)
        if (target !== null && target !== hash) {
          return { code: 'E_MIRROR_EXISTS', path: op.path, state: target }
        }
        if (target === null) {
          const blocked = makeFolders(op.path)
          if (blocked) return blocked
          try {
            writeFile(op.path, data, 'new')
          } catch (error) {
            return inTheWayAt(op.path, error)
          }
          log.written.push(op.path)
        }
        m.files[op.id] = { path: op.path, sha256: hash, size: data.length }
        return { size: data.length, sha256: hash }
      }
      case 'book':
        if (op.path === null) delete m.books[op.id]
        else if (!plain(op.path)) return { code: 'E_MIRROR_OP_INVALID' }
        else m.books[op.id] = op.path
        return {}
    }
  }

  const host: FolderHost = {
    log,
    clear() {
      log.written.length = 0
      log.moved.length = 0
      log.removed.length = 0
      log.kept.length = 0
    },
    manifest: () => clone(manifest ?? { notes: {}, files: {}, books: {} }),
    setFolder(next) {
      folder = next
      manifest = null
      paused = null
      generation += 1
    },
    setIncludeAttachments(on) {
      include = on
      generation += 1
    },
    paused: () => paused,
    size() {
      const m = manifest ?? { notes: {}, files: {}, books: {} }
      return [...Object.values(m.notes), ...Object.values(m.files)].reduce(
        (sum, e) => sum + (e.sha256 === null ? 0 : e.size),
        0,
      )
    },

    async open(known): Promise<MirrorOpened> {
      if (folder === null) throw fail('E_MIRROR_OFF')
      const pause = (code: string) => {
        paused = code
        return fail(code)
      }
      const top = lstat(folder)
      if (!top?.isDirectory()) throw pause('E_MIRROR_FOLDER_MISSING')
      if (paused !== null) {
        generation += 1
        if (dirty && manifest !== null) {
          // The last batch is only in memory: it goes back first.
          try {
            save()
          } catch {
            throw pause('E_MIRROR_FOLDER_READ_ONLY')
          }
          dirty = false
        } else {
          manifest = null
        }
      }
      if (manifest === null) {
        let text: string | null = null
        try {
          text = readFileSync(join(folder, MANIFEST), 'utf8')
        } catch {
          text = null
        }
        let fresh = false
        if (text === null) {
          if (readdirSync(folder).some((n) => n !== '.DS_Store')) {
            throw pause('E_MIRROR_MANIFEST_MISSING')
          }
          fresh = true
        } else {
          try {
            const read = JSON.parse(text) as MirrorManifest
            manifest = { notes: read.notes, files: read.files, books: read.books }
          } catch {
            throw pause('E_MIRROR_MANIFEST_INVALID')
          }
        }
        try {
          probe(folder)
        } catch {
          manifest = null
          throw pause('E_MIRROR_FOLDER_READ_ONLY')
        }
        if (fresh) {
          manifest = { notes: {}, files: {}, books: {} }
          // Only while the folder still has none (one that appeared stays).
          try {
            writeFile(MANIFEST, manifestText(), 'new')
          } catch (error) {
            manifest = null
            if (taken(error)) throw fail('E_MIRROR_STALE')
            throw pause('E_MIRROR_FOLDER_READ_ONLY')
          }
        }
      }
      paused = null
      return {
        generation,
        includeAttachments: include,
        manifest: known === generation ? null : clone(manifest),
      }
    },

    async bodies(ids) {
      return ids.flatMap((id) => {
        const row = sqlite.db
          .prepare(
            'SELECT body_md FROM notes WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL',
          )
          .get(id) as { body_md: string } | undefined
        return row ? [{ id, bodyMd: row.body_md }] : []
      })
    },

    async files(ids) {
      return ids.flatMap((id) => {
        const row = sqlite.db.prepare('SELECT name, mime FROM files WHERE id = ?').get(id) as
          | { name: string; mime: string }
          | undefined
        return row ? [{ id, name: attachmentName(row.name, row.mime) }] : []
      })
    },

    async hashes(ids) {
      return ids.flatMap((id) => {
        const row = sqlite.db.prepare('SELECT data FROM files WHERE id = ?').get(id) as
          | { data: Buffer }
          | undefined
        return row ? [{ id, sha256: sha(Buffer.from(row.data)) }] : []
      })
    },

    async check(gen, paths) {
      if (gen !== generation || manifest === null) throw fail('E_MIRROR_STALE')
      const out: Record<string, DiskState> = {}
      if (paths === null) {
        for (const entry of [...Object.values(manifest.notes), ...Object.values(manifest.files)]) {
          if (entry.sha256 === null) continue
          const now = state(entry.path)
          if (now !== entry.sha256) out[entry.path] = now
        }
        return out
      }
      for (const path of paths) {
        if (!plain(path)) throw fail('E_MIRROR_PATH_INVALID')
        out[path] = state(path)
      }
      return out
    },

    async apply(gen, ops) {
      if (gen !== generation || manifest === null) throw fail('E_MIRROR_STALE')
      if (!lstat(folder!)?.isDirectory()) {
        paused = 'E_MIRROR_FOLDER_MISSING'
        throw fail(paused)
      }
      const results: MirrorResult[] = []
      let changed = dirty
      for (const op of ops) {
        let result: MirrorResult
        try {
          result = runOp(manifest, op)
        } catch (error) {
          const { code, moved } = error as { code?: string; moved?: boolean }
          result = {
            code: !lstat(folder!)
              ? 'E_MIRROR_FOLDER_MISSING'
              : (code === 'EACCES' || code === 'EPERM') && !writable()
                ? 'E_MIRROR_FOLDER_READ_ONLY'
                : 'E_MIRROR_WRITE_FAILED',
            ...(moved ? { moved } : {}),
          }
        }
        changed ||= result.code === undefined || result.moved === true
        results.push(result)
        if (result.code?.startsWith('E_MIRROR_FOLDER_')) {
          paused = result.code
          break
        }
      }
      if (changed) {
        try {
          save()
          dirty = false
        } catch {
          dirty = true
          paused ??= lstat(folder!) ? 'E_MIRROR_FOLDER_READ_ONLY' : 'E_MIRROR_FOLDER_MISSING'
        }
      }
      return results
    },
  }
  return host
}
