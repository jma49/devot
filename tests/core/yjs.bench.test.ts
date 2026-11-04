// Yjs work on a large note: what a remote edit, a sync diff, a merge of two diverged copies and a
// body write cost, and how a note's state grows with its edits. The docs set no budget for these;
// each budget is a baseline measured on a Linux runner with room for a busy machine.
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BODY, createClock, createIdGenerator, createNoteService, textEdits } from '../../src/core'
import { mergeNote, type NoteState } from '../../src/core/sync/records'
import { expectWithinBudget } from '../support/budget'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

/** About 250 KB of Markdown: the size of a long note, a few times the benchmark's 100 KB sample. */
const PARAGRAPHS = 1250
const TIMEOUT_MS = 120_000

const WORDS = (
  'the a note plan week market garden river window letter morning project review budget meeting ' +
  'travel kitchen station paper music evening friend question answer system design picture'
).split(' ')

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const sentence = (next: () => number) =>
  Array.from({ length: 30 }, () => WORDS[Math.floor(next() * WORDS.length)]!).join(' ')

/** `paragraphs` paragraphs of about 200 characters, typed a word at a time over 10 sessions, with corrections. */
function typedNote(paragraphs: number, seed = 7): Y.Doc {
  const next = random(seed)
  const doc = new Y.Doc()
  doc.clientID = 1
  for (let session = 0; session < 10; session += 1) {
    const typist = new Y.Doc()
    typist.clientID = 100 + session
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(doc))
    const text = typist.getText(BODY)
    for (let p = 0; p < paragraphs / 10; p += 1) {
      for (const word of sentence(next).split(' ')) {
        text.insert(text.length, `${word} `)
        if (next() < 0.05) text.delete(text.length - 2, 1)
      }
      text.insert(text.length, '\n\n')
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(typist, Y.encodeStateVector(doc)))
  }
  return doc
}

const copyOf = (doc: Y.Doc, client: number) => {
  const copy = new Y.Doc()
  copy.clientID = client
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

/** `count` edits spread over the text, as another device makes them while offline. */
function scatteredEdits(doc: Y.Doc, count: number, seed: number) {
  const next = random(seed)
  const text = doc.getText(BODY)
  for (let i = 0; i < count; i += 1) {
    const at = Math.floor(next() * text.length)
    if (i % 3 === 0) text.delete(at, Math.min(20, text.length - at))
    else text.insert(at, `edit ${i} `)
  }
}

const best = (work: () => void, runs = 9) => {
  let fastest = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now()
    work()
    fastest = Math.min(fastest, performance.now() - start)
  }
  return fastest
}

const noteState = (id: string, doc: Y.Doc, bodyHlc: string): NoteState => ({
  kind: 'note',
  id,
  purged: false,
  title: 'Long note',
  titleHlc: '',
  bookId: null,
  bookHlc: '',
  status: 'none',
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  createdAt: 0,
  updatedAt: 0,
  datesHlc: '',
  deletedAt: null,
  deletedHlc: '',
  bodyHlc,
  tags: [],
  ydoc: Y.encodeStateAsUpdate(doc),
})

describe(`Yjs on a note of ${PARAGRAPHS} paragraphs`, { timeout: TIMEOUT_MS }, () => {
  const base = typedNote(PARAGRAPHS)
  const length = base.getText(BODY).length

  it('is the size it is meant to be', () => {
    expect(length).toBeGreaterThan(200_000)
  })

  // A keystroke from another window or device: well inside the keystroke's 8 ms frame.
  it('applies a remote keystroke and a remote paste in under 2 ms each', (context) => {
    const remote = copyOf(base, 9)
    const before = Y.encodeStateVector(remote)
    remote.getText(BODY).insert(Math.floor(length / 2), 'x')
    const keystroke = Y.encodeStateAsUpdate(remote, before)
    const middle = Y.encodeStateVector(remote)
    remote.getText(BODY).insert(Math.floor(length / 3), sentence(random(3)).repeat(5))
    const paste = Y.encodeStateAsUpdate(remote, middle)
    const docs = Array.from({ length: 18 }, () => copyOf(base, 10))
    let next = 0
    const keyMs = best(() => Y.applyUpdate(docs[next++]!, keystroke))
    const pasteMs = best(() => {
      const doc = docs[next++]!
      Y.applyUpdate(doc, keystroke)
      Y.applyUpdate(doc, paste)
    })
    expect(docs.at(-1)!.getText(BODY).toString()).toBe(remote.getText(BODY).toString())
    expectWithinBudget(context, keyMs, 2)
    expectWithinBudget(context, pasteMs, 2)
  })

  // Sync sends what the other side lacks; a state vector and the diff are encoded per note pushed.
  it('encodes its state vector and a diff in under 2 ms', (context) => {
    const whole = Y.encodeStateAsUpdate(base).length
    const remote = copyOf(base, 9)
    scatteredEdits(remote, 50, 5)
    const vector = Y.encodeStateVector(base)
    let diff: Uint8Array = new Uint8Array()
    const ms = best(() => {
      Y.encodeStateVector(remote)
      diff = Y.encodeStateAsUpdate(remote, vector)
    })
    // The diff carries the note's whole delete set, and the new text alone besides.
    expect(diff.length).toBeLessThan(whole / 10)
    expectWithinBudget(context, ms, 2)
  })

  it('loads and encodes its whole state in under 25 ms', (context) => {
    const state = Y.encodeStateAsUpdate(base)
    const ms = best(() => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state)
      Y.encodeStateAsUpdate(doc)
    }, 5)
    expectWithinBudget(context, ms, 25)
  })

  // Sync merges a note both devices edited: both states in one document, and a print of each.
  it('merges two copies with 200 edits each in under 60 ms', (context) => {
    const local = copyOf(base, 11)
    const remote = copyOf(base, 12)
    scatteredEdits(local, 200, 1)
    scatteredEdits(remote, 200, 2)
    const id = '0192a6f0-0000-7000-8000-000000000001'
    const ours = noteState(id, local, 'a')
    const theirs = noteState(id, remote, 'b')
    let merged = mergeNote(ours, theirs)
    const ms = best(() => {
      merged = mergeNote(ours, theirs)
    }, 3)
    expect(merged.bothEdited).toBe(true)
    expectWithinBudget(context, ms, 60)
  })
})

