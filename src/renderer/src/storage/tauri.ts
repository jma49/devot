// Storage over Tauri commands. Notes and Yjs states come framed or coded by
// the core worker (see wire.ts): this side hands them to the commands as they
// come, so a save or an open costs the UI thread nothing per byte.
import * as Comlink from 'comlink'
import { invoke } from '../ipc'
import type {
  ActivityData,
  ActivityRevision,
  AgentWriteSummary,
  BookRecord,
  CompactableVersion,
  LinkGraph,
  NoteBody,
  NoteSummary,
  NoteTagRecord,
  RevisionSummary,
  SavedSearchRecord,
  StorageAdapter,
  TagRecord,
  TrashedNote,
} from '../../../core'
import { fromWire, type WireNote, type WireRevision, type WireStorage } from './wire'

export const tauriWire: WireStorage = {
  listNotes: (page) =>
    invoke<NoteSummary[]>('notes_list', {
      excludeBookId: page?.excludeBookId ?? null,
      limit: page?.limit ?? null,
    }),
  getSummaries: (ids) => invoke<NoteSummary[]>('notes_summaries', { ids }),
  getNote: (id, options) =>
    invoke<WireNote | null>('note_get', { id, trashed: options?.trashed ?? false }),
  // Handed to the worker as it came, not copied.
  openNote: (id) =>
    invoke<ArrayBuffer>('note_open', { id }).then((frame) => Comlink.transfer(frame, [frame])),
  getBodies: (ids) => invoke<NoteBody[]>('notes_bodies', { ids }),
  // The worker found the links and checked the note and its agent_writes rows (what note_put refuses).
  putNote: ({ frame }) => invoke('note_put', frame),
  putNoteMeta: ({ agentWrites, ...note }) =>
    invoke('note_put_meta', { note, writes: agentWrites ?? null }),
  searchNotes: (query, limit) => invoke<NoteSummary[]>('notes_search', { query, limit }),
  listLinkGraph: (excludeBookId, limit) =>
    invoke<LinkGraph>('note_link_graph', { excludeBookId, limit }),
  listBacklinks: (id, excludeBookId, limit) =>
    invoke<NoteSummary[]>('note_backlinks', { id, excludeBookId, limit }),
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
  isLiveBook: (id) => invoke<boolean>('book_is_live', { id }),
  putBook: (book) => invoke('book_put', { book }),
  putBooks: (books) => invoke('books_put', { books }),
  // Rust writes its own copy of the seed (src-tauri/src/commands/welcome_seed.json), so only the stamps cross.
  seedWelcome: ({ hlc, at }) => invoke<boolean>('welcome_seed', { hlc, at }),
  listTags: () => invoke<TagRecord[]>('tags_list'),
  putTag: (tag) => invoke('tag_put', { tag }),
  renameTag: (tag, searches) => invoke('tag_rename', { tag, searches }),
  listSavedSearches: () => invoke<SavedSearchRecord[]>('saved_searches_list'),
  putSavedSearch: (search) => invoke('saved_search_put', { search }),
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
