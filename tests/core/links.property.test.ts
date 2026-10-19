import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService, noteLinks } from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// The link index must always equal the links in the stored note bodies,
// whatever sequence of edits, trashing, restoring and purging led there.

const NOTES = 4
const STRANGER = '0192a6f0-0000-7000-8000-0000000000ff'

type Op =
  | { kind: 'edit'; note: number; targets: number[]; stranger: boolean; noise: string }
  | { kind: 'trash' | 'restore' | 'purge'; note: number }

const note = fc.integer({ min: 0, max: NOTES - 1 })
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      note,
      targets: fc.array(note, { maxLength: 5 }),
      stranger: fc.boolean(),
      noise: fc.string({ maxLength: 12 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('trash' as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore' as const), note }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('purge' as const), note }) },
)

describe('the link index', () => {
  it('always matches the stored note bodies', async () => {
    const dir = tempDir('devot-links-')
    let run = 0
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 25 }), async (ops) => {
        const storage = openSqliteAdapter(join(dir, `run-${run++}.sqlite`))
        try {
          const notes = createNoteService({
            storage,
            clock: createClock('mac'),
            newId: createIdGenerator(),
            saveDelayMs: 1,
          })
          const ids: string[] = []
          for (let i = 0; i < NOTES; i++) ids.push(await notes.create(`Note ${i}`))
          const purged = new Set<string>()

          for (const step of ops) {
            const id = ids[step.note] as string
            if (purged.has(id)) continue
            if (step.kind === 'edit') {
              const opened = await notes.open(id).catch(() => undefined)
              if (!opened) continue // in the trash: not editable
              const doc = new Y.Doc()
              Y.applyUpdate(doc, opened.state)
              const pending: Promise<void>[] = []
              doc.on('update', (update: Uint8Array) => pending.push(notes.applyUpdate(id, update)))
              const links = step.targets.map((t) => `[n${t}](devot://note/${ids[t]})`)
              if (step.stranger) links.push(`<devot://note/${STRANGER}>`)
              const text = doc.getText(BODY)
              doc.transact(() => {
                text.delete(0, text.length)
                text.insert(0, `${step.noise}\n${links.join(' ')}\n${step.noise}`)
              })
              await Promise.all(pending)
              // Saved before the next step, as the app does between edits.
              await notes.flush()
            } else if (step.kind === 'trash') {
              await notes.trash(id).catch(() => {})
            } else if (step.kind === 'restore') {
              await notes.restore(id).catch(() => {})
            } else {
              await notes.trash(id).catch(() => {})
              await notes.purge(id)
              purged.add(id)
            }
          }
          await notes.flush()

          const bodies = storage.db
            .prepare<[], { id: string; body_md: string }>(
              'SELECT id, body_md FROM notes WHERE purged_at IS NULL',
            )
            .all()
          const expected = bodies
            .flatMap((n) => noteLinks(n.body_md).map((t) => `${n.id}>${t}`))
            .sort()
          const actual = storage.db
            .prepare<[], { s: string; t: string }>(
              'SELECT source_id AS s, target_id AS t FROM links',
            )
            .all()
            .map((r) => `${r.s}>${r.t}`)
            .sort()
          expect(actual).toEqual(expected)
        } finally {
          storage.close()
        }
      }),
      { numRuns: 40 },
    )
  }, 60_000)
})
