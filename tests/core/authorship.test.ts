// The authorship records in a note's Yjs document (ADR 0007): packing, attribution, reversal and
// clearing, on documents alone. Storage, the note service and sync are in authorship-storage.test.ts.
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  agentWriteRows,
  applyAgentEdit,
  attribute,
  AUTHORSHIP_ID,
  cleanWriterName,
  clearAuthorship,
  newAuthorshipId,
  newWriter,
  packRanges,
  readWrites,
  reverseWrites,
  reviewSteps,
  unpackRanges,
  validWriterName,
  WRITERS,
  WRITES,
  type Writer,
} from '../../src/core/authorship'

const claude = newWriter('mcp', 'Claude Code', 'mcp0123456789ab')
const codex = newWriter('mcp', 'Codex', 'mcpba9876543210')

const docWith = (text: string, client = 1) => {
  const doc = new Y.Doc()
  doc.clientID = client
  doc.getText('body').insert(0, text)
  return doc
}

/** A copy as another process loads the stored state: a client of its own. */
const loaded = (doc: Y.Doc, client: number) => {
  const copy = new Y.Doc()
  copy.clientID = client
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

const sync = (from: Y.Doc, to: Y.Doc) =>
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))

const body = (doc: Y.Doc) => doc.getText('body').toString()

const agentText = (doc: Y.Doc) =>
  attribute(doc)
    .map((run) => body(doc).slice(run.from, run.to))
    .join('|')

const edit = (doc: Y.Doc, writer: Writer, markdown: string, at = 1000) =>
  applyAgentEdit(doc, { writer, at, markdown })

describe('authorship IDs and names', () => {
  it('makes 64-bit base64url IDs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAuthorshipId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(AUTHORSHIP_ID)
    expect(newAuthorshipId(() => new Uint8Array(8).fill(255))).toBe('__________8')
    expect(newAuthorshipId(() => new Uint8Array(8))).toBe('AAAAAAAAAAA')
  })

  it('keeps a client name to one line of at most 100 code points without controls', () => {
    expect(cleanWriterName('  Claude\nCode\u0007 ')).toBe('Claude Code')
    expect(cleanWriterName('evil\u202eedoC')).toBe('evil edoC')
    expect(cleanWriterName('half \ud800 pair')).toBe('half pair')
    expect(validWriterName('half \ud800')).toBe(false)
    expect(validWriterName('Claude Code')).toBe(true)
    expect([...cleanWriterName('\u{1F600}'.repeat(150))]).toHaveLength(100)
  })

  it('packs inserted and deleted ranges as varuints and reads them back', () => {
    const inserted = [{ client: 4_294_967_295, clock: 0, length: 3 }]
    const deleted = [
      { client: 7, clock: 2 ** 40, length: 1 },
      { client: 8, clock: 5, length: 300 },
    ]
    const packed = packRanges(inserted, deleted)
    expect(unpackRanges(packed)).toEqual({ inserted, deleted })
    expect(unpackRanges(packRanges([], []))).toEqual({ inserted: [], deleted: [] })
    expect(unpackRanges(packed.slice(0, packed.length - 1))).toBeNull()
    // More inserted ranges than ranges, a zero length, a client not in the list.
    expect(unpackRanges(new Uint8Array([1, 7, 5, 0, 1, 1]))).toBeNull()
    expect(unpackRanges(new Uint8Array([1, 7, 0, 0, 1, 0]))).toBeNull()
    expect(unpackRanges(new Uint8Array([1, 7, 0, 1, 1, 1]))).toBeNull()
    expect(unpackRanges(new Uint8Array([1, 7, 0, 0, 1, 1]))).toEqual({
      inserted: [],
      deleted: [{ client: 7, clock: 1, length: 1 }],
    })
  })
})

