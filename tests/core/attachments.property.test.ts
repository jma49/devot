import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService, fileUri } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Purging notes deletes exactly the attachments they owned that no other
// note left (live or in the Trash) shows; each of the others passes to a
// note that shows it, a live one first, then the smallest ID. Checked after
// every purge and every Empty Trash, whatever sequence of attaching,
// editing, trashing, restoring and purging led there: so a purge never
// deletes an attachment a note left shows, and none is left to a purged
// note.

const NOTES = 4
const FILES = [1, 2, 3, 4, 5].map((n) => `0192a6f0-0000-7000-8000-00000000f00${n}`)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

type Op =
  | { kind: 'attach'; note: number; file: number }
  | { kind: 'show'; note: number; files: number[]; near: number[]; noise: string }
  | { kind: 'trash' | 'restore' | 'purge'; note: number }
  | { kind: 'empty' }

const note = fc.integer({ min: 0, max: NOTES - 1 })
const file = fc.integer({ min: 0, max: FILES.length - 1 })
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('attach' as const), note, file }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('show' as const),
      note,
      files: fc.array(file, { maxLength: 3 }),
      near: fc.array(file, { maxLength: 2 }),
      noise: fc.string({ maxLength: 8 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('trash' as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore' as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('purge' as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('empty' as const) }) },
)

/** Mentions of an attachment that are not its address: they never keep it. */
const nearMiss = (id: string, n: number) =>
  n % 3 === 0
    ? `DEVOT://FILE/${id.toUpperCase()}`
    : n % 3 === 1
      ? `devot://file/${id.slice(0, 30)}`
      : `file/${id}`

interface NoteRow {
  id: string
  body: string
  trashed: number
  purged: number
}

const notesIn = (storage: SqliteAdapter) =>
  storage.db
    .prepare<[], NoteRow>(
      `SELECT id, body_md AS body, deleted_at IS NOT NULL AS trashed, purged_at IS NOT NULL AS purged
       FROM notes`,
    )
    .all()

const ownersIn = (storage: SqliteAdapter) =>
  new Map(
    storage.db
      .prepare<[], { id: string; noteId: string }>('SELECT id, note_id AS noteId FROM files')
      .all()
      .map((r) => [r.id, r.noteId]),
  )

/**
 * Who owns each attachment once the notes in `purging` are purged: an
 * attachment of one of them passes to the first note left that shows it (a
 * live one first, then by ID), or is deleted.
 */
function expectedOwners(before: Map<string, string>, notes: NoteRow[], purging: Set<string>) {
  const left = notes
    .filter((n) => !n.purged && !purging.has(n.id))
    .sort((a, b) => a.trashed - b.trashed || (a.id < b.id ? -1 : 1))
  const after = new Map<string, string>()
  for (const [id, owner] of before) {
    if (!purging.has(owner)) after.set(id, owner)
    else {
      const heir = left.find((n) => n.body.includes(fileUri(id)))
      if (heir) after.set(id, heir.id)
    }
  }
  return after
}

describe('attachments', () => {
  it('outlive their note while another note shows them, and only then', async () => {
    const dir = tempDir('devot-attachments-')
    let run = 0
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        const storage = openSqliteAdapter(join(dir, `run-${run++}.sqlite`))
        const notes = createNoteService({
          storage,
          clock: createClock('mac'),
          newId: createIdGenerator(),
          saveDelayMs: 1,
        })
        try {
          const ids: string[] = []
          for (let i = 0; i < NOTES; i++) ids.push(await notes.create(`Note ${i}`))
          const attached = new Set<string>()
          /** Purges the notes in the Trash that `chosen` picks, checking the owners after. */
          const purgeChecked = async (
            chosen: (id: string) => boolean,
            purge: () => Promise<unknown>,
          ) => {
            const rows = notesIn(storage)
            const purging = new Set(
              rows.filter((n) => !n.purged && n.trashed && chosen(n.id)).map((n) => n.id),
            )
            const expected = expectedOwners(ownersIn(storage), rows, purging)
            if (purging.size > 0) await purge()
            expect(ownersIn(storage)).toEqual(expected)
          }

          for (const step of ops) {
            if (step.kind === 'empty') {
              await purgeChecked(
                () => true,
                () => notes.emptyTrash(),
              )
              continue
            }
            const id = ids[step.note] as string
            if (step.kind === 'purge') {
              // Delete forever: to the Trash first if needed, then purge.
              await notes.trash(id).catch(() => {})
              await purgeChecked(
                (n) => n === id,
                () => notes.purge(id),
              )
            } else if (step.kind === 'attach') {
              const fileId = FILES[step.file] as string
              if (attached.has(fileId)) continue // IDs are never used twice
              const stored = await storage
                .putFile({ id: fileId, noteId: id, name: 'shot.png' }, PNG)
                .then(() => true)
                .catch(() => false) // the note is in the Trash or purged
              if (stored) attached.add(fileId)
            } else if (step.kind === 'show') {
              const body = [
                step.noise,
                ...step.files.map(
                  (f, i) => `![](${fileUri(FILES[f] as string)}${i % 2 ? '#half' : ''})`,
                ),
                ...step.near.map((f, i) => nearMiss(FILES[f] as string, i + step.note)),
              ].join(' ')
              // Only a live note can be edited.
              const edited = await notes
                .setBody(id, body)
                .then(() => true)
                .catch(() => false)
              if (edited) await notes.flush()
            } else if (step.kind === 'trash') {
              await notes.trash(id).catch(() => {})
            } else {
              await notes.restore(id).catch(() => {})
            }
          }

          // No attachment is left to a purged note.
          const purged = new Set(
            notesIn(storage)
              .filter((n) => n.purged)
              .map((n) => n.id),
          )
          for (const owner of ownersIn(storage).values()) expect(purged.has(owner)).toBe(false)
        } finally {
          await notes.flush()
          storage.close()
        }
      }),
      { numRuns: 60 },
    )
  }, 60_000)
})
