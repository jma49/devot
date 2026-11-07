// What sync costs while typing in a 2 MB note: each push reads the note's whole record, decodes its
// state and sends all of it, through the same base64 and IPC copies as the app (the page's JSON).
// A pass runs between its 'syncing' and 'idle' reports with no timer in between, so the time
// between them is its work.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  observeWrites,
} from '../../src/core'
import { createSyncEngine, PUSH_IDLE_MS, pushPaceMs } from '../../src/core/sync/engine'
import { decodeRecord } from '../../src/core/sync/records'
import type { SyncTransport } from '../../src/core/sync/transport'
import { fromWireSync, type WireSync } from '../../src/renderer/src/storage/syncWire'
import { fromBase64, toBase64 } from '../../src/renderer/src/storage/wire'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTE_BYTES = 2_000_000
const TYPED_MS = 60_000

let storage: SqliteAdapter
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  storage = openSqliteAdapter(join(tempDir('devot-sync-push-'), 'db.sqlite'))
})
afterEach(() => {
  vi.useRealTimers()
  storage.close()
})

const ipc = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The store as the worker reaches it: rows cross as JSON, a note's state as base64. */
function wireOf(store: SqliteAdapter): WireSync {
  return {
    syncPending: (after, limit) => store.syncPending(after, limit),
    syncPendingCount: () => store.syncPendingCount(),
    syncPut: (entry) => store.syncPut(entry),
    syncState: () => store.syncState(),
    syncSetState: (key, value) => store.syncSetState(key, value),
    syncReset: () => store.syncReset(),
    syncPurge: (id, at, hlc) => store.syncPurge(id, at, hlc),
    syncFileDelete: (id) => store.syncFileDelete(id),
    async syncRead(ids) {
      const rows = await store.syncRead(ids)
      return ipc(
        rows.map((row) => ({
          ...row,
          note: row.note && {
            ...row.note,
            note: { ...row.note.note, ydoc: toBase64(row.note.note.ydoc) },
          },
        })),
      )
    },
    syncFileData: async () => null,
    syncFilePut: async () => {},
  }
}

const block = (i: number) =>
  `## Section ${i}\n\nSome **bold** text, a [link](https://example.com/${i}) and \`code\`.\n\n` +
  `- one\n- two with *emphasis*\n\n| a | b |\n|---|---|\n| ${i} | x |\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`\n\n`

async function typeFor() {
  const clock = createClock('mac')
  const newId = createIdGenerator()
  const sent = { pushes: 0, bytes: 0, ms: 0 }
  let passFrom: number | undefined
  let version = 0
  let last: { id: string; plaintext: Uint8Array } | undefined
  const transport: SyncTransport = {
    connect: async () => ({ time: Date.now(), epoch: 'e1', cursor: '', device: 'd' }),
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async (id, _base, plaintext) => {
      last = { id, plaintext }
      sent.bytes += fromBase64(ipc(toBase64(plaintext))).length
      sent.pushes += 1
      return { type: 'pushed', version: (version += 1), seq: version, tag: '' }
    },
    pushMany: async () => [],
    close: async () => {},
  }
  const engine = createSyncEngine({
    storage,
    sync: fromWireSync(wireOf(storage)),
    transport,
    clock,
    newId,
    random: () => 0.5,
    onStatus: (status) => {
      if (status.state === 'syncing') passFrom ??= performance.now()
      if (status.state !== 'idle' || passFrom === undefined) return
      sent.ms += performance.now() - passFrom
      passFrom = undefined
    },
  })
  const notes = createNoteService({
    storage: observeWrites(storage, () => engine.touch()),
    clock,
    newId,
    saveDelayMs: 300,
  })
  engine.start()
  await engine.idle()
  let body = ''
  for (let i = 0; body.length < NOTE_BYTES; i += 1) body += block(i)
  const id = await notes.create('Large')
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(70_000)
  await engine.idle()
  sent.pushes = 0
  sent.bytes = 0
  sent.ms = 0
  let keys = 0
  // Five keys a second, with a pause of 3 s after every 5 s of typing.
  for (let second = 0; second < TYPED_MS / 1_000; second += 1) {
    for (let tick = 0; tick < 5; tick += 1) {
      if (second % 8 < 5) {
        const at = 1_000 + keys * 3
        body = `${body.slice(0, at)}x${body.slice(at)}`
        await notes.setBody(id, body)
        keys += 1
      }
      await vi.advanceTimersByTimeAsync(200)
    }
  }
  // Until the last edit has gone out, which a large note sends at its pace.
  await vi.advanceTimersByTimeAsync(pushPaceMs(NOTE_BYTES) + PUSH_IDLE_MS)
  await engine.idle()
  await engine.stop()
  const record = last && decodeRecord(last.id, last.plaintext)
  const doc = new Y.Doc()
  if (record?.kind === 'note') Y.applyUpdate(doc, record.ydoc)
  return { keys, ...sent, lastBody: doc.getText(BODY).toString(), body }
}

it(
  'costs well under a millisecond a keystroke and sends the note a few times a minute',
  { timeout: 300_000 },
  async (context) => {
    const typed = await typeFor()
    const perKey = typed.ms / typed.keys
    console.info(
      `sync per keystroke ${perKey.toFixed(3)} ms, ${typed.pushes} pushes, ${typed.bytes} bytes, passes ${typed.ms.toFixed(0)} ms`,
    )
    expect(typed.lastBody).toBe(typed.body)
    expect(typed.pushes).toBeLessThanOrEqual(5)
    expect(typed.bytes).toBeLessThanOrEqual(5 * 1.1 * NOTE_BYTES)
    expectWithinBudget(context, perKey, 0.5)
  },
)
