// better-sqlite3 implementation of the core StorageAdapter, used by devot-mcp
// and by the tests. Its SQL matches the Rust store (src-tauri/src/storage),
// and it applies the same migration files, bundled in at build time.
/// <reference types="vite/client" />

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import type { AiStorage } from '../core/ai'
import { checkUpload } from '../core/files'
import { noteLinks } from '../core/links'
import { checkNote } from '../core/noteLimits'
import { isNotebookSymbol } from '../core/notebookIcons'
import {
  bodyExcerpt,
  excerptTerms,
  foldText,
  ftsQuery,
  indexable,
  scanFolding,
} from '../core/search'
import type { SyncEntry, SyncLocal, SyncStore } from '../core/sync/store'
import { isTagColor } from '../core/tags'
import type {
  ActivityData,
  ActivityNote,
  ActivityRevision,
  AgentWriteSummary,
  BookRecord,
  CompactableVersion,
  NoteTagRecord,
  NoteQuery,
  NoteRecord,
  NoteStatus,
  NoteSummary,
  RevisionKind,
  RevisionRecord,
  RevisionSummary,
  StorageAdapter,
  TagRecord,
  TextCondition,
  TrashedNote,
} from '../core/storage'

/**
 * The text a search field looks in. With ranked text, a body is read from
 * the note's row only once the note has come out of the ranked matches
 * (`ranked`, by rank), so only the bodies of the matches up to a page of
 * results are read; otherwise from the row the list's index points to.
 */
const textColumn = (field: TextCondition['field'], ranked: boolean) => {
  const body = ranked ? '(SELECT body_md FROM notes b WHERE b.rowid = n.rid)' : 'n.body_md'
  return field === 'title' ? 'n.title' : field === 'body' ? body : `n.title || char(10) || ${body}`
}

/**
 * The clause for text too short for the trigram index: it scans the field's
 * text, folded as the index folds case (`devot_fold`, see `scanFolding`
 * for the cheaper ways that find the same), the title and the body apart
 * when the text has no line break (only such text could run from the title
 * into the body). The Rust store's `scan_clause` builds the same.
 */
const scanClause = (t: TextCondition, ranked: boolean, value: string) => {
  const folding = scanFolding(t.value)
  const columns =
    t.field === 'any' && !t.value.includes('\n')
      ? [textColumn('title', ranked), textColumn('body', ranked)]
      : [textColumn(t.field, ranked)]
  // The Kelvin sign matters only to a term with a k.
  const kelvin = /k/i.test(t.value)
  const found = columns.map((c) =>
    folding === 'none'
      ? `instr(${c}, ${value}) > 0`
      : folding === 'ascii'
        ? `instr(lower(${kelvin ? `replace(${c}, char(8490), 'k')` : c}), lower(${value})) > 0`
        : `instr(devot_fold(${c}), devot_fold(${value})) > 0`,
  )
  const any = found.length > 1 ? `(${found.join(' OR ')})` : found[0]!
  return t.negate ? `NOT ${any}` : any
}

