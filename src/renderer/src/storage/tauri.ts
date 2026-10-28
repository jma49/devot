// Storage over Tauri commands. Yjs states cross IPC as base64 strings, which
// the core worker codes (see wire.ts): this side hands them to the commands
// as they come, so a save or an open costs the UI thread nothing per byte.
import { invoke } from '../ipc'
import type {
  ActivityData,
  ActivityRevision,
  AgentWriteSummary,
  BookRecord,
  CompactableVersion,
  NoteBody,
  NoteSummary,
  NoteTagRecord,
  RevisionSummary,
  StorageAdapter,
  TagRecord,
  TrashedNote,
} from '../../../core'
import { fromWire, type WireNote, type WireRevision, type WireStorage } from './wire'

export const tauriWire: WireStorage = {
  listNotes: () => invoke<NoteSummary[]>('notes_list'),
  getNote: (id, options) =>
    invoke<WireNote | null>('note_get', { id, trashed: options?.trashed ?? false }),
  getBodies: (ids) => invoke<NoteBody[]>('notes_bodies', { ids }),
  // The worker found the links and checked the note and its agent_writes rows (what note_put refuses).
  putNote: (note, links) => {
    if (note.agentWrites === undefined) return invoke('note_put', { note, links, writes: null })
    const { agentWrites, ...record } = note
    return invoke('note_put', { note: record, links, writes: agentWrites })
  },
  // The Rust command applies its own result limit.
  searchNotes: (query) => invoke<NoteSummary[]>('notes_search', { query }),
  listTrash: () => invoke<TrashedNote[]>('notes_trash_list'),
  // The bytes travel as the raw request body, the rest in headers.
  putFile: (meta, data) =>
    invoke('file_put', data, {
      headers: {
        'x-devot-file-id': meta.id,
        'x-devot-note-id': meta.noteId,
        'x-devot-file-name': encodeURIComponent(meta.name),
      },
    }),
  copyFiles: (noteId, copies) => invoke('files_copy', { noteId, copies }),
  purgeNote: (id, at, hlc) => invoke('note_purge', { id, at, hlc }),
  listBooks: () => invoke<BookRecord[]>('books_list'),
  putBook: (book) => invoke('book_put', { book }),
  listTags: () => invoke<TagRecord[]>('tags_list'),
  putTag: (tag) => invoke('tag_put', { tag }),
  putNoteTag: (link) => invoke('note_tag_put', { link }),
  getNoteTag: (noteId, tagId) => invoke<NoteTagRecord | null>('note_tag_get', { noteId, tagId }),
  putRevision: (revision) => invoke('revision_put', { revision }),
  listRevisions: (noteId) => invoke<RevisionSummary[]>('revisions_list', { noteId }),
  getRevision: (id) => invoke<WireRevision | null>('revision_get', { id }),
  deleteRevisions: (noteId, ids) => invoke('revisions_delete', { noteId, ids }),
  listCompactable: (from, to, after, limit) =>
    invoke<CompactableVersion[]>('revisions_compactable', { from, to, after, limit }),
  compactRevisions: (ids, sweptAt) => invoke('revisions_compact', { ids, sweptAt }),
  lastCompaction: () => invoke<number | null>('revisions_last_compaction'),
  listActivity: (since) => invoke<ActivityData>('activity_list', { since }),
  listNoteActivity: (ids, since) =>
    invoke<ActivityRevision[]>('activity_notes_list', { ids, since }),
  listAgentWrites: (limit) => invoke<AgentWriteSummary[]>('agent_writes_list', { limit }),
  authoredNotes: () => invoke<string[]>('agent_writes_authored'),
  markAgentWritesSeen: (noteId, writeIds) =>
    invoke<number>('agent_writes_seen', { noteId, writeIds }),
}

export const tauriStorage: StorageAdapter = fromWire(tauriWire)
