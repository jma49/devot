// The cost measurement of ADR 0007, run again: a note of about 5,000 words typed a word at a time
// over 20 sessions, then 50 agent writes by two MCP clients, each in a fresh document as devot-mcp
// loads a note, with the owner typing inside the agent's text and elsewhere after each one. The same
// edits run twice, with authorship and without, so the difference is what the records add.
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyAgentEdit,
  attribute,
  clearAuthorship,
  newWriter,
  readWrites,
  reverseWrites,
  textEdits,
  type Writer,
} from '../../src/core'
import { expectWithinBudget } from '../support/budget'

/** What the ADR measured for 50 writes: 18% more stored state, and 1.7 KB left after clearing. */
const ADR_ADDED_SHARE = 0.18
const ADR_CLEARED_BYTES = 1.7 * 1024
/** A record without its deleted text, with five-byte client IDs and eight-byte times (ADR 0007, Cost). */
const RECORD_BYTES = 100
const WRITES = 50

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

/** Yjs clients are random 32-bit numbers, five bytes each as varuints. */
const client = (next: () => number) => Math.floor(next() * 0xffffffff)

const sentence = (next: () => number, words = 8 + Math.floor(next() * 8)) => {
  const picked = Array.from({ length: words }, () => WORDS[Math.floor(next() * WORDS.length)]!)
  const text = picked.join(' ')
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`
}

/** About 5,000 words, typed a word at a time by 20 sessions, with corrections. */
function typedNote(): Y.Doc {
  const next = random(7)
  const doc = new Y.Doc()
  doc.clientID = client(next)
  let words = 0
  for (let session = 0; session < 20; session += 1) {
    const typist = new Y.Doc()
    typist.clientID = client(next)
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(doc))
    const text = typist.getText('body')
    for (let i = 0; i < 253; i += 1, words += 1) {
      const word = WORDS[Math.floor(next() * WORDS.length)]!
      const end = words % 12 === 11 ? (words % 72 === 71 ? '.\n\n' : '. ') : ' '
      text.insert(text.length, word)
      if (next() < 0.1) {
        text.delete(text.length - 2, 2)
        text.insert(text.length, word.slice(-2))
      }
      text.insert(text.length, end)
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(typist, Y.encodeStateVector(doc)))
  }
  return doc
}

const sentences = (text: string) => [...text.matchAll(/[a-zA-Z][^.\n]*\./g)]

interface Run {
  owner: Y.Doc
  deleted: number
}

/** The ADR's 50 writes on a copy of `base`, recorded through `write`. */
function agentWrites(
  base: Y.Doc,
  write: (doc: Y.Doc, writer: Writer, markdown: string, at: number) => void,
): Run {
  const next = random(11)
  const writers = [
    newWriter('mcp', 'Claude Code', 'mcp000000000001'),
    newWriter('mcp', 'Codex', 'mcp000000000002'),
  ]
  const owner = new Y.Doc()
  owner.clientID = client(next)
  Y.applyUpdate(owner, Y.encodeStateAsUpdate(base))
  let deleted = 0
  for (let i = 0; i < WRITES; i += 1) {
    const agent = new Y.Doc()
    agent.clientID = client(next)
    Y.applyUpdate(agent, Y.encodeStateAsUpdate(owner))
    const text = agent.getText('body').toString()
    const found = sentences(text)
    const pick = found[Math.floor(next() * found.length)]!
    const at = pick.index
    const kind = i % 3
    const added = kind === 2 ? '' : sentence(next)
    const markdown =
      kind === 0
        ? text.slice(0, at) + added + text.slice(at + pick[0].length)
        : kind === 1
          ? `${text.slice(0, at)}${added}\n\n${text.slice(at)}`
          : text.slice(0, at) + text.slice(at + pick[0].length + 1)
    deleted += kind === 1 ? 0 : pick[0].length
    // Times as the app writes them: milliseconds since 1970, eight bytes each.
    write(agent, writers[i % 2]!, markdown, 1_790_000_000_000 + i * 60_000)
    Y.applyUpdate(owner, Y.encodeStateAsUpdate(agent, Y.encodeStateVector(owner)))
    // The owner types inside the agent's sentence, and somewhere else.
    const body = owner.getText('body')
    const inside = added ? body.toString().indexOf(added) : -1
    if (inside >= 0) body.insert(inside + Math.floor(added.length / 2), 'owner ')
    body.insert(Math.floor(next() * body.length), 'typed ')
  }
  return { owner, deleted }
}

const withAuthorship = (doc: Y.Doc, writer: Writer, markdown: string, at: number) => {
  applyAgentEdit(doc, { writer, at, markdown })
}

const withoutAuthorship = (doc: Y.Doc, _writer: Writer, markdown: string) => {
  const text = doc.getText('body')
  const edits = textEdits(text.toString(), markdown)
  doc.transact(() => {
    for (const edit of edits.reverse()) {
      if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
      if (edit.text) text.insert(edit.start, edit.text)
    }
  })
}

const size = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc).length

it('adds no more to a note than the ADR measured, and clearing gives most of it back', () => {
  const base = typedNote()
  const words = base.getText('body').toString().split(/\s+/).filter(Boolean).length
  expect(words).toBeGreaterThan(5000)
  const plain = agentWrites(base, withoutAuthorship)
  const authored = agentWrites(base, withAuthorship)
  expect(authored.owner.getText('body').toString()).toBe(plain.owner.getText('body').toString())
  const removed = readWrites(authored.owner).reduce((sum, w) => sum + (w.removed?.length ?? 0), 0)
  // The text difference keeps what a replaced sentence shares with the new one.
  expect(removed).toBeGreaterThan(authored.deleted * 0.8)
  expect(removed).toBeLessThanOrEqual(authored.deleted)
  const added = size(authored.owner) - size(plain.owner)
  expect(added / size(plain.owner)).toBeLessThan(ADR_ADDED_SHARE)
  // The records apart from the deleted text they keep, which depends on what the writes deleted.
  expect((added - removed) / WRITES).toBeLessThan(RECORD_BYTES)
  clearAuthorship(authored.owner)
  expect(size(authored.owner) - size(plain.owner)).toBeLessThan(ADR_CLEARED_BYTES)
})

it('attributes the whole note and undoes one writer within budget, keeping everyone else’s text', (context) => {
  const base = typedNote()
  const { owner } = agentWrites(base, withAuthorship)
  // Another device's edit, merged in before the Undo.
  const other = new Y.Doc()
  other.clientID = 0x7fffffff
  Y.applyUpdate(other, Y.encodeStateAsUpdate(owner))
  other.getText('body').insert(0, 'From the other device. ')
  Y.applyUpdate(owner, Y.encodeStateAsUpdate(other, Y.encodeStateVector(owner)))

  const walkStart = performance.now()
  const runs = attribute(owner)
  const walkMs = performance.now() - walkStart
  expect(runs.length).toBeGreaterThan(20)
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(owner))
  expect(attribute(copy)).toEqual(runs)

  const byWriter = new Map(readWrites(owner).map((w) => [w.id, w.session]))
  const codexSession = readWrites(owner)[1]!.session
  const body = owner.getText('body').toString()
  const codexText = runs
    .filter((r) => byWriter.get(r.writeId) === codexSession)
    .map((r) => body.slice(r.from, r.to))
    .join('')
  const typed = body.split('typed ').length - 1

  const undoStart = performance.now()
  const result = reverseWrites(owner, { kind: 'mcp', name: 'Claude Code' })
  const undoMs = performance.now() - undoStart
  expect(result).toEqual({ writes: WRITES / 2, dropped: 0 })
  const after = owner.getText('body').toString()
  const left = attribute(owner)
  expect(left.every((r) => byWriter.get(r.writeId) === codexSession)).toBe(true)
  expect(left.map((r) => after.slice(r.from, r.to)).join('')).toBe(codexText)
  expect(after).toContain('From the other device. ')
  // Owner text the writer had deleted comes back too.
  expect(after.split('typed ').length - 1).toBeGreaterThanOrEqual(typed)
  expectWithinBudget(context, walkMs, 5)
  expectWithinBudget(context, undoMs, 30)
})