const files = import.meta.glob<string>('../../src-tauri/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const migrations = Object.keys(files)
  .filter((f) => /\/\d{4}_[^/]+\.sql$/.test(f))
  .sort()
  .map((f) => files[f]!)

/** The schema version a fully migrated database reports. */
export const SCHEMA_VERSION = migrations.length

/**
 * What the activity heatmap reads (listActivity), with `@since`; the same
 * statements as the Rust store (storage/mod.rs, list_activity). Each reads
 * a covering index of migration 0012, never a table row (rows hold Yjs
 * states): only what falls in the window, and for each body version the
 * one before it (versions are ordered by time, then length, then rowid).
 */
export const ACTIVITY_SQL = {
  notes: `SELECT id, created_at AS createdAt FROM notes INDEXED BY notes_created
     WHERE purged_at IS NULL AND created_at >= @since`,
  revisions: `SELECT r.note_id AS noteId, r.kind, r.at, r.length,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.length FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.rowid DESC LIMIT 1)
            END AS previous
     FROM revisions r INDEXED BY revisions_by_time
     WHERE r.at >= @since AND r.kind IN ('body', 'title')
       AND (r.kind = 'title' OR r.value IS NULL)`,
  /** The same, for the notes in `@ids` (a JSON array) only: each note's versions from `@since` on, from migration 0013's revisions_history. */
  noteRevisions: `SELECT r.note_id AS noteId, r.kind, r.at, r.length,
            CASE WHEN r.kind = 'body' THEN
              (SELECT p.length FROM revisions p INDEXED BY revisions_activity
                WHERE p.note_id = r.note_id AND p.kind = 'body'
                  AND (p.at, p.length, p.rowid) < (r.at, r.length, r.rowid)
                ORDER BY p.at DESC, p.length DESC, p.rowid DESC LIMIT 1)
            END AS previous
     FROM revisions r INDEXED BY revisions_history
     WHERE r.note_id IN (SELECT value FROM json_each(@ids)) AND r.at >= @since
       AND r.kind IN ('body', 'title') AND (r.kind = 'title' OR r.value IS NULL)`,
} as const

/**
 * The agent_writes index (docs/adr/0007-authorship-by-yjs-item-ids.md), the
 * same statements as the Rust store's (storage/mod.rs; a test compares them).
 * A note's rows are replaced with each write that carries them, keeping
 * `seen` of the rows it still has. The list keeps every unseen row, however
 * old, so a note whose writes are all older than the newest `limit` still
 * shows its mark, its unseen count and its notice.
 */
export const AGENT_WRITES_SQL = {
  keep: `DELETE FROM agent_writes
     WHERE note_id = @noteId AND write_id NOT IN (SELECT value FROM json_each(@ids))`,
  put: `INSERT INTO agent_writes (note_id, write_id, kind, name, at, created, seen)
     VALUES (@noteId, @writeId, @kind, @name, @at, @created, @kind = 'aiEdit')
     ON CONFLICT (note_id, write_id) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, at = excluded.at, created = excluded.created`,
  list: `SELECT w.note_id AS noteId, w.write_id AS writeId, w.kind, w.name, w.at, w.created, w.seen
     FROM agent_writes w JOIN notes n ON n.id = w.note_id
     WHERE w.seen = 0 AND n.deleted_at IS NULL AND n.purged_at IS NULL
     UNION ALL
     SELECT w.note_id, w.write_id, w.kind, w.name, w.at, w.created, w.seen
     FROM (SELECT x.at, x.note_id, x.write_id FROM agent_writes x JOIN notes m ON m.id = x.note_id
       WHERE m.deleted_at IS NULL AND m.purged_at IS NULL
       ORDER BY x.at DESC, x.note_id, x.write_id LIMIT @limit) t
     JOIN agent_writes w ON w.note_id = t.note_id AND w.write_id = t.write_id AND w.seen = 1
     JOIN notes n ON n.id = w.note_id AND n.deleted_at IS NULL AND n.purged_at IS NULL
     ORDER BY at DESC, noteId, writeId`,
  authored: `SELECT DISTINCT w.note_id FROM agent_writes w
     JOIN notes n ON n.id = w.note_id
     WHERE n.deleted_at IS NULL AND n.purged_at IS NULL`,
  seen: `UPDATE agent_writes SET seen = 1
     WHERE note_id = @noteId AND seen = 0 AND write_id IN (SELECT value FROM json_each(@ids))`,
  purge: `DELETE FROM agent_writes WHERE note_id = @noteId`,
} as const

/**
 * Revision history and its compaction (src/core/revisions.ts), the same
 * statements as the Rust store's (storage/mod.rs; a test compares them).
 * The reads go through covering indexes (migration 0013's
 * revisions_history, and revisions_by_time), never a version's Yjs state.
 */
export const REVISION_SQL = {
  /** A note's revisions, newest first. */
  history: `SELECT id, note_id, kind, at, length, value FROM revisions
     WHERE note_id = @noteId ORDER BY at DESC, id DESC`,
  /**
   * The plain body versions (a baseline is kept, so left out) of the first
   * `@limit` notes, by ID after `@after`, with one taken at or after `@from`
   * and before `@to`, and more than one taken before `@to`; by note, newest
   * first. Only the window's versions are scanned, and each such note's.
   */
  compactable: `SELECT note_id AS noteId, id, at FROM revisions INDEXED BY revisions_history
     WHERE kind = 'body' AND value IS NULL AND note_id IN (
       SELECT w.note_id FROM (
         SELECT DISTINCT note_id FROM revisions INDEXED BY revisions_by_time
          WHERE at >= @from AND at < @to AND kind = 'body' AND value IS NULL
            AND note_id > @after) w
        WHERE (SELECT COUNT(*) FROM revisions p INDEXED BY revisions_history
                WHERE p.note_id = w.note_id AND p.at < @to
                  AND p.kind = 'body' AND p.value IS NULL) > 1
        ORDER BY w.note_id LIMIT @limit)
     ORDER BY note_id, at DESC, id DESC`,
  /** Deletes one plain body version; never an event or a baseline. */
  compactDrop: `DELETE FROM revisions WHERE id = @id AND kind = 'body' AND value IS NULL`,
  /** Records when the last sweep ran. */
  compactSwept: `INSERT INTO compaction (id, swept_at) VALUES (1, @at)
     ON CONFLICT (id) DO UPDATE SET swept_at = excluded.swept_at`,
  /** When the last sweep ran. */
  lastCompaction: `SELECT swept_at AS sweptAt FROM compaction WHERE id = 1`,
} as const

/**
 * What sync keeps beside the notes (schema v19), the same statements as the
 * Rust store's (storage/sync.rs; a test compares them).
 */
export const SYNC_SQL = {
  /** Records written since the engine last looked, by ID, from the partial index sync_pending. */
  pending: `SELECT id FROM sync_records WHERE edits <> synced AND id > @after ORDER BY id LIMIT @limit`,
  pendingCount: `SELECT COUNT(*) AS n FROM sync_records WHERE edits <> synced`,
  entry: `SELECT id, kind, version, fingerprint, body_hlc AS bodyHlc, body_fp AS bodyFp, edits, synced
     FROM sync_records WHERE id = @id`,
  /** Keeps `edits`, which only storage's triggers move on. */
  put: `INSERT INTO sync_records (id, kind, version, fingerprint, body_hlc, body_fp, synced)
     VALUES (@id, @kind, @version, @fingerprint, @bodyHlc, @bodyFp, @synced)
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, version = excluded.version,
       fingerprint = excluded.fingerprint, body_hlc = excluded.body_hlc,
       body_fp = excluded.body_fp, synced = excluded.synced`,
  state: `SELECT key, value FROM sync_state`,
  setState: `INSERT INTO sync_state (key, value) VALUES (@key, @value)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  /** A new vault epoch: nothing is on the relay, and every record is pending. */
  reset: `UPDATE sync_records SET version = 0, fingerprint = '', synced = edits - 1`,
  /** The note's row as stored, trashed or purged. */
  note: `SELECT *, purged_at IS NOT NULL AS purged FROM notes WHERE id = @id`,
  noteTags: `SELECT note_id AS noteId, tag_id AS tagId, present, hlc FROM note_tags
     WHERE note_id = @id ORDER BY tag_id`,
  book: `SELECT * FROM books WHERE id = @id`,
  tag: `SELECT * FROM tags WHERE id = @id`,
} as const

/**
 * The note list and the Trash, the same statements as the Rust store's
 * (storage/mod.rs; a test compares them). Each reads an index that covers it
 * (migration 0014), never a note's row: a note's small columns come after
 * its Markdown and its Yjs state, so reading them from the row walks every
 * overflow page of both.
 */
export const LIST_SQL = {
  /** Live notes, most recently updated first. */
  notes: `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, book_id AS bookId, status, pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = notes.id AND nt.present = 1) AS tagIds
     FROM notes INDEXED BY notes_list
     WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
  /** Notes in the Trash (not purged), most recently deleted first. */
  trash: `SELECT id, title, deleted_at AS deletedAt, book_id AS bookId FROM notes INDEXED BY notes_trash
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at DESC, id DESC`,
} as const