describe('recording a write', () => {
  it('records what it inserted and deleted, with the deleted text, in one transaction', () => {
    const doc = loaded(docWith('Milk and eggs.\n'), 2)
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    const id = edit(doc, claude, 'Milk, eggs and bread.\n')!
    expect(updates).toHaveLength(1)
    const [write] = readWrites(doc)
    expect(write).toMatchObject({ id, session: claude.session, at: 1000, created: false })
    expect(write!.removed).toBe(' and eggs')
    expect(agentText(doc)).toBe(', eggs and bread')
    expect(doc.getMap(WRITERS).get(claude.session)).toEqual({
      v: 1,
      kind: 'mcp',
      name: 'Claude Code',
      process: 'mcp0123456789ab',
    })
  })

  it('records nothing for a write that changes nothing', () => {
    const doc = docWith('Same\n')
    expect(edit(doc, claude, 'Same\n')).toBeNull()
    expect(doc.getMap(WRITES).size).toBe(0)
    expect(applyAgentEdit(doc, { writer: claude, at: 1, fields: ['title'] })).toMatch(AUTHORSHIP_ID)
  })

  it('derives the rows of the index, newest first', () => {
    const doc = docWith('')
    applyAgentEdit(doc, { writer: claude, at: 5, markdown: 'One\n', created: true })
    applyAgentEdit(doc, { writer: codex, at: 9, fields: ['tags', 'nonsense' as 'tags'] })
    const rows = agentWriteRows(doc)
    expect(rows.map((r) => [r.kind, r.name, r.at, r.created])).toEqual([
      ['mcp', 'Codex', 9, false],
      ['mcp', 'Claude Code', 5, true],
    ])
    expect(readWrites(doc)[1]!.fields).toEqual(['tags'])
  })

  it('skips records that do not parse and keeps them in the map', () => {
    const doc = docWith('Text\n')
    edit(doc, claude, 'Text and more\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    doc.getMap(WRITES).set('bad', { v: 1 })
    doc.getMap(WRITES).set(newAuthorshipId(), { v: 2, writer: claude.session })
    doc.getMap(WRITERS).set(newAuthorshipId(), { v: 1, kind: 'owner', name: '', process: '' })
    expect(readWrites(doc, 'note-1')).toHaveLength(1)
    expect(agentText(doc)).toBe(' and more')
    expect(doc.getMap(WRITES).size).toBe(3)
    expect(warn).toHaveBeenCalledWith('W_AUTHORSHIP_RECORD_INVALID', 'note-1')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('Text')
    warn.mockRestore()
  })
})

describe('attribution', () => {
  it('keeps the owner’s typing inside and after agent text as the owner’s', () => {
    const owner = docWith('Intro.\n')
    const agent = loaded(owner, 2)
    edit(agent, claude, 'Intro.\nAgent paragraph here.\n')
    sync(agent, owner)
    const text = owner.getText('body')
    text.insert(text.toString().indexOf('paragraph'), 'long ')
    text.insert(text.length, 'Owner line.\n')
    expect(body(owner)).toBe('Intro.\nAgent long paragraph here.\nOwner line.\n')
    expect(agentText(owner)).toBe('Agent |paragraph here.\n')
  })

  it('attributes alike on every copy, through garbage collection and merges', () => {
    const owner = docWith('Base text.\n')
    const agent = loaded(owner, 2)
    edit(agent, claude, 'Base text, changed.\n')
    sync(agent, owner)
    const other = loaded(owner, 3)
    other.getText('body').insert(0, 'Other device. ')
    sync(other, owner)
    sync(owner, other)
    expect(body(owner)).toBe(body(other))
    expect(agentText(owner)).toBe(agentText(other))
    expect(agentText(loaded(owner, 9))).toBe(', changed')
  })
})

describe('Undo All', () => {
  it('reverts one writer’s changes and keeps the owner’s later edits and other writers’ text', () => {
    const owner = docWith('Alpha beta gamma.\n')
    let agent = loaded(owner, 2)
    edit(agent, claude, 'Alpha BETA gamma.\nClaude wrote this.\n')
    sync(agent, owner)
    // The owner types inside the agent's text and elsewhere.
    const text = owner.getText('body')
    text.insert(body(owner).indexOf('wrote'), 'really ')
    text.insert(0, 'Title\n')
    agent = loaded(owner, 3)
    edit(agent, codex, `${body(agent)}Codex line.\n`)
    sync(agent, owner)
    agent = loaded(owner, 4)
    edit(agent, claude, body(agent).replace('gamma', 'delta'), 2000)
    sync(agent, owner)
    expect(body(owner)).toBe('Title\nAlpha BETA delta.\nClaude really wrote this.\nCodex line.\n')

    const result = reverseWrites(owner, { kind: 'mcp', name: 'Claude Code' })
    expect(result).toEqual({ writes: 2, dropped: 0 })
    // The owner's word typed inside the agent's paragraph stays on its own (ADR 0007, risk 2).
    expect(body(owner)).toBe('Title\nAlpha beta gammareally .\nCodex line.\n')
    expect(agentText(owner)).toBe('Codex line.\n')
    expect(readWrites(owner)).toHaveLength(1)
  })

  it('does not put back text the writer deleted that it had inserted itself', () => {
    const owner = docWith('Start.\n')
    let agent = loaded(owner, 2)
    edit(agent, claude, 'Start.\nTemporary.\n')
    sync(agent, owner)
    agent = loaded(owner, 3)
    edit(agent, claude, 'Started.\n')
    sync(agent, owner)
    reverseWrites(owner, { kind: 'mcp', name: 'Claude Code' })
    expect(body(owner)).toBe('Start.\n')
  })

  it('puts deleted words back in their own places when the owner typed them in one go', () => {
    const owner = docWith('AAA.\n\nBBB.\n\nCCC.\n', 7)
    const text = owner.getText('body')
    // Consecutive clocks for both words, with live text between them.
    text.insert(3, 'foo')
    text.insert(body(owner).indexOf('BBB') + 3, 'bar')
    const agent = loaded(owner, 2)
    edit(agent, claude, 'AAA.\n\nBBB.\n\nCCC.\n')
    sync(agent, owner)
    reverseWrites(owner, { kind: 'mcp', name: 'Claude Code' })
    expect(body(owner)).toBe('AAAfoo.\n\nBBBbar.\n\nCCC.\n')
  })

  it('reverts on a merged copy, after another device’s edit', () => {
    const a = docWith('One two three.\n')
    const agent = loaded(a, 2)
    edit(agent, claude, 'One 2 three. Four.\n')
    sync(agent, a)
    const b = loaded(a, 3)
    b.getText('body').insert(0, 'From B. ')
    sync(b, a)
    reverseWrites(a, { kind: 'mcp', name: 'Claude Code' })
    expect(body(a)).toBe('From B. One two three.\n')
    sync(a, b)
    expect(body(b)).toBe(body(a))
  })

  it('takes out only what a write inserted when its deleted text was dropped', () => {
    const doc = docWith('Keep this. Drop this.\n')
    const agent = loaded(doc, 2)
    applyAgentEdit(agent, {
      writer: claude,
      at: 1,
      markdown: 'Keep this. New.\n',
      maxRemovedBytes: 0,
    })
    expect(readWrites(agent)[0]!.removed).toBeUndefined()
    expect(reverseWrites(agent, { kind: 'mcp', name: 'Claude Code' })).toEqual({
      writes: 1,
      dropped: 1,
    })
    expect(body(agent)).toBe('Keep this. .\n')
  })

  it('caps the deleted text a note keeps, dropping the oldest first', () => {
    const doc = docWith(`${'a'.repeat(600)}\n${'b'.repeat(600)}\n`)
    const max = 1000
    applyAgentEdit(doc, {
      writer: claude,
      at: 1,
      markdown: `${'b'.repeat(600)}\n`,
      maxRemovedBytes: max,
    })
    applyAgentEdit(doc, { writer: claude, at: 2, markdown: '', maxRemovedBytes: max })
    const [older, newer] = readWrites(doc)
    expect(older!.removed).toBeUndefined()
    expect(newer!.removed).toBe(`${'b'.repeat(600)}\n`)
  })
})

describe('Clear Authorship', () => {
  it('deletes every record, and the merge keeps a write the clear had not seen', () => {
    const a = docWith('Text.\n')
    const agent = loaded(a, 2)
    edit(agent, claude, 'Text. More.\n')
    sync(agent, a)
    const b = loaded(a, 3)
    edit(b, codex, 'Text. More. Codex.\n')
    expect(clearAuthorship(a)).toBe(1)
    expect(attribute(a)).toEqual([])
    expect(a.getMap(WRITERS).size).toBe(0)
    sync(b, a)
    expect(agentText(a)).toBe(' Codex.')
    expect(body(a)).toBe('Text. More. Codex.\n')
  })

  it('counts a concurrent write as cleared when the clear took its writer, until the session writes again', () => {
    const a = docWith('Text.\n')
    const b = loaded(a, 2)
    edit(b, claude, 'Text. One.\n')
    sync(b, a)
    clearAuthorship(a)
    edit(b, claude, 'Text. One. Two.\n')
    sync(a, b)
    sync(b, a)
    for (const doc of [a, b]) {
      expect(agentText(doc)).toBe('')
      expect(agentWriteRows(doc)).toEqual([])
    }
    edit(b, claude, 'Text. One. Two. Three.\n')
    sync(b, a)
    expect(agentText(a)).toBe(' Two.| Three.')
  })
})

describe('Review Changes steps', () => {
  /** Each step as the text it covers, with a mark where the write deleted text. */
  const shown = (doc: Y.Doc, only?: ReadonlySet<string>) =>
    reviewSteps(doc, only).map(
      (step) => `${body(doc).slice(step.from, step.to)}${step.deleted ? '^' : ''}`,
    )

  it('gives each write’s inserted runs, deletion points and replacements in document order', () => {
    const doc = docWith('One two three four.\n')
    const replaced = edit(doc, claude, 'One 2 three four.\n')
    const cut = edit(doc, codex, 'One 2 three.\n', 2000)
    const added = edit(doc, claude, 'Zero. One 2 three.\n', 3000)
    expect(shown(doc)).toEqual(['Zero. ', '2^', '^'])
    const steps = reviewSteps(doc)
    expect(steps.map((s) => s.writeId)).toEqual([added, replaced, cut])
    expect(steps[2]).toEqual({ writeId: cut, from: 17, to: 17, deleted: true })
  })

  it('splits a run the owner typed inside, and follows the text as it is now', () => {
    const doc = docWith('Intro.\n', 1)
    const agent = loaded(doc, 2)
    edit(agent, claude, 'Intro.\nAgent paragraph.\n')
    sync(agent, doc)
    const text = doc.getText('body')
    text.insert(0, 'Owner. ')
    text.insert(body(doc).indexOf('paragraph'), 'long ')
    expect(shown(doc)).toEqual(['Agent ', 'paragraph.\n'])
  })

  it('keeps to the writes asked for, and skips one whose writer is unknown', () => {
    const doc = docWith('A.\n')
    const first = edit(doc, claude, 'A. B.\n')!
    edit(doc, codex, 'A. B. C.\n', 2000)
    expect(shown(doc, new Set([first]))).toEqual([' B.'])
    doc.getMap(WRITERS).delete(codex.session)
    expect(shown(doc)).toEqual([' B.'])
  })
})
