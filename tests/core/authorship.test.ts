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
  MAX_REPORTED_INVALID,
  newAuthorshipId,
  newWriter,
  packRanges,
  PUT_BACK,
  readAllWrites,
  readWriters,
  readWrites,
  recordTransaction,
  reverseWrite,
  reverseWrites,
  RESTORED,
  restoreWrites,
  reviewSteps,
  UNDONE,
  undoGroup,
  undoWrite,
  unpackRanges,
  validWriterName,
  WRITERS,
  WRITES,
  type ReviewStep,
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
    expect(unpackRanges(packRanges([], []))).toEqual({
      inserted: [],
      deleted: [],
    })
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
    expect(write).toMatchObject({
      id,
      session: claude.session,
      at: 1000,
      created: false,
    })
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
    applyAgentEdit(doc, {
      writer: claude,
      at: 5,
      markdown: 'One\n',
      created: true,
    })
    applyAgentEdit(doc, {
      writer: codex,
      at: 9,
      fields: ['tags', 'nonsense' as 'tags'],
    })
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

  it('logs each invalid record once, remembering a bounded number of them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = new Y.Doc()
    bad.getMap(WRITERS).set('not-a-writer', { v: 1 })
    const logged = () => warn.mock.calls.filter((call) => call.includes('note-once')).length
    readWriters(bad, 'note-once')
    readWriters(bad, 'note-once')
    expect(logged()).toBe(1)
    const many = new Y.Doc()
    for (let i = 0; i < MAX_REPORTED_INVALID; i += 1) many.getMap(WRITERS).set(`bad-${i}`, { v: 1 })
    readWriters(many, 'note-many')
    readWriters(bad, 'note-once')
    expect(logged()).toBe(2)
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

    const result = reverseWrites(owner, {
      kind: 'mcp',
      names: ['Claude Code'],
    })
    expect(result).toEqual({ writes: 2, dropped: 0 })
    // The owner's word typed inside the agent's paragraph stays on its own (ADR 0007, risk 2).
    expect(body(owner)).toBe('Title\nAlpha beta gammareally .\nCodex line.\n')
    expect(agentText(owner)).toBe('Codex line.\n')
    expect(readWrites(owner)).toHaveLength(1)
  })

  it('undoes every name it is given as one writer, and only those', () => {
    const desktop = newWriter('mcp', 'claude-ai', 'mcp1111111111ab')
    const agentMode = newWriter('mcp', 'local-agent-mode-devot', 'mcp2222222222ab')
    const owner = docWith('Intro.\n')
    let agent = loaded(owner, 2)
    edit(agent, desktop, 'Intro.\nFrom the app.\n')
    sync(agent, owner)
    agent = loaded(owner, 3)
    edit(agent, codex, `${body(agent)}Codex line.\n`, 1500)
    sync(agent, owner)
    agent = loaded(owner, 4)
    edit(agent, agentMode, body(agent).replace('the app', 'agent mode'), 2000)
    sync(agent, owner)
    expect(body(owner)).toBe('Intro.\nFrom agent mode.\nCodex line.\n')

    const result = reverseWrites(owner, {
      kind: 'mcp',
      names: ['claude-ai', 'local-agent-mode-devot'],
    })
    expect(result).toEqual({ writes: 2, dropped: 0 })
    expect(body(owner)).toBe('Intro.\nCodex line.\n')
    expect(agentText(owner)).toBe('Codex line.\n')
  })

  it('keeps a writer’s text gone when two writers changed the same passage, undone in order', () => {
    const owner = docWith('Intro.\n')
    let agent = loaded(owner, 2)
    edit(agent, claude, 'Intro.\nAlpha wrote this paragraph.\n')
    sync(agent, owner)
    agent = loaded(owner, 3)
    edit(agent, codex, 'Intro.\nBeta replaced it.\n', 2000)
    sync(agent, owner)
    expect(body(owner)).toBe('Intro.\nBeta replaced it.\n')

    reverseWrites(owner, { kind: 'mcp', names: ['Claude Code'] })
    reverseWrites(owner, { kind: 'mcp', names: ['Codex'] })
    expect(body(owner)).toBe('Intro.\n')
    expect(agentText(owner)).toBe('')
  })

  it('takes back a writer’s restored text when the writer is undone after the one that replaced it', () => {
    const owner = docWith('Intro.\n')
    let agent = loaded(owner, 2)
    edit(agent, claude, 'Intro.\nAlpha wrote this paragraph.\n')
    sync(agent, owner)
    agent = loaded(owner, 3)
    edit(agent, codex, 'Intro.\nBeta replaced it.\n', 2000)
    sync(agent, owner)

    reverseWrites(owner, { kind: 'mcp', names: ['Codex'] })
    // The text Claude wrote comes back, still Claude's, so its own Undo All takes it out.
    expect(body(owner)).toBe('Intro.\nAlpha wrote this paragraph.\n')
    expect(agentText(owner)).toBe('Alpha wrote this paragraph.\n')
    reverseWrites(owner, { kind: 'mcp', names: ['Claude Code'] })
    expect(body(owner)).toBe('Intro.\n')
    expect(agentText(owner)).toBe('')
  })

  it('does not put back text the writer deleted that it had inserted itself', () => {
    const owner = docWith('Start.\n')
    let agent = loaded(owner, 2)
    edit(agent, claude, 'Start.\nTemporary.\n')
    sync(agent, owner)
    agent = loaded(owner, 3)
    edit(agent, claude, 'Started.\n')
    sync(agent, owner)
    reverseWrites(owner, { kind: 'mcp', names: ['Claude Code'] })
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
    reverseWrites(owner, { kind: 'mcp', names: ['Claude Code'] })
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
    reverseWrites(a, { kind: 'mcp', names: ['Claude Code'] })
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
    expect(reverseWrites(agent, { kind: 'mcp', names: ['Claude Code'] })).toEqual({
      writes: 1,
      dropped: 1,
    })
    expect(body(agent)).toBe('Keep this. .\n')
  })

  it('records the text an undo of Undo All puts back as the same session’s write', () => {
    const doc = docWith('Owner.\n')
    edit(doc, claude, 'Owner.\nClaude line.\n')
    edit(doc, codex, 'Owner.\nClaude line.\nCodex line.\n', 2000)
    const [undone] = readWrites(doc)
    reverseWrites(doc, { kind: 'mcp', names: ['Claude Code'] })
    expect(body(doc)).toBe('Owner.\nCodex line.\n')
    let recorded = false
    const put = (tr: Y.Transaction) => {
      doc.off('afterTransaction', put)
      recorded = recordTransaction(doc, tr, {
        id: newAuthorshipId(),
        session: undone!.session,
        at: 5000,
      })
    }
    doc.on('afterTransaction', put)
    doc.getText('body').insert('Owner.\n'.length, 'Claude line.\n')
    expect(recorded).toBe(true)
    expect(agentText(doc)).toBe('Claude line.\n|Codex line.\n')
    expect(agentWriteRows(doc).map((row) => [row.name, row.at])).toEqual([
      ['Claude Code', 5000],
      ['Codex', 2000],
    ])
    // Undo All takes it out again.
    reverseWrites(doc, { kind: 'mcp', names: ['Claude Code'] })
    expect(body(doc)).toBe('Owner.\nCodex line.\n')
  })

  it('records nothing for an unknown session or a transaction that left the body alone', () => {
    const doc = docWith('Owner.\n')
    const results: boolean[] = []
    const put = (session: string) => (tr: Y.Transaction) =>
      results.push(recordTransaction(doc, tr, { id: newAuthorshipId(), session, at: 1 }))
    const unknown = put(newAuthorshipId())
    doc.on('afterTransaction', unknown)
    doc.getText('body').insert(0, 'x')
    doc.off('afterTransaction', unknown)
    edit(doc, claude, 'Owner.\nClaude.\n')
    const known = put(claude.session)
    doc.on('afterTransaction', known)
    doc.getMap('other').set('k', 1)
    doc.off('afterTransaction', known)
    expect(results).toEqual([false, false])
    expect(readWrites(doc)).toHaveLength(1)
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
    applyAgentEdit(doc, {
      writer: claude,
      at: 2,
      markdown: '',
      maxRemovedBytes: max,
    })
    const [older, newer] = readWrites(doc)
    expect(older!.removed).toBeUndefined()
    expect(newer!.removed).toBe(`${'b'.repeat(600)}\n`)
  })
})