/**
 * A search as SQL, the same as the Rust store builds (storage/mod.rs,
 * search_sql): every condition is one clause of a WHERE, so the limit
 * applies after all of them. Live notes come from the list's index
 * (notes_list), never from their rows: ranked text matches the trigram
 * index first (`hits`, with each match's rank), and the list's index joins
 * them, through an index SQLite builds for the query. So a ranked search
 * walks the whole list index even for one match (O(notes), about 2.5 ms
 * for 50,000 notes): letting the matches drive the join would read each
 * match's row through its blobs, which costs twice as much once a word is
 * in many notes (see list-cost.test.ts). Text under three characters is
 * scanned: it reads bodies. With ranked text, the matches meeting every
 * other condition are put in rank order first (`ranked`), and the scan
 * reads them in that order, which also gives the results' order: so it
 * stops once a page of results is full, instead of reading the body of
 * every match (#48). Ties go to the newer note, then by ID, as the note
 * list orders them.
 */
export function searchStatement(
  query: NoteQuery,
  limit: number,
): { sql: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = { limit }
  const param = (value: string) => {
    const name = `p${Object.keys(params).length}`
    params[name] = value
    return `@${name}`
  }
  const ranked = query.text.filter((t) => !t.negate && indexable(t.value))
  const where = ['n.deleted_at IS NULL', 'n.purged_at IS NULL']
  const scans: string[] = []
  for (const t of query.text) {
    if (indexable(t.value)) {
      if (t.negate) {
        where.push(
          `n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ${param(ftsQuery([t]))})`,
        )
      }
    } else {
      scans.push(scanClause(t, ranked.length > 0, param(t.value)))
    }
  }
  for (const set of query.sets) {
    const ids = `(SELECT value FROM json_each(${param(JSON.stringify(set.ids))}))`
    if (set.kind === 'book') {
      where.push(
        set.negate ? `(n.book_id IS NULL OR n.book_id NOT IN ${ids})` : `n.book_id IN ${ids}`,
      )
    } else if (set.kind === 'status') {
      where.push(`n.status ${set.negate ? 'NOT IN' : 'IN'} ${ids}`)
    } else {
      where.push(
        `${set.negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM note_tags nt
           WHERE nt.note_id = n.id AND nt.present = 1 AND nt.tag_id IN ${ids})`,
      )
    }
  }
  if (query.pinned != null) where.push(query.pinned ? 'n.pinned = 1' : 'n.pinned = 0')
  const hits = ranked.length
    ? `WITH hits AS MATERIALIZED (SELECT rowid AS rid, bm25(notes_fts) AS score
          FROM notes_fts WHERE notes_fts MATCH ${param(ftsQuery(ranked))})`
    : ''
  // Ranked text and a scan: the matches meeting every other condition, in
  // rank order. The scan reads them in that order and stops at a page only
  // because SQLite keeps a MATERIALIZED CTE's order and uses it for the
  // same ORDER BY outside (the results stay right if it did not, only
  // slower; list-cost.test.ts checks the plan and how many bodies are read).
  const early = hits !== '' && scans.length > 0
  const select = `SELECT n.id, n.title, n.created_at AS createdAt, n.updated_at AS updatedAt, n.book_id AS bookId, n.status, n.pinned,
            (SELECT group_concat(nt.tag_id) FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
              WHERE nt.note_id = n.id AND nt.present = 1) AS tagIds`
  const source = early
    ? `${hits},
        ranked AS MATERIALIZED (SELECT n.rowid AS rid, h.score, n.id, n.title, n.created_at,
            n.updated_at, n.book_id, n.status, n.pinned
          FROM notes n INDEXED BY notes_list JOIN hits h ON h.rid = n.rowid
          WHERE ${where.join('\n  AND ')}
          ORDER BY h.score, n.updated_at DESC, n.id DESC)
     ${select} FROM ranked n`
    : `${hits} ${select} FROM notes n INDEXED BY notes_list${hits ? ' JOIN hits h ON h.rid = n.rowid' : ''}`
  const conditions = early ? scans : [...where, ...scans]
  const sql = [
    source,
    `WHERE ${conditions.join('\n  AND ')}`,
    `ORDER BY ${hits ? `${early ? 'n' : 'h'}.score, ` : ''}n.updated_at DESC, n.id DESC`,
    'LIMIT @limit',
  ].join('\n')
  return { sql, params }
}

/**
 * Run when a note (`@id`) is purged, before its attachments are deleted:
 * gives each attachment of the note that another note, not purged, still
 * shows (its Markdown holds the address `devot://file/<id>`) to that note, a
 * live one before one in the Trash, then the smallest ID. A link can reach
 * another note without a copy (cut or dragged Markdown, Paste as Plain Text,
 * devot-mcp, a restored version, an old duplicate), and its image must stay.
 * The search index finds those notes (a phrase match, so no note is read
 * whole); it ignores case, so `instr` checks the address as written. The
 * same statement as the Rust store's (storage/mod.rs, HAND_OVER_FILES_SQL;
 * a test compares them).
 */
