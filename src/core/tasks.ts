// Task progress: how many of a note's task items (`- [ ]`, `- [x]`) are
// ticked. The note list, the preview's info card and note-link chips show it.
// One counter serves all of them; it lives with the other body extractors.

export { taskProgress, type TaskProgress } from './extract'