describe('Yjs work that grows with the note', { timeout: TIMEOUT_MS }, () => {
  it('merges two diverged copies in time linear in the note', (context) => {
    const growth = fourfoldGrowth((paragraphs) => {
      const base = typedNote(paragraphs)
      const local = copyOf(base, 11)
      const remote = copyOf(base, 12)
      scatteredEdits(local, paragraphs / 5, 1)
      scatteredEdits(remote, paragraphs / 5, 2)
      const id = '0192a6f0-0000-7000-8000-000000000001'
      const ours = noteState(id, local, 'a')
      const theirs = noteState(id, remote, 'b')
      return () => {
        mergeNote(ours, theirs)
      }
    }, 250)
    expectLinearGrowth(context, growth)
  })

  // A body write (an outside writer, a restore, an import) diffs by lines: a few changed lines
  // cost time linear in the note.
  it('works out the edits for a few changed lines in time linear in the note', (context) => {
    const growth = fourfoldGrowth((paragraphs) => {
      const from = typedNote(paragraphs).getText(BODY).toString()
      const lines = from.split('\n')
      for (let i = 0; i < 20; i += 1) {
        const at = Math.floor(((i + 0.5) * lines.length) / 20)
        lines[at] = `${lines[at]} changed`
      }
      const to = lines.join('\n')
      return () => {
        expect(textEdits(from, to)).toHaveLength(20)
      }
    }, 1000)
    expectLinearGrowth(context, growth)
  })

  // Every line changed: past its work bound the diff gives the changed middle as one replacement.
  it('works out the edits for a rewrite of every line of a 1 MB note in under 50 ms', (context) => {
    const from = typedNote(5000).getText(BODY).toString()
    const to = from.replaceAll(' the ', ' THE ')
    expect(from.length).toBeGreaterThan(1_000_000)
    let edits = textEdits(from, to)
    const ms = best(() => {
      edits = textEdits(from, to)
    }, 3)
    let text = from
    for (const edit of edits.toReversed())
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    expect(text).toBe(to)
    expectWithinBudget(context, ms, 50)
  })

  // Typing a character at a time and deleting some: what deleted characters leave behind grows with
  // the edits, never faster.
  it('keeps a state that grows linearly with the edits typed', () => {
    const typed = (keys: number) => {
      const doc = new Y.Doc()
      doc.clientID = 1
      const text = doc.getText(BODY)
      const next = random(keys)
      for (let i = 0; i < keys; i += 1) {
        const at = next() < 0.9 ? text.length : Math.floor(next() * text.length)
        if (i % 7 === 6 && text.length > 0) text.delete(Math.max(0, at - 1), 1)
        else text.insert(at, 'x')
      }
      return Y.encodeStateAsUpdate(doc).length
    }
    const small = typed(10_000)
    const large = typed(40_000)
    expect(large / small).toBeLessThan(5)
    // About 4 bytes per key in a state the editor saves: a typed note's state stays a few times its text.
    expect(large / 40_000).toBeLessThan(8)
  })
})

describe('a body write to a long note on SQLite', { timeout: TIMEOUT_MS }, () => {
  let storage: SqliteAdapter | undefined
  afterAll(() => storage?.close())

  // An outside writer or a restore replaces the body; the service diffs it into the note's Yjs text and saves.
  it('writes a body with 20 changed lines and saves it in under 100 ms', async (context) => {
    storage = openSqliteAdapter(join(tempDir('devot-yjs-bench-'), 'devot.sqlite'))
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const id = await notes.create('Long note')
    const body = typedNote(PARAGRAPHS).getText(BODY).toString()
    await notes.setBody(id, body)
    await notes.flush()
    const times: number[] = []
    let current = body
    for (let round = 0; round < 7; round += 1) {
      const lines = current.split('\n')
      for (let i = 0; i < 20; i += 1) {
        const at = Math.floor(((i + 0.5) * lines.length) / 20)
        lines[at] = `${lines[at]} ${round}`
      }
      current = lines.join('\n')
      const start = performance.now()
      await notes.setBody(id, current)
      await notes.flush()
      times.push(performance.now() - start)
    }
    expect((await storage.getNote(id))!.bodyMd).toBe(current)
    expectWithinBudget(context, times.sort((a, b) => a - b)[3]!, 100)
  })
})