describe('the deleted text of an undone write', () => {
  it('is dropped, so it does not push a live writer’s text out of the cap', () => {
    const doc = docWith(`${'a'.repeat(600)}\n${'b'.repeat(600)}\n`)
    const max = 1300
    applyAgentEdit(doc, {
      writer: codex,
      at: 1,
      markdown: `${'b'.repeat(600)}\n`,
      maxRemovedBytes: max,
    })
    applyAgentEdit(doc, {
      writer: claude,
      at: 2,
      markdown: '',
      maxRemovedBytes: max,
    })
    reverseWrites(doc, { kind: 'mcp', names: ['Claude Code'] })
    const undone = [...doc.getMap(UNDONE).keys()]
    expect(undone).toHaveLength(1)
    expect(doc.getMap(WRITES).get(undone[0]!)).not.toHaveProperty('removed')
    applyAgentEdit(doc, {
      writer: codex,
      at: 3,
      markdown: '',
      maxRemovedBytes: max,
    })
    expect(readWrites(doc)[0]!.removed).toBe(`${'a'.repeat(600)}\n`)
  })
})

describe('two devices changing one write before they sync', () => {
  const gemini = newWriter('mcp', 'Gemini', 'mcp5555555555ab')

  /** Two devices from one state; `b`, with the higher client, wins a concurrent set of one key. */
  const devices = (base: Y.Doc) => [loaded(base, 10), loaded(base, 20)] as const
  const exchange = (a: Y.Doc, b: Y.Doc) => {
    sync(a, b)
    sync(b, a)
  }

  it('keeps a write undone on one device when the other drops its deleted text', () => {
    const base = docWith('Keep. Old text here.\n')
    const agent = loaded(base, 2)
    const x = edit(agent, claude, 'Keep. New.\n')!
    sync(agent, base)
    const [a, b] = devices(base)
    expect(reverseWrites(a, { kind: 'mcp', names: ['Claude Code'] }).writes).toBe(1)
    applyAgentEdit(b, {
      writer: codex,
      at: 2000,
      markdown: 'New.\n',
      maxRemovedBytes: 6,
    })
    expect(readAllWrites(b).find((w) => w.id === x)).toMatchObject({
      state: 'dropped',
    })
    exchange(a, b)
    for (const doc of [a, b]) {
      expect(readAllWrites(doc).find((w) => w.id === x)).toMatchObject({
        state: 'reversed',
      })
      expect(readWrites(doc).map((w) => w.session)).toEqual([codex.session])
      expect(reverseWrites(doc, { kind: 'mcp', names: ['Claude Code'] })).toEqual({
        writes: 0,
        dropped: 0,
      })
    }
  })

  it('keeps every range two devices put back into one writer’s text', () => {
    const base = docWith('Intro.\n')
    for (const [writer, markdown] of [
      [claude, 'Intro.\nOne two three four.\n'],
      [codex, 'Intro.\nOne three four.\n'],
      [gemini, 'Intro.\nOne three .\n'],
    ] as const) {
      const agent = loaded(base, 2)
      edit(agent, writer, markdown)
      sync(agent, base)
    }
    const [a, b] = devices(base)
    reverseWrites(a, { kind: 'mcp', names: ['Codex'] })
    reverseWrites(b, { kind: 'mcp', names: ['Gemini'] })
    exchange(a, b)
    for (const doc of [a, b]) {
      expect(body(doc)).toBe('Intro.\nOne two three four.\n')
      expect(agentText(doc)).toBe('One two three four.\n')
    }
    reverseWrites(a, { kind: 'mcp', names: ['Claude Code'] })
    expect(body(a)).toBe('Intro.\n')
    clearAuthorship(a)
    expect([a.getMap(UNDONE).size, a.getMap(RESTORED).size]).toEqual([0, 0])
  })

  it('marks an undone write in its record too, which an earlier build reads', () => {
    const doc = docWith('Owner. Old.\n')
    const id = edit(doc, claude, 'Owner.\nClaude.\n')!
    reverseWrites(doc, { kind: 'mcp', names: ['Claude Code'] })
    const raw = doc.getMap(WRITES).get(id)
    expect(raw).toMatchObject({ reversed: true })
    expect(raw).not.toHaveProperty('removed')
  })

  it('reads a write an earlier build undid in its record as undone', () => {
    const doc = docWith('Owner.\n')
    const id = edit(doc, claude, 'Owner.\nClaude.\n')!
    const writes = doc.getMap(WRITES)
    writes.set(id, { ...(writes.get(id) as object), reversed: true })
    expect(readAllWrites(doc)[0]).toMatchObject({ id, state: 'reversed' })
    expect(readWrites(doc)).toEqual([])
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
    expect(steps[1]).toEqual({
      writeId: replaced,
      from: 10,
      to: 11,
      deleted: true,
      anchor: expect.any(String),
      end: expect.any(String),
      removed: 'two',
    })
    expect(steps[2]).toEqual({
      writeId: cut,
      from: 17,
      to: 17,
      deleted: true,
      anchor: expect.any(String),
      end: expect.any(String),
      removed: ' four',
    })
  })

  it('carries deleted text per hunk across multi-hunk writes and omits removed when dropped', () => {
    const doc = docWith('Alpha\nbeta\ngamma\ndelta\n', 7)
    const multi = applyAgentEdit(doc, {
      writer: claude,
      at: 1000,
      markdown: 'Alpha\ngamma\n',
    })!
    const steps = reviewSteps(doc, new Set([multi]))
    expect(steps).toEqual([
      {
        writeId: multi,
        from: 6,
        to: 6,
        deleted: true,
        anchor: '7:6',
        end: '7:10',
        removed: 'beta\n',
      },
      {
        writeId: multi,
        from: 12,
        to: 12,
        deleted: true,
        anchor: '7:17',
        end: '7:22',
        removed: 'delta\n',
      },
    ])

    const droppedDoc = docWith('One alpha two.\n')
    const droppedWrite = applyAgentEdit(droppedDoc, {
      writer: claude,
      at: 1000,
      markdown: 'One two.\n',
      maxRemovedBytes: 0,
    })!
    const droppedSteps = reviewSteps(droppedDoc, new Set([droppedWrite]))
    expect(droppedSteps).toEqual([
      {
        writeId: droppedWrite,
        from: 4,
        to: 4,
        deleted: true,
        anchor: expect.any(String),
        end: expect.any(String),
      },
    ])
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

  it('gives a step that merged with another a new last item, so it reads as a new step', () => {
    const owner = docWith('Top.\n')
    let agent = loaded(owner, 2)
    const w1 = edit(agent, claude, 'Top.\nA1\nA2\n', 1000)!
    sync(agent, owner)
    agent = loaded(owner, 3)
    const w2 = edit(agent, codex, 'Top.\nA1\nX\nA2\n', 2000)!
    sync(agent, owner)
    const before = reviewSteps(owner)
    expect(before.map((step) => body(owner).slice(step.from, step.to))).toEqual([
      'A1\n',
      'X\n',
      'A2\n',
    ])
    reverseWrite(owner, w2)
    const after = reviewSteps(owner, new Set([w1]))
    expect(after).toHaveLength(1)
    expect(after[0]!.anchor).toBe(before[0]!.anchor)
    expect(after[0]!.end).not.toBe(before[0]!.end)
    expect(after[0]!.end).toBe(before[2]!.end)
  })

  it('anchors each step to its first item, which stays put when another step’s text goes', () => {
    const owner = docWith('Alpha.\nBeta.\nGamma.\n')
    const agent = loaded(owner, 2)
    const write = edit(agent, claude, 'Alpha.\nOne.\nBeta.\nTwo.\nGamma.\nThree.\n')!
    sync(agent, owner)
    const before = reviewSteps(owner).map((step) => step.anchor)
    expect(before).toHaveLength(3)
    expect(new Set(before).size).toBe(3)
    const text = owner.getText('body')
    text.delete(body(owner).indexOf('One.\n'), 'One.\n'.length)
    expect(reviewSteps(owner, new Set([write])).map((step) => step.anchor)).toEqual(before.slice(1))
  })

  it('splits a write’s steps where another write deleted text, whichever writes are asked for', () => {
    const doc = docWith('Start.\n')
    const a = edit(doc, claude, 'Start.\nAlpha beta gamma delta.\n')!
    const b = edit(doc, codex, 'Start.\nAlpha gamma delta.\n', 2000)!
    const extent = (step: ReviewStep) => `${step.writeId}@${step.anchor}..${step.end}`
    const both = reviewSteps(doc)
    expect(both.map((step) => step.writeId)).toEqual([a, b, a])
    expect(shown(doc)).toEqual(['Alpha ', '^', 'gamma delta.\n'])
    expect(reviewSteps(doc, new Set([a])).map(extent)).toEqual(
      both.filter((step) => step.writeId === a).map(extent),
    )
    expect(reviewSteps(doc, new Set([b])).map(extent)).toEqual(
      both.filter((step) => step.writeId === b).map(extent),
    )
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

describe('per-write Undo', () => {
  it('reverts only the named write and preserves earlier writes by the same writer', () => {
    const owner = docWith('Intro.\n')
    let agent = loaded(owner, 2)
    const first = edit(agent, claude, 'Intro.\nFirst clause.\n', 1000)!
    sync(agent, owner)
    agent = loaded(owner, 3)
    const second = edit(agent, claude, 'Intro.\nFirst line.\nSecond line.\n', 2000)!
    sync(agent, owner)
    expect(body(owner)).toBe('Intro.\nFirst line.\nSecond line.\n')

    const result = reverseWrite(owner, second)
    expect(result).toEqual({ writes: 1, dropped: 0 })
    expect(body(owner)).toBe('Intro.\nFirst clause.\n')
    // Text from the earlier write that came back stays attributed to the earlier write.
    expect(agentText(owner)).toBe('First clause.\n')
    expect(readWrites(owner).map((w) => w.id)).toEqual([first])
  })

  it('undoes later writes that rewrote the named write’s text along with it, newest first', () => {
    const owner = docWith('Intro.\n')
    const first = edit(owner, claude, 'Intro.\nAlpha beta gamma.\n', 1000)!
    const second = edit(owner, claude, 'Intro.\nAlpha gamma delta.\n', 2000)!
    const apart = edit(owner, codex, 'Start.\nIntro.\nAlpha gamma delta.\n', 3000)!
    expect(undoGroup(owner, first)).toEqual([second, first])
    expect(undoGroup(owner, second)).toEqual([second])
    expect(undoGroup(owner, apart)).toEqual([apart])

    expect(reverseWrite(owner, first)).toEqual({ writes: 2, dropped: 0 })
    expect(body(owner)).toBe('Start.\nIntro.\n')
    expect(readWrites(owner).map((w) => w.id)).toEqual([apart])
  })

  it('puts text two writes both deleted back once, though they are undone one at a time', () => {
    const owner = docWith('Keep REMOVE me end.\n')
    const a = loaded(owner, 2)
    const b = loaded(owner, 3)
    const first = edit(a, claude, 'Keep me end.\n', 1000)!
    const second = edit(b, codex, 'Keep me end.\n', 2000)!
    sync(a, owner)
    sync(b, owner)
    expect(body(owner)).toBe('Keep me end.\n')

    reverseWrite(owner, first)
    expect(body(owner)).toBe('Keep REMOVE me end.\n')
    const other = loaded(owner, 4)
    reverseWrite(other, second)
    expect(body(other)).toBe('Keep REMOVE me end.\n')
  })

  it('remembers text it put back though another device set the write’s record at the same time', () => {
    for (const [undoer, setter] of [
      [4, 5],
      [5, 4],
    ]) {
      const owner = docWith('Keep REMOVE me end.\n')
      const a = loaded(owner, 2)
      const b = loaded(owner, 3)
      const first = edit(a, claude, 'Keep me end.\n', 1000)!
      const second = edit(b, codex, 'Keep me end.\n', 2000)!
      sync(a, owner)
      sync(b, owner)

      const undoing = loaded(owner, undoer!)
      const setting = loaded(owner, setter!)
      reverseWrite(undoing, first)
      const records = setting.getMap('writes')
      records.set(first, { ...(records.get(first) as object) })
      sync(undoing, setting)
      sync(setting, undoing)

      reverseWrite(undoing, second)
      expect(body(undoing)).toBe('Keep REMOVE me end.\n')
      expect(undoing.getMap(PUT_BACK).size).toBe(2)
      clearAuthorship(undoing)
      expect(undoing.getMap(PUT_BACK).size).toBe(0)
    }
  })
})

describe('Restore after a group Undo', () => {
  /** What a reader sees of the writes, leaving out the IDs of the items they inserted, which Restore makes anew. */
  const states = (doc: Y.Doc) =>
    readAllWrites(doc).map(({ inserted: _inserted, ...write }) => write)
  const steps = (doc: Y.Doc) =>
    reviewSteps(doc).map(({ anchor: _anchor, end: _end, ...step }) => step)
  const runs = (doc: Y.Doc) => attribute(doc).map(({ from, to, writeId }) => [from, to, writeId])

  /** The owner's note, a write by Claude, a later Codex write that rewrote it, and one apart. */
  const rewritten = () => {
    const doc = docWith('Intro. Old owner words.\nEnd.\n')
    const first = edit(doc, claude, 'Intro. Alpha beta gamma.\nEnd.\n', 1000)!
    const second = edit(doc, codex, 'Intro. Alpha gamma delta.\nEnd.\n', 2000)!
    const apart = edit(doc, claude, 'Intro. Alpha gamma delta.\nEnd. Apart.\n', 3000)!
    return { doc, first, second, apart }
  }

  it('gives back the exact text, the authorship and the write states the Undo took', () => {
    const { doc, first, second, apart } = rewritten()
    const text = body(doc)
    const before = { states: states(doc), steps: steps(doc), runs: runs(doc) }

    const { reversal, undone } = undoWrite(doc, first)
    expect(reversal).toEqual({ writes: 2, dropped: 0 })
    expect(undone!.writes).toEqual([second, first])
    expect(body(doc)).toBe('Intro. Old owner words.\nEnd. Apart.\n')
    expect(readWrites(doc).map((w) => w.id)).toEqual([apart])

    expect(restoreWrites(doc, undone!)).toBe(true)
    expect(body(doc)).toBe(text)
    expect(states(doc)).toEqual(before.states)
    expect(steps(doc)).toEqual(before.steps)
    expect(runs(doc)).toEqual(before.runs)
    expect(undoGroup(doc, first)).toEqual([second, first])
  })

  it('takes back text the Undo gave to another writer, and keeps the restore on another device', () => {
    const doc = docWith('Owner start.\n')
    const codexWrite = edit(doc, codex, 'Owner start.\nCodex keeps this.\n', 1000)!
    const first = edit(doc, claude, 'Owner start.\nZzz qqq!\n', 2000)!
    const second = edit(doc, claude, 'Owner start.\nZzz www!\n', 3000)!
    const text = body(doc)
    const before = { states: states(doc), steps: steps(doc), runs: runs(doc) }

    const { undone } = undoWrite(doc, first)
    expect(undone!.writes).toEqual([second, first])
    expect(body(doc)).toBe('Owner start.\nCodex keeps this.\n')
    expect(doc.getMap(RESTORED).size).toBe(1)

    expect(restoreWrites(doc, undone!)).toBe(true)
    expect(body(doc)).toBe(text)
    expect(states(doc)).toEqual(before.states)
    expect(steps(doc)).toEqual(before.steps)
    expect(runs(doc)).toEqual(before.runs)
    expect(readWrites(doc).map((w) => w.id)).toEqual([codexWrite, first, second])

    const other = loaded(doc, 9)
    expect(body(other)).toBe(text)
    expect(runs(other)).toEqual(before.runs)
    // Undone again, the restored writes leave the same text as the first Undo did.
    reverseWrite(other, first)
    expect(body(other)).toBe('Owner start.\nCodex keeps this.\n')
  })

  it('refuses, changing nothing, once the note changed since the Undo', () => {
    const typed = rewritten()
    const one = undoWrite(typed.doc, typed.first).undone!
    typed.doc.getText('body').insert(0, 'x')
    const after = Y.encodeStateAsUpdate(typed.doc)
    expect(restoreWrites(typed.doc, one)).toBe(false)
    expect(Y.encodeStateAsUpdate(typed.doc)).toEqual(after)

    // A deletion alone leaves the state vector as it was.
    const cut = rewritten()
    const two = undoWrite(cut.doc, cut.first).undone!
    const vector = Y.encodeStateVector(cut.doc)
    cut.doc.getText('body').delete(0, 1)
    expect(Y.encodeStateVector(cut.doc)).toEqual(vector)
    expect(restoreWrites(cut.doc, two)).toBe(false)

    const synced = rewritten()
    const three = undoWrite(synced.doc, synced.first).undone!
    const device = loaded(synced.doc, 7)
    edit(device, codex, `${body(device)}More.\n`, 4000)
    sync(device, synced.doc)
    expect(restoreWrites(synced.doc, three)).toBe(false)
  })

  it('still takes back the Undo after the note is stored and loaded again', () => {
    const { doc, first } = rewritten()
    const text = body(doc)
    const { undone } = undoWrite(doc, first)
    const reloaded = loaded(doc, 11)
    expect(restoreWrites(reloaded, undone!)).toBe(true)
    expect(body(reloaded)).toBe(text)
  })
})