export const HAND_OVER_FILES_SQL = `UPDATE files SET note_id = COALESCE((
       SELECT n.id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH 'body_md : "devot://file/' || replace(files.id, '"', '""') || '"'
          AND n.purged_at IS NULL AND n.id <> files.note_id
          AND instr(n.body_md, 'devot://file/' || files.id) > 0
        ORDER BY n.deleted_at IS NOT NULL, n.id LIMIT 1), note_id)
     WHERE note_id = @id`

interface Row {
  id: string
  title: string
  title_hlc: string
  body_md: string
  ydoc: Buffer
  body_version: number
  created_at: number
  updated_at: number
  book_id: string | null
  book_hlc: string
  status: NoteStatus
  status_hlc: string
  pinned: number
  pinned_hlc: string
  deleted_at: number | null
  deleted_hlc: string | null
  dates_hlc: string
}

interface SummaryRow {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  bookId: string | null
  status: NoteStatus
  pinned: number
  tagIds: string | null
}

interface RevisionRow {
  id: string
  note_id: string
  kind: RevisionKind
  at: number
  ydoc: Buffer | null
  length: number | null
  value: string | null
}

const toRevision = (row: RevisionRow): RevisionRecord => ({
  id: row.id,
  noteId: row.note_id,
  kind: row.kind,
  at: row.at,
  ydoc: row.ydoc === null ? null : new Uint8Array(row.ydoc),
  length: row.length,
  value: row.value,
})

interface TagRow {
  id: string
  name: string
  name_hlc: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  deleted_hlc: string | null
  color: string | null
  color_hlc: string
}

interface NoteTagRow {
  note_id: string
  tag_id: string
  present: number
  hlc: string
}

interface BookRow {
  id: string
  name: string
  name_hlc: string
  parent_id: string | null
  parent_hlc: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  deleted_hlc: string | null
  ai_access: number
  ai_access_hlc: string
  sort_key: string
  sort_key_hlc: string
  icon: string | null
  icon_color: string | null
  icon_hlc: string
}

const toNote = (row: Row): NoteRecord => ({
  id: row.id,
  title: row.title,
  titleHlc: row.title_hlc,
  bodyMd: row.body_md,
  ydoc: new Uint8Array(row.ydoc),
  bodyVersion: row.body_version,
  bookId: row.book_id,
  bookHlc: row.book_hlc,
  status: row.status,
  statusHlc: row.status_hlc,
  pinned: row.pinned === 1,
  pinnedHlc: row.pinned_hlc,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  deletedHlc: row.deleted_hlc,
  datesHlc: row.dates_hlc,
})

const toBook = (row: BookRow, raw = false): BookRecord => ({
  id: row.id,
  name: row.name,
  nameHlc: row.name_hlc,
  parentId: row.parent_id,
  parentHlc: row.parent_hlc,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  deletedHlc: row.deleted_hlc,
  aiAccess: row.ai_access === 1,
  aiAccessHlc: row.ai_access_hlc,
  sortKey: row.sort_key,
  sortKeyHlc: row.sort_key_hlc,
  // A name or palette ID from a later version reads as unset, as in Rust; sync reads it as stored.
  icon: raw || isNotebookSymbol(row.icon) ? row.icon : null,
  iconColor: raw || isTagColor(row.icon_color) ? (row.icon_color as BookRecord['iconColor']) : null,
  iconHlc: row.icon_hlc,
})

const toTag = (row: TagRow, raw = false): TagRecord => ({
  id: row.id,
  name: row.name,
  nameHlc: row.name_hlc,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  deletedHlc: row.deleted_hlc,
  color: raw || isTagColor(row.color) ? (row.color as TagRecord['color']) : null,
  colorHlc: row.color_hlc,
})

export interface SqliteAdapter extends StorageAdapter, AiStorage, SyncStore {
  close(): void
  db: Database.Database
  /** The schema version the database reports now. */
  schemaVersion(): number
  /**
   * Runs `work` in one transaction: every write it makes lands together or
   * not at all. Calls run one after another.
   */
  atomically<T>(work: () => Promise<T>): Promise<T>
}

export interface OpenOptions {
  /**
   * Brings an older schema up to date (the default). Without it, a database
   * whose schema is not exactly this build's is refused, and a missing file
   * is not created: devot-mcp leaves both to the app.
   */
  migrate?: boolean
}

/** The code for a failed open: an addon this Node cannot load is not a wrong path. */
export function openFailureCode(error: unknown, path: string, migrate: boolean): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ERR_DLOPEN_FAILED') return 'E_STORAGE_MODULE_FAILED'
  return migrate || existsSync(path) ? 'E_STORAGE_OPEN_FAILED' : 'E_STORAGE_NOT_FOUND'
}

