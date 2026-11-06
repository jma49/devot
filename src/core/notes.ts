export { BODY, bodyText, seedClient, seedState } from './notes/body'
export { NOTES_IN_MEMORY } from './notes/memory'
export { saveDelay } from './notes/saving'
export { createNoteService } from './notes/service'
export type {
  AgentNoteWrite,
  MetaChange,
  NoteService,
  NoteServiceOptions,
  OpenedNote,
  RowDetail,
  SaveProblem,
  SearchResult,
  StatusUndo,
} from './notes/types'
