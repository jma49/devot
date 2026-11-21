import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fullReason,
  MAX_SHARDS,
  planVitest,
  READS_FILES,
  RUNTIME_READERS,
  shardFiles,
  TARGET_SHARD_WORK_MS,
} from '../../scripts/ci/vitest-plan.ts'

const always = () => true

describe('fullReason', () => {
  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'vitest.config.ts',
    'vite.config.ts',
    'tsconfig.web.json',
    '.node-version',
    '.github/workflows/ci.yml',
    'scripts/ci/vitest-plan.ts',
    'scripts/ci/vitest-durations.json',
    'tests/support/sqlite-adapter.ts',
    'tests/fixtures/plugins/manifests.json',
    'src-tauri/src/lib.rs',
    'src-tauri/migrations/0030.sql',
    'lefthook.yml',
  ])('runs every test for %s', (file) => {
    expect(fullReason([file], always)).toBe(`${file} changes every test`)
  })

  it.each([
    'src/core/notes.ts',
    'src/renderer/src/App.tsx',
    'src/renderer/src/app.css',
    'tests/core/notes.test.ts',
    'tests/ui/notes.spec.ts',
    'scripts/ci/ui-plan.ts',
    'relay/src/vault.ts',
    'licence/src/app.ts',
    'share/src/index.ts',
    'clipper/popup.ts',
    'plugin-kit/src/main.ts',
    'plugins/enex/source.ts',
    'docs/development.md',
    'design/layout.md',
    'README.md',
  ])('targets the tests that reach %s', (file) => {
    expect(fullReason([file], always)).toBeUndefined()
  })

  it('runs every test without changed files, or for a removed or renamed one', () => {
    expect(fullReason([], always)).toBe('no changed files')
    expect(fullReason(['src/core/gone.ts'], () => false)).toBe(
      'src/core/gone.ts was removed or renamed',
    )
    expect(fullReason(['docs/gone.md'], () => false)).toBeUndefined()
  })
})

describe('shardFiles', () => {
  it('gives every file to exactly one shard and balances the recorded work', () => {
    const durations = { 'a.test.ts': 170_000, 'b.test.ts': 100_000, 'c.test.ts': 90_000 }
    const shards = shardFiles(Object.keys(durations), durations)
    expect(shards).toEqual([
      { shard: 1, shards: 2, files: ['a.test.ts'] },
      { shard: 2, shards: 2, files: ['b.test.ts', 'c.test.ts'] },
    ])
  })

  it('sizes shards by recorded work and caps them', () => {
    const files = Array.from({ length: 40 }, (_, i) => `t${i}.test.ts`)
    const light = Object.fromEntries(files.map((file) => [file, 1000]))
    expect(shardFiles(files, light)).toHaveLength(1)
    const heavy = Object.fromEntries(files.map((file) => [file, TARGET_SHARD_WORK_MS]))
    expect(shardFiles(files, heavy)).toHaveLength(MAX_SHARDS)
  })

  it('costs an unknown file as the median known one, and splits evenly without any', () => {
    // Priced at the slowest file, the new one would have needed a third shard.
    const shards = shardFiles(['a.test.ts', 'b.test.ts', 'c.test.ts', 'new.test.ts'], {
      'a.test.ts': 200_000,
      'b.test.ts': 20_000,
      'c.test.ts': 10_000,
    })
    expect(shards.map((shard) => shard.files)).toEqual([
      ['a.test.ts'],
      ['b.test.ts', 'c.test.ts', 'new.test.ts'],
    ])
    const even = shardFiles(
      Array.from({ length: 9 }, (_, i) => `t${i}.test.ts`),
      {},
    )
    expect(even).toHaveLength(MAX_SHARDS)
    expect(
      Math.max(...even.map((s) => s.files.length)) - Math.min(...even.map((s) => s.files.length)),
    ).toBeLessThanOrEqual(1)
  })

  it('ignores durations that are not positive numbers', () => {
    const shards = shardFiles(['a.test.ts', 'b.test.ts'], { 'a.test.ts': -5, 'b.test.ts': NaN })
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(['a.test.ts', 'b.test.ts'])
  })
})

describe('planVitest', () => {
  const tests = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']

  it('runs the related tests and the changed test files for a targeted change', async () => {
    const plan = await planVitest({
      changed: ['src/core/a.ts', 'tests/c.test.ts'],
      tests,
      exists: always,
      related: (changed) => {
        expect(changed).toEqual(['src/core/a.ts', 'tests/c.test.ts'])
        return ['tests/a.test.ts']
      },
    })
    expect(plan.mode).toBe('targeted')
    expect(plan.files).toEqual(['tests/a.test.ts', 'tests/c.test.ts'])
    expect(plan.matrix.include.flatMap((shard) => shard.files).sort()).toEqual(plan.files)
  })

  it('runs everything for a full run or a change outside the targetable paths', async () => {
    const related = () => {
      throw new Error('a full plan reads no graph')
    }
    for (const input of [
      { changed: ['src/core/a.ts'], forceFull: true },
      { changed: ['src/core/a.ts', 'pnpm-lock.yaml'] },
    ]) {
      const plan = await planVitest({ ...input, tests, exists: always, related })
      expect(plan.mode).toBe('full')
      expect(plan.files).toEqual(tests)
    }
  })

  it('runs nothing when no test reaches the change, with a matrix GitHub accepts', async () => {
    const plan = await planVitest({
      changed: ['docs/notes.md'],
      tests,
      exists: always,
      related: () => [],
    })
    expect(plan.mode).toBe('none')
    expect(plan.matrix.include).toEqual([{ shard: 1, shards: 1, files: [] }])
  })
})

describe('the files that read other files', () => {
  it.each([
    "readFileSync('src-tauri/src/storage/notes.rs', 'utf8')",
    "readdirSync(join(import.meta.dirname, '../../src-tauri/migrations'))",
    "globSync(['tests/ui/**/*.spec.ts'])",
    "spawnSync('bash', ['-c', command])",
    "import { execFileSync } from 'node:child_process'",
    'existsSync(path)',
  ])('include code that calls %s', (code) => {
    expect(READS_FILES.test(code)).toBe(true)
  })

  it.each(["import { readThing } from './thing'", "const glob = 'a/**'", 'statsSync()'])(
    'leave out %s',
    (code) => {
      expect(READS_FILES.test(code)).toBe(false)
    },
  )

  it('leave out only files that read other files, so the list cannot go stale', () => {
    for (const file of RUNTIME_READERS)
      expect(READS_FILES.test(readFileSync(file, 'utf8'))).toBe(true)
  })
})