export function openSqliteAdapter(path: string, open: OpenOptions = {}): SqliteAdapter {
  const migrate = open.migrate ?? true
  let db: Database.Database
  try {
    db = new Database(path, { fileMustExist: !migrate })
  } catch (error) {
    throw new Error(openFailureCode(error, path, migrate))
  }
  try {
    // The same pragmas as the Rust store: WAL lets the app and devot-mcp
    // share the file; the busy timeout waits out the other's writes. Every
    // write transaction begins IMMEDIATE, as the Rust store's do: one that
    // read first would fail at once when it then needs to write. Deleted
    // text is overwritten (secure_delete), so free pages keep none.
    // The SQL function the Rust store registers too (storage/mod.rs): terms
    // too short for the trigram index are scanned with it, so they ignore
    // case in every script as the index does (SQLite's lower() is ASCII only).
    db.function('devot_fold', { deterministic: true }, (text) =>
      typeof text === 'string' ? foldText(text) : text,
    )
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')

    const version = db.pragma('user_version', { simple: true }) as number
    if (version > SCHEMA_VERSION) throw new Error('E_STORAGE_SCHEMA_TOO_NEW')
    if (!migrate && version < SCHEMA_VERSION) throw new Error('E_STORAGE_SCHEMA_TOO_OLD')
    migrations.slice(version).forEach((sql, i) => {
      db.transaction(() => {
        db.exec(sql)
        db.pragma(`user_version = ${version + i + 1}`)
      }).immediate()
    })
  } catch (error) {
    db.close()
    throw error
  }

  const toSummary = (row: SummaryRow): NoteSummary => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bookId: row.bookId,
    status: row.status,
    pinned: row.pinned === 1,
    tagIds: row.tagIds ? row.tagIds.split(',') : [],
  })
  const countInBooks = db.prepare<[string], { bookId: string; notes: number }>(
    `SELECT book_id AS bookId, count(*) AS notes FROM notes
     WHERE deleted_at IS NULL AND book_id IN (SELECT value FROM json_each(?))
     GROUP BY book_id`,
  )
  const tagsOf = db.prepare<[string], { id: string; name: string }>(
    `SELECT t.id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
     WHERE nt.note_id = ? AND nt.present = 1`,
  )
  const tagsInBooks = db.prepare<[string], { id: string; name: string; notes: number }>(
    `SELECT t.id, t.name, count(*) AS notes FROM notes n
     JOIN note_tags nt ON nt.note_id = n.id AND nt.present = 1
     JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
     WHERE n.deleted_at IS NULL AND n.book_id IN (SELECT value FROM json_each(?))
     GROUP BY t.id`,
  )
  const list = db.prepare<[], SummaryRow>(LIST_SQL.notes)
  const get = db.prepare<[string], Row>('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL')
  const bodyMd = db.prepare<[string], { body_md: string }>('SELECT body_md FROM notes WHERE id = ?')
  const getAny = db.prepare<[string], Row>('SELECT * FROM notes WHERE id = ? AND purged_at IS NULL')
  const bodyRow = db.prepare<[string], { id: string; title: string; body_md: string }>(
    'SELECT id, title, body_md FROM notes WHERE id = ? AND purged_at IS NULL',
  )
  const trash = db.prepare<[], TrashedNote>(LIST_SQL.trash)
  // Wipes the content and keeps the tombstone; a purge is final.
  const purge = db.prepare(
    `UPDATE notes SET title = '', title_hlc = MAX(title_hlc, @hlc), body_md = '', ydoc = x'',
       deleted_at = COALESCE(deleted_at, @at), deleted_hlc = MAX(COALESCE(deleted_hlc, ''), @hlc),
       purged_at = @at
     WHERE id = @id AND purged_at IS NULL`,
  )
  // The search index takes a purged note's text out of its pages: same statement as the Rust
  // store (SEARCH_SECURE_DELETE_SQL, which says why only a purge turns it on). FTS5 refuses a
  // number that is not bound as an integer.
  const searchSecureDelete = db.prepare<[bigint]>(
    "INSERT INTO notes_fts (notes_fts, rank) VALUES ('secure-delete', ?)",
  )
  const dropLinks = db.prepare('DELETE FROM note_tags WHERE note_id = ?')
  // The link index: same statements as the Rust store (put_note, purge_note).
  const dropNoteLinks = db.prepare('DELETE FROM links WHERE source_id = ?')
  const addNoteLink = db.prepare('INSERT OR IGNORE INTO links (source_id, target_id) VALUES (?, ?)')
  const handOverFiles = db.prepare<[{ id: string }]>(HAND_OVER_FILES_SQL)
  const dropFiles = db.prepare('DELETE FROM files WHERE note_id = ?')
  // Revision history: same statements as the Rust store (storage/mod.rs).
  const dropRevisions = db.prepare('DELETE FROM revisions WHERE note_id = ?')
  const keepAgentWrites = db.prepare(AGENT_WRITES_SQL.keep)
  const putAgentWrite = db.prepare(AGENT_WRITES_SQL.put)
  const listAgentWrites = db.prepare<
    [{ limit: number }],
    Omit<AgentWriteSummary, 'created' | 'seen'> & { created: number; seen: number }
  >(AGENT_WRITES_SQL.list)
  const authoredAgentWrites = db.prepare<[], { note_id: string }>(AGENT_WRITES_SQL.authored)
  const seenAgentWrites = db.prepare(AGENT_WRITES_SQL.seen)
  const dropAgentWrites = db.prepare(AGENT_WRITES_SQL.purge)
  const syncPending = db.prepare<[{ after: string; limit: number }], { id: string }>(
    SYNC_SQL.pending,
  )
  const syncPendingCount = db.prepare<[], { n: number }>(SYNC_SQL.pendingCount)
  const syncEntry = db.prepare<[{ id: string }], SyncEntry>(SYNC_SQL.entry)
  const syncPut = db.prepare(SYNC_SQL.put)
  const syncStates = db.prepare<[], { key: string; value: string }>(SYNC_SQL.state)
  const syncSetState = db.prepare(SYNC_SQL.setState)
  const syncReset = db.prepare(SYNC_SQL.reset)
  const syncNote = db.prepare<[{ id: string }], Row & { purged: number }>(SYNC_SQL.note)
  const syncNoteTags = db.prepare<
    [{ id: string }],
    Omit<NoteTagRecord, 'present'> & { present: number }
  >(SYNC_SQL.noteTags)
  const syncBook = db.prepare<[{ id: string }], BookRow>(SYNC_SQL.book)
  const syncTag = db.prepare<[{ id: string }], TagRow>(SYNC_SQL.tag)
  const putRevision = db.prepare(
    `INSERT INTO revisions (id, note_id, kind, at, ydoc, length, value)
     SELECT @id, @noteId, @kind, @at, @ydoc, @length, @value
      WHERE EXISTS (SELECT 1 FROM notes WHERE id = @noteId AND purged_at IS NULL)
     ON CONFLICT (id) DO UPDATE SET
       at = excluded.at, ydoc = excluded.ydoc, length = excluded.length, value = excluded.value
     WHERE note_id = excluded.note_id AND kind = excluded.kind`,
  )
  const listRevisions = db.prepare<[{ noteId: string }], Omit<RevisionRow, 'ydoc'>>(
    REVISION_SQL.history,
  )
  const getRevision = db.prepare<[string], RevisionRow>('SELECT * FROM revisions WHERE id = ?')
  const deleteRevision = db.prepare('DELETE FROM revisions WHERE note_id = ? AND id = ?')
  const compactable = db.prepare<
    [{ from: number; to: number; after: string; limit: number }],
    CompactableVersion
  >(REVISION_SQL.compactable)
  const compactDrop = db.prepare<[{ id: string }]>(REVISION_SQL.compactDrop)
  const compactSwept = db.prepare<[{ at: number }]>(REVISION_SQL.compactSwept)
  const lastCompaction = db.prepare<[], { sweptAt: number }>(REVISION_SQL.lastCompaction)
  const activityNotes = db.prepare<[{ since: number }], ActivityNote>(ACTIVITY_SQL.notes)
  const activityRevisions = db.prepare<[{ since: number }], ActivityRevision>(
    ACTIVITY_SQL.revisions,
  )
  const noteActivity = db.prepare<[{ ids: string; since: number }], ActivityRevision>(
    ACTIVITY_SQL.noteRevisions,
  )
  const liveNote = db.prepare<[string], { live: number }>(
    'SELECT EXISTS (SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL) AS live',
  )
  const insertFile = db.prepare(
    `INSERT INTO files (id, note_id, name, mime, size, data, created_at)
     VALUES (@id, @noteId, @name, @mime, @size, @data, @createdAt)`,
  )
  // Same statement as the Rust store (copy_files).
  const copyFile = db.prepare(
    `INSERT INTO files (id, note_id, name, mime, size, data, created_at)
     SELECT @to, @noteId, name, mime, size, data, @createdAt FROM files WHERE id = @from`,
  )
  // Same per-field last-writer-wins merge as the Rust store (storage/mod.rs).
  // A compare-and-set on the body, as the Rust store's put_note: written
  // only while the stored body is at the version the record is based on.
  const put = db.prepare(
    `INSERT INTO notes (id, title, title_hlc, body_md, ydoc, book_id, book_hlc,
                        status, status_hlc, pinned, pinned_hlc,
                        created_at, updated_at, deleted_at, deleted_hlc, body_version,
                        dates_hlc)
     VALUES (@id, @title, @titleHlc, @bodyMd, @ydoc, @bookId, @bookHlc,
             @status, @statusHlc, @pinned, @pinnedHlc,
             @createdAt, @updatedAt, @deletedAt, @deletedHlc, @bodyVersion + 1,
             @datesHlc)
     ON CONFLICT (id) DO UPDATE SET
       title = CASE WHEN excluded.title_hlc > title_hlc THEN excluded.title ELSE title END,
       title_hlc = MAX(excluded.title_hlc, title_hlc),
       book_id = CASE WHEN excluded.book_hlc > book_hlc THEN excluded.book_id ELSE book_id END,
       book_hlc = MAX(excluded.book_hlc, book_hlc),
       status = CASE WHEN excluded.status_hlc > status_hlc THEN excluded.status ELSE status END,
       status_hlc = MAX(excluded.status_hlc, status_hlc),
       pinned = CASE WHEN excluded.pinned_hlc > pinned_hlc THEN excluded.pinned ELSE pinned END,
       pinned_hlc = MAX(excluded.pinned_hlc, pinned_hlc),
       deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                         THEN excluded.deleted_at ELSE deleted_at END,
       deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                          THEN excluded.deleted_hlc ELSE deleted_hlc END,
       body_md = excluded.body_md, ydoc = excluded.ydoc,
       body_version = excluded.body_version,
       created_at = CASE WHEN excluded.dates_hlc > dates_hlc
                         THEN excluded.created_at ELSE created_at END,
       updated_at = CASE WHEN excluded.dates_hlc > dates_hlc
                         THEN excluded.updated_at ELSE MAX(excluded.updated_at, updated_at) END,
       dates_hlc = MAX(excluded.dates_hlc, dates_hlc)
     WHERE purged_at IS NULL AND body_version = @bodyVersion`,
  )
  const purged = db.prepare<[string], { purged: number }>(
    'SELECT purged_at IS NOT NULL AS purged FROM notes WHERE id = ?',
  )
  const books = db.prepare<[], BookRow>('SELECT * FROM books WHERE deleted_at IS NULL')
  const userVersion = db.prepare<[], { user_version: number }>('PRAGMA user_version')
  const tags = db.prepare<[], TagRow>('SELECT * FROM tags WHERE deleted_at IS NULL')
  const putTag = db.prepare(
    `INSERT INTO tags (id, name, name_hlc, created_at, updated_at, deleted_at, deleted_hlc,
                       color, color_hlc)
     VALUES (@id, @name, @nameHlc, @createdAt, @updatedAt, @deletedAt, @deletedHlc,
             @color, @colorHlc)
     ON CONFLICT (id) DO UPDATE SET
       name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
       name_hlc = MAX(excluded.name_hlc, name_hlc),
       color = CASE WHEN excluded.color_hlc > color_hlc THEN excluded.color ELSE color END,
       color_hlc = MAX(excluded.color_hlc, color_hlc),
       deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                         THEN excluded.deleted_at ELSE deleted_at END,
       deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                          THEN excluded.deleted_hlc ELSE deleted_hlc END,
       updated_at = MAX(excluded.updated_at, updated_at)`,
  )
  const putNoteTag = db.prepare(
    `INSERT INTO note_tags (note_id, tag_id, present, hlc) VALUES (@noteId, @tagId, @present, @hlc)
     ON CONFLICT (note_id, tag_id) DO UPDATE SET
       present = CASE WHEN excluded.hlc > hlc THEN excluded.present ELSE present END,
       hlc = MAX(excluded.hlc, hlc)`,
  )
  const getNoteTag = db.prepare<[string, string], NoteTagRow>(
    'SELECT note_id, tag_id, present, hlc FROM note_tags WHERE note_id = ? AND tag_id = ?',
  )
  const putBook = db.prepare(
    `INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at,
                        deleted_at, deleted_hlc, ai_access, ai_access_hlc, sort_key, sort_key_hlc,
                        icon, icon_color, icon_hlc)
     VALUES (@id, @name, @nameHlc, @parentId, @parentHlc, @createdAt, @updatedAt,
             @deletedAt, @deletedHlc, @aiAccess, @aiAccessHlc, @sortKey, @sortKeyHlc,
             @icon, @iconColor, @iconHlc)
     ON CONFLICT (id) DO UPDATE SET
       name = CASE WHEN excluded.name_hlc > name_hlc THEN excluded.name ELSE name END,
       name_hlc = MAX(excluded.name_hlc, name_hlc),
       parent_id = CASE WHEN excluded.parent_hlc > parent_hlc THEN excluded.parent_id ELSE parent_id END,
       parent_hlc = MAX(excluded.parent_hlc, parent_hlc),
       ai_access = CASE WHEN excluded.ai_access_hlc > ai_access_hlc
                        THEN excluded.ai_access ELSE ai_access END,
       ai_access_hlc = MAX(excluded.ai_access_hlc, ai_access_hlc),
       icon = CASE WHEN excluded.icon_hlc > icon_hlc THEN excluded.icon ELSE icon END,
       icon_color = CASE WHEN excluded.icon_hlc > icon_hlc THEN excluded.icon_color ELSE icon_color END,
       icon_hlc = MAX(excluded.icon_hlc, icon_hlc),
       -- Equal clocks (keys the core gave old notebooks on two devices):
       -- the greater key wins, so both sides end with the same one.
       sort_key = CASE WHEN excluded.sort_key_hlc > sort_key_hlc
                         OR (excluded.sort_key_hlc = sort_key_hlc AND excluded.sort_key > sort_key)
                       THEN excluded.sort_key ELSE sort_key END,
       sort_key_hlc = MAX(excluded.sort_key_hlc, sort_key_hlc),
       deleted_at = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                         THEN excluded.deleted_at ELSE deleted_at END,
       deleted_hlc = CASE WHEN COALESCE(excluded.deleted_hlc, '') > COALESCE(deleted_hlc, '')
                          THEN excluded.deleted_hlc ELSE deleted_hlc END,
       updated_at = MAX(excluded.updated_at, updated_at)`,
  )

  /** Runs a search (see searchStatement). */
  const search = (query: NoteQuery, limit: number) => {
    const { sql, params } = searchStatement(query, limit)
    return db.prepare<[Record<string, string | number>], SummaryRow>(sql).all(params)
  }
  // Bodies are read for the notes returned only, never for every match.
  const bodyOf = (id: string) => bodyMd.get(id)?.body_md ?? ''

  const purgeWith = (id: string, at: number, hlc: string, revisions: boolean) =>
    db
      .transaction(() => {
        searchSecureDelete.run(1n)
        purge.run({ id, at, hlc })
        dropLinks.run(id)
        // Attachments another note still shows pass to it; the rest go.
        handOverFiles.run({ id })
        dropFiles.run(id)
        dropNoteLinks.run(id)
        dropAgentWrites.run({ noteId: id })
        if (revisions) dropRevisions.run(id)
        searchSecureDelete.run(0n)
      })
      .immediate()

  // One atomic run at a time: a second BEGIN inside the first would fail.
  let queue: Promise<unknown> = Promise.resolve()

  return {
    db,
    close: () => db.close(),
    schemaVersion: () => userVersion.get()?.user_version ?? 0,
    atomically<T>(work: () => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = await work()
          db.exec('COMMIT')
          return result
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK')
          throw error
        }
      })
      queue = run.catch(() => undefined)
      return run
    },
    listNotes: async () => list.all().map(toSummary),
    async getNote(id, options) {
      const row = options?.trashed ? getAny.get(id) : get.get(id)
      return row ? toNote(row) : null
    },
    getBodies: async (ids) =>
      ids.flatMap((id) => {
        const row = bodyRow.get(id)
        return row ? [{ id: row.id, title: row.title, bodyMd: row.body_md }] : []
      }),
    async putNote(note) {
      // What the app's note_put refuses, this refuses too.
      const links = noteLinks(note.bodyMd)
      checkNote(note, links)
      const { agentWrites, ...record } = note
      db.transaction(() => {
        const written = put.run({
          ...record,
          ydoc: Buffer.from(record.ydoc),
          pinned: record.pinned ? 1 : 0,
          datesHlc: record.datesHlc ?? '',
        }).changes
        if (written === 0) {
          // A purged note is left alone; any other has a body that moved on
          // from the version the write is based on.
          if (purged.get(note.id)?.purged === 0) throw new Error('E_NOTE_BODY_STALE')
          return
        }
        dropNoteLinks.run(note.id)
        for (const target of links) addNoteLink.run(note.id, target)
        if (!agentWrites) return
        const noteId = note.id
        keepAgentWrites.run({ noteId, ids: JSON.stringify(agentWrites.map((w) => w.writeId)) })
        for (const row of agentWrites) {
          putAgentWrite.run({ noteId, ...row, created: row.created ? 1 : 0 })
        }
      }).immediate()
    },
    async searchNotes(query, limit) {
      const terms = excerptTerms(query)
      return search(query, limit).map((row) => {
        const excerpt = terms.length ? bodyExcerpt(bodyOf(row.id), terms) : undefined
        return excerpt === undefined ? toSummary(row) : { ...toSummary(row), excerpt }
      })
    },
    searchNotesInBooks: async (query, bookIds, limit) =>
      bookIds.length === 0
        ? []
        : search(
            { ...query, sets: [...query.sets, { kind: 'book', ids: [...bookIds], negate: false }] },
            limit,
          ).map((row) => ({ ...toSummary(row), bodyMd: bodyOf(row.id) })),
    countNotesInBooks: async (bookIds) =>
      new Map(countInBooks.all(JSON.stringify(bookIds)).map((r) => [r.bookId, r.notes])),
    noteTags: async (noteId) => tagsOf.all(noteId),
    tagsInBooks: async (bookIds) => tagsInBooks.all(JSON.stringify(bookIds)),
    async putFile(meta, data) {
      const mime = checkUpload(meta, data)
      // The note's check and the file in one transaction, as the Rust store's.
      db.transaction(() => {
        if (!liveNote.get(meta.noteId)?.live) throw new Error('E_NOTE_NOT_FOUND')
        insertFile.run({
          ...meta,
          mime,
          size: data.length,
          data: Buffer.from(data),
          createdAt: Date.now(),
        })
      }).immediate()
    },
    async copyFiles(noteId, copies) {
      db.transaction(() => {
        if (!liveNote.get(noteId)?.live) throw new Error('E_NOTE_NOT_FOUND')
        const createdAt = Date.now()
        for (const { from, to } of copies) copyFile.run({ from, to, noteId, createdAt })
      }).immediate()
    },
    listTrash: async () => trash.all(),
    async purgeNote(id, at, hlc) {
      purgeWith(id, at, hlc, true)
    },
    async syncPending(after, limit) {
      return syncPending.all({ after, limit }).map((row) => row.id)
    },
    async syncPendingCount() {
      return syncPendingCount.get()?.n ?? 0
    },
    async syncRead(ids) {
      return ids.map((id): SyncLocal => {
        const note = syncNote.get({ id })
        const book = note ? undefined : syncBook.get({ id })
        const tag = note || book ? undefined : syncTag.get({ id })
        return {
          id,
          entry: syncEntry.get({ id }) ?? null,
          note: note
            ? {
                note: toNote(note),
                purged: note.purged === 1,
                tags: syncNoteTags.all({ id }).map((t) => ({
                  noteId: t.noteId,
                  tagId: t.tagId,
                  present: t.present === 1,
                  hlc: t.hlc,
                })),
              }
            : null,
          book: book ? toBook(book, true) : null,
          tag: tag ? toTag(tag, true) : null,
        }
      })
    },
    async syncPut(entry) {
      syncPut.run(entry)
    },
    async syncState() {
      return Object.fromEntries(syncStates.all().map((row) => [row.key, row.value]))
    },
    async syncSetState(key, value) {
      syncSetState.run({ key, value })
    },
    async syncReset() {
      syncReset.run()
    },
    async syncPurge(id, at, hlc) {
      purgeWith(id, at, hlc, false)
    },
    async putRevision(revision) {
      putRevision.run({
        ...revision,
        ydoc: revision.ydoc === null ? null : Buffer.from(revision.ydoc),
      })
    },
    listRevisions: async (noteId) =>
      listRevisions.all({ noteId }).map((row): RevisionSummary => ({
        id: row.id,
        noteId: row.note_id,
        kind: row.kind,
        at: row.at,
        length: row.length,
        value: row.value,
      })),
    async getRevision(id) {
      const row = getRevision.get(id)
      return row ? toRevision(row) : null
    },
    async deleteRevisions(noteId, ids) {
      db.transaction(() => {
        for (const id of ids) deleteRevision.run(noteId, id)
      }).immediate()
    },
    listCompactable: async (from, to, after, limit) => compactable.all({ from, to, after, limit }),
    async compactRevisions(ids, sweptAt) {
      db.transaction(() => {
        for (const id of ids) compactDrop.run({ id })
        if (sweptAt !== null) compactSwept.run({ at: sweptAt })
      }).immediate()
    },
    lastCompaction: async () => lastCompaction.get()?.sweptAt ?? null,
    listActivity: async (since): Promise<ActivityData> => ({
      notes: activityNotes.all({ since }),
      revisions: activityRevisions.all({ since }),
    }),
    listNoteActivity: async (ids, since) => noteActivity.all({ ids: JSON.stringify(ids), since }),
    listAgentWrites: async (limit) =>
      listAgentWrites.all({ limit }).map((row) => ({
        ...row,
        created: row.created === 1,
        seen: row.seen === 1,
      })),
    async authoredNotes() {
      return authoredAgentWrites.all().map((row) => row.note_id)
    },
    async markAgentWritesSeen(noteId, writeIds) {
      return seenAgentWrites.run({ noteId, ids: JSON.stringify(writeIds) }).changes
    },
    listBooks: async () => books.all().map((row) => toBook(row)),
    async putBook(book) {
      putBook.run({ ...book, aiAccess: book.aiAccess ? 1 : 0 })
    },
    listTags: async () => tags.all().map((row) => toTag(row)),
    async putTag(tag) {
      putTag.run(tag)
    },
    async putNoteTag(link) {
      putNoteTag.run({ ...link, present: link.present ? 1 : 0 })
    },
    async getNoteTag(noteId, tagId) {
      const row = getNoteTag.get(noteId, tagId)
      return row
        ? { noteId: row.note_id, tagId: row.tag_id, present: row.present === 1, hlc: row.hlc }
        : null
    },
  }
}
