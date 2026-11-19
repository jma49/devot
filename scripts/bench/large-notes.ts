import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { arch, cpus, loadavg, release, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { percentile, round } from './stats.ts'

export function summary(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('E_BENCH_SAMPLES')
  return {
    n: values.length,
    p50: round(percentile(values, 0.5), 3),
    p95: round(percentile(values, 0.95), 3),
    max: round(Math.max(...values), 3),
  }
}

export async function runLargeNotes() {
  const { createClock, createIdGenerator, createNoteService, BODY } =
    await import('../../src/core/index.ts')
  const { openSqliteAdapter } = await import('../../tests/support/sqlite-adapter.ts')
  const { tempDir, removeTempDirs } = await import('../../tests/support/temp-dirs.ts')
  const { fromWire, toWire, toBase64, fromBase64 } =
    await import('../../src/renderer/src/storage/wire.ts')
  const { fromWireSync } = await import('../../src/renderer/src/storage/syncWire.ts')
  const { createSyncEngine } = await import('../../src/core/sync/engine.ts')
  const { sampleNote } = await import('./fixtures.ts')
  const Y = await import('yjs')
  const { build } = await import('esbuild')
  const { Miniflare, Log, LogLevel } = await import('miniflare')
  const { createVault } = await import('../../tests/relay/client.ts')
  const { RelayTransport } = await import('../../tests/support/sync-relay.ts')
  const quick = process.env['DEVOT_LARGE_QUICK'] === '1'
  const n = quick ? 5 : 30
  const machine = {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGB: round(totalmem() / 2 ** 30),
    os: `${release()} ${arch()}`,
    node: process.version,
    loadAverageAtStart: loadavg()[0],
  }
  const results: {
    bytes: number
    actualBytes: number
    paths: Record<string, ReturnType<typeof summary>>
  }[] = []
  const ipc = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const profile = process.env['DEVOT_LARGE_PROFILE'] ? new Session() : undefined
  profile?.connect()
  if (profile) await profile.post('Profiler.enable')
  const bundle = await build({
    entryPoints: ['relay/src/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    external: ['cloudflare:workers'],
    write: false,
  })
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: '2026-07-30',
    durableObjects: {
      VAULTS: { className: 'VaultObject', useSQLite: true },
      PAIRINGS: { className: 'PairingObject', useSQLite: true },
    },
    bindings: { RELAY_SECRET: 'large-bench-local-only-0123456789abcdef' },
    host: '127.0.0.1',
    port: 0,
    log: new Log(LogLevel.ERROR),
  })
  const host = {
    url: (await mf.ready).toString().replace(/\/$/, ''),
    secret: 'large-bench-local-only-0123456789abcdef',
    close: () => mf.dispose(),
  }
  try {
    for (const bytes of [100_000, 1_000_000, 5_000_000]) {
      const store = openSqliteAdapter(resolve(tempDir('devot-large-'), 'notes.sqlite'))
      const storage = fromWire(toWire(store))
      const clock = createClock('bench')
      const newId = createIdGenerator()
      const service = () => createNoteService({ storage, clock, newId, compact: false })
      const notes = service()
      const vault = await createVault(host)
      const relay = new RelayTransport({
        url: () => host.url,
        vault: vault.vault,
        token: () => vault.first.token,
      })
      await relay.connect()
      const body = sampleNote(bytes)
      const id = await notes.create('Large benchmark')
      await notes.setBody(id, body)
      await notes.flush()
      const editor = new Y.Doc()
      Y.applyUpdate(editor, (await notes.open(id)).state)
      const wireSync = {
        ...store,
        async syncFileData(fileId: string) {
          const data = await store.syncFileData(fileId)
          return data ? toBase64(data) : null
        },
        syncFilePut: (file: Parameters<typeof store.syncFilePut>[0], data: string) =>
          store.syncFilePut(file, fromBase64(data)),
        async syncRead(ids: readonly string[]) {
          return ipc(
            (await store.syncRead(ids)).map((row) => ({
              ...row,
              note: row.note && {
                ...row.note,
                note: { ...row.note.note, ydoc: toBase64(row.note.note.ydoc) },
              },
            })),
          )
        },
      }
      let version = 0
      let pushed = 0
      let lastPlaintext: Uint8Array = new Uint8Array()
      let syncNow = Date.now()
      const engine = createSyncEngine({
        storage,
        sync: fromWireSync(wireSync),
        clock,
        newId,
        now: () => syncNow,
        transport: {
          connect: async () => ({ time: syncNow, epoch: 'bench', cursor: '', device: 'd' }),
          pull: async (since) => ({ records: [], next: since, more: false }),
          push: async (_id, _base, plaintext) => {
            lastPlaintext = plaintext
            if (fromBase64(ipc(toBase64(plaintext))).length !== plaintext.length)
              throw new Error('E_BENCH_COPY')
            pushed += 1
            return { type: 'pushed', version: ++version, seq: version, tag: '' }
          },
          pushMany: async () => {
            throw new Error('E_BENCH_UNEXPECTED_BATCH')
          },
          close: async () => {},
        },
      })
      const samples: Record<string, number[]> = {}
      const time = async (path: string, action: () => Promise<unknown>, record: boolean) => {
        const start = performance.now()
        await action()
        if (record) (samples[path] ??= []).push(performance.now() - start)
      }
      try {
        engine.start()
        await engine.idle()
        for (let run = -1; run < n; run += 1) {
          syncNow += 60_000
          const record = run >= 0
          await time(
            'open-cold',
            async () => {
              const opened = await service().open(id)
              if (opened.state.length === 0) throw new Error('E_BENCH_OPEN')
            },
            record,
          )
          for (const [path, text] of [
            ['edit-save', '\nA small edited line.'],
            ['paste-save', sampleNote(10_000)],
          ] as const) {
            await time(
              path,
              async () => {
                let update: Uint8Array = new Uint8Array()
                const capture = (value: Uint8Array) => {
                  update = value
                }
                editor.on('update', capture)
                editor.getText(BODY).insert(editor.getText(BODY).length, text)
                editor.off('update', capture)
                await notes.applyUpdate(id, update)
                await notes.flush()
              },
              record,
            )
            if (profile && bytes === 5_000_000 && record) await profile.post('Profiler.start')
            await time(
              'search-catchup',
              async () => {
                const hits = await notes.search('planning')
                if (!hits.found.some((note) => note.id === id)) throw new Error('E_BENCH_SEARCH')
              },
              record,
            )
            if (profile && bytes === 5_000_000 && record) {
              const { profile: data } = await profile.post('Profiler.stop')
              writeFileSync(
                `${process.env['DEVOT_LARGE_PROFILE']}-${run}-${path}.cpuprofile`,
                JSON.stringify(data),
              )
            }
            await time('search-warm', () => notes.search('planning'), record)
            const before = pushed
            await time('sync-push-client', () => engine.syncNow(), record)
            if (pushed !== before + 1) throw new Error('E_BENCH_PUSH')
          }
          await time(
            'relay-upload-local',
            async () => {
              const answer = await relay.push(id, run + 1, lastPlaintext)
              if (answer.type !== 'pushed') throw new Error('E_BENCH_RELAY_PUSH')
            },
            record,
          )
          await time(
            'relay-download-local',
            async () => {
              const page = await relay.pull('')
              if (
                page.records.length !== 1 ||
                page.records[0]?.plaintext?.length !== lastPlaintext.length
              )
                throw new Error('E_BENCH_RELAY_PULL')
            },
            record,
          )
          let reset: Uint8Array = new Uint8Array()
          const capture = (value: Uint8Array) => {
            reset = value
          }
          editor.on('update', capture)
          editor.getText(BODY).delete(body.length, editor.getText(BODY).length - body.length)
          editor.off('update', capture)
          await notes.applyUpdate(id, reset)
          await notes.flush()
          await notes.search('planning')
          await engine.syncNow()
        }
        results.push({
          bytes,
          actualBytes: Buffer.byteLength(body),
          paths: Object.fromEntries(
            Object.entries(samples).map(([path, values]) => [path, summary(values)]),
          ),
        })
      } finally {
        await engine.stop()
        await relay.close()
        await notes.release(id)
        editor.destroy()
        store.close()
      }
    }
  } finally {
    profile?.disconnect()
    await mf.dispose()
    removeTempDirs()
  }
  const output = {
    generatedAt: new Date().toISOString(),
    commit: `${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}+dirty`,
    quick,
    machine,
    limitations: [
      'Core/storage wall time only: no editor rendering or Rust IPC scheduling.',
      'Sync includes real engine encode and base64/JSON IPC copies; Rust AES-256-GCM encryption is NOT included.',
      'Relay uses the real Worker/SQLite Durable Object in Miniflare over loopback WebSocket, including framing/copies/network; payload is unencrypted but identical in size except cipher overhead.',
      'One untimed warmup per size; cold means a fresh service cache, not cold OS/SQLite pages. Each run appends a line and ~10 KB then resets outside timing; search and push have two samples per run.',
      'The injected sync-engine clock advances one minute per run, avoiding its repeated-push circuit breaker; measurements always use real performance.now().',
    ],
    results,
  }
  writeFileSync(
    process.env['DEVOT_LARGE_OUT'] ?? 'docs/benchmarks/large-notes.json',
    `${JSON.stringify(output, null, 2)}\n`,
  )
  console.table(
    results.flatMap(({ bytes, paths }) =>
      Object.entries(paths).map(([path, stats]) => ({ bytes, path, ...stats })),
    ),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (
    args.some((arg, i) => arg !== '--quick' && arg !== '--out' && args[i - 1] !== '--out') ||
    (args.includes('--out') && !args[args.indexOf('--out') + 1]?.match(/^[^-]/))
  )
    throw new Error('E_BENCH_ARGUMENTS')
  const run = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      'slow',
      'tests/core/large-notes.bench.test.ts',
      '--silent=false',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DEVOT_LARGE_RUN: '1',
        DEVOT_LARGE_QUICK: args.includes('--quick') ? '1' : '0',
        DEVOT_LARGE_OUT: args.includes('--out')
          ? args[args.indexOf('--out') + 1]
          : 'docs/benchmarks/large-notes.json',
      },
    },
  )
  process.exitCode = run.status ?? 1
}
