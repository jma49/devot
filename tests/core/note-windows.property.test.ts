// Two windows type into one note at the same time, each through its own core, with the relay's
// messages delivered late and in any order and saves landing whenever they do. Once everything has
// arrived and both have saved, both windows and the stored note show the same text: every edit
// either window made, merged, and nothing lost.
import fc from 'fast-check'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY } from '../../src/core'
import { windowsOn, type NoteWindow } from '../support/note-windows'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const storage = openSqliteAdapter(join(tempDir('devot-windows-prop-'), 'devot.sqlite'))
afterAll(() => storage.close())

type Op =
  | { kind: 'type'; window: number; at: number; remove: number; insert: string }
  | { kind: 'deliver'; window: number; pick: number }
  | { kind: 'save'; window: number }

const window = fc.integer({ min: 0, max: 1 })
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      window,
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      remove: fc.integer({ min: 0, max: 3 }),
      insert: fc.string({ maxLength: 4 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('deliver' as const),
      window,
      pick: fc.double({ min: 0, max: 0.999, noNaN: true }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('save' as const), window }) },
)

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}

describe('two windows typing into one note', () => {
  it('converge on every edit either made, saved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 12 }),
        fc.array(op, { maxLength: 24 }),
        async (start, ops) => {
          const [setup] = windowsOn(storage, ['setup']).windows
          const id = await setup!.notes.create('Plan')
          await setup!.notes.setBody(id, start)
          await setup!.notes.release(id)
          const initial = (await storage.getNote(id))!.ydoc

          const app = windowsOn(storage, ['main', 'note'], { saveDelayMs: 0, retryDelayMs: 1 })
          const windows = app.windows as [NoteWindow, NoteWindow]
          for (const w of windows) await app.show(w, id)

          for (const step of ops) {
            const w = windows[step.window]!
            if (step.kind === 'type') {
              const text = w.editors.get(id)!.getText(BODY)
              const at = Math.floor(step.at * text.length)
              const remove = Math.min(step.remove, text.length - at)
              w.editors.get(id)!.transact(() => {
                if (remove > 0) text.delete(at, remove)
                if (step.insert) text.insert(at, step.insert)
              })
            } else if (step.kind === 'deliver') {
              if (w.inbox.length > 0) await app.deliver(w, Math.floor(step.pick * w.inbox.length))
            } else {
              await app.settle()
              await w.notes.flush().catch(() => {})
            }
          }

          await app.deliverAll()
          for (const w of windows) await w.notes.flush()
          await app.deliverAll()

          const expected = textOf(Y.mergeUpdates([initial, ...windows.flatMap((w) => w.typed)]))
          const stored = (await storage.getNote(id))!
          expect(stored.bodyMd).toBe(expected)
          expect(textOf(stored.ydoc)).toBe(expected)
          for (const w of windows) {
            expect(app.editorText(w, id)).toBe(expected)
            expect((await w.notes.read(id)).bodyMd).toBe(expected)
          }
          for (const w of windows) w.notes.unhold(id)
        },
      ),
      { numRuns: 200 },
    )
  })
})
