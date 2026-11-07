import type { NoteTally } from '../../core/noteFacts'

/** The core, or what a test puts in its place. */
interface Tallier {
  noteTally(markdown: string): Promise<NoteTally>
}

const last = new WeakMap<Tallier, { markdown: string; tally: Promise<NoteTally> }>()

/**
 * The open note's tally, asked of the core once for each text: after a pause the counts footer and
 * Note Info both ask for the same one, and the second shares the first's answer.
 */
export function tallyNote(core: Tallier, markdown: string): Promise<NoteTally> {
  const kept = last.get(core)
  if (kept?.markdown === markdown) return kept.tally
  const tally = core.noteTally(markdown)
  last.set(core, { markdown, tally })
  tally.catch(() => {
    if (last.get(core)?.tally === tally) last.delete(core)
  })
  return tally
}
