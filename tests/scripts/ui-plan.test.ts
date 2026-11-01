import { globSync } from 'node:fs'
import { expect, it } from 'vitest'
import { planUi } from '../../scripts/ci/ui-plan.ts'

const specs = [
  'tests/ui/find.spec.ts',
  'tests/ui/notes.spec.ts',
  'tests/ui/paste-url.spec.ts',
  'tests/ui/tooltips.spec.ts',
  'tests/ui/updates.spec.ts',
  'tests/ui-csp/csp.spec.ts',
]

it('selects changed specs exactly and deduplicates their shards', () => {
  const plan = planUi(['tests/ui/notes.spec.ts', 'tests/ui/notes.spec.ts'], specs)
  expect(plan.mode).toBe('targeted')
  expect(plan.files).toEqual(['tests/ui/notes.spec.ts'])
  expect(plan.matrix.include).toEqual([
    { project: 'webkit', shard: 1, shards: 1, files: ['tests/ui/notes.spec.ts'] },
  ])
})

it('keeps development and production CSP selections in separate jobs', () => {
  const plan = planUi(['tests/ui/notes.spec.ts', 'tests/ui-csp/csp.spec.ts'], specs)
  expect(plan.matrix.include).toEqual([
    { project: 'webkit', shard: 1, shards: 1, files: ['tests/ui/notes.spec.ts'] },
    { project: 'webkit-prod-csp', shard: 1, shards: 1, files: ['tests/ui-csp/csp.spec.ts'] },
  ])
})

it('runs no browser for changes outside the browser runtime', () => {
  const plan = planUi(
    [
      'docs/development.md',
      'README.md',
      'relay/src/vault.ts',
      'licence/src/app.ts',
      'src/mcp/server.ts',
      'src-tauri/src/lib.rs',
      'src-tauri/migrations/0023.sql',
      'design/app-icon/source.svg',
      'tests/core/find.test.ts',
      'src/renderer/src/NoteRow.test.tsx',
    ],
    specs,
  )
  expect(plan.mode).toBe('none')
  expect(plan.files).toEqual([])
})

it.each([
  'src/renderer/src/App.tsx',
  'src/renderer/src/NoteEditor.tsx',
  'src/renderer/src/app.css',
  'src/renderer/src/ToolTips.tsx',
  'src/renderer/src/editor/paste.ts',
  'src/renderer/src/editor/table.ts',
  'src/core/find.ts',
  'src/renderer/src/welcome/welcome.md',
  'src/renderer/src/new-feature.ts',
  'tests/ui/fixtures.ts',
  'tests/ui/plugins.ts',
  'tests/support/ports.ts',
  'playwright.config.ts',
  'scripts/ci/ui-plan.ts',
  'scripts/serve-csp.ts',
  '.github/workflows/ci.yml',
  'src-tauri/plugin-frame/runtime.js',
  'src-tauri/tauri.conf.json',
  'pnpm-lock.yaml',
  'package.json',
])('runs the full suite for shared or unknown input %s', (file) => {
  expect(planUi([file], specs).files).toEqual([...specs].sort())
  expect(planUi([file], specs).mode).toBe('full')
})

it('falls back to full for empty input and manual runs', () => {
  expect(planUi([], specs).mode).toBe('full')
  expect(planUi(['README.md'], specs, true).mode).toBe('full')
})

it('lets any shared change override a narrow selection', () => {
  expect(planUi(['tests/ui/notes.spec.ts', 'src/core/find.ts'], specs).mode).toBe('full')
})

it('runs the affected project when a spec is removed or renamed away', () => {
  const plan = planUi(['tests/ui/removed.spec.ts', 'docs/removed.md'], specs)
  expect(plan.files).toEqual(specs.filter((file) => file.startsWith('tests/ui/')).sort())
})

it.each([
  [1, 1],
  [6, 1],
  [7, 2],
  [42, 7],
  [43, 8],
  [49, 8],
  [96, 8],
])('schedules %i selected files in %i parallel jobs', (count, shards) => {
  const files = Array.from({ length: count }, (_, i) => `tests/ui/feature-${i}.spec.ts`)
  const plan = planUi(files, files)
  expect(plan.matrix.include.map((job) => [job.shard, job.shards])).toEqual(
    Array.from({ length: shards }, (_, i) => [i + 1, shards]),
  )
  const assigned = plan.matrix.include.flatMap((job) => job.files)
  expect(assigned.sort()).toEqual([...files].sort())
  expect(new Set(assigned).size).toBe(files.length)
})

it('retains all available specs when a mapped regression file disappears', () => {
  const all = globSync(['tests/ui/**/*.spec.ts', 'tests/ui-csp/**/*.spec.ts'])
  const available = all.filter((file) => file !== 'tests/ui/links.spec.ts')
  expect(planUi(['src/renderer/src/tipPlacement.ts'], available).files).toEqual(available.sort())
})

it.each([
  ['src/renderer/src/tipPlacement.ts', 'tests/ui/links.spec.ts'],
  ['src/renderer/src/find/useFind.tsx', 'tests/ui/ime.spec.ts'],
  ['src/renderer/src/find/FindBar.tsx', 'tests/ui/trial.spec.ts'],
  ['src/renderer/src/updates.ts', 'tests/ui/settings.spec.ts'],
  ['src/renderer/src/preview/mermaid.ts', 'tests/ui/export.spec.ts'],
  ['src/renderer/src/mermaid-frame.ts', 'tests/ui/scroll-sync.spec.ts'],
])('retains cross-feature coverage for %s', (source, consumer) => {
  const all = globSync(['tests/ui/**/*.spec.ts', 'tests/ui-csp/**/*.spec.ts'])
  const plan = planUi([source], all)
  expect(plan.mode).toBe('targeted')
  expect(plan.files).toContain(consumer)
  expect(plan.files).toContain('tests/ui-csp/csp.spec.ts')
})

it('unions multiple feature selections and directly changed specs', () => {
  const all = globSync(['tests/ui/**/*.spec.ts', 'tests/ui-csp/**/*.spec.ts'])
  const plan = planUi(
    ['src/renderer/src/updates.ts', 'src/renderer/src/find/keys.ts', 'tests/ui/notes.spec.ts'],
    all,
  )
  expect(plan.mode).toBe('targeted')
  expect(plan.files).toEqual(
    expect.arrayContaining([
      'tests/ui/updates.spec.ts',
      'tests/ui/find.spec.ts',
      'tests/ui/notes.spec.ts',
    ]),
  )
  expect(plan.files.filter((file) => file === 'tests/ui-csp/csp.spec.ts')).toHaveLength(1)
})

it('separates expensive specs instead of grouping them by filename', () => {
  const files = Array.from({ length: 4 }, (_, i) => `tests/ui/feature-${i}.spec.ts`)
  const durations = Object.fromEntries(files.map((file, i) => [file, i < 2 ? 400_000 : 10_000]))
  const plan = planUi(files, files, false, durations)
  const jobs = plan.matrix.include
  expect(jobs).toHaveLength(2)
  expect(jobs.every((job) => job.partitioned)).toBe(true)
  expect(jobs.map((job) => job.files.reduce((sum, file) => sum + durations[file]!, 0))).toEqual([
    410_000, 410_000,
  ])
  expect(jobs[0]!.files).not.toContain(files[1])
  expect(jobs.flatMap((job) => job.files).sort()).toEqual(files)
})

it('uses measured work to schedule a full run in at most fourteen shards', () => {
  const files = Array.from({ length: 96 }, (_, i) => `tests/ui/feature-${i}.spec.ts`)
  const durations = Object.fromEntries(files.map((file) => [file, 100_000]))
  const plan = planUi(files, files, false, durations)
  expect(plan.matrix.include).toHaveLength(14)
  expect(
    plan.matrix.include.every((job) => job.shards === 14 && [6, 7].includes(job.files.length)),
  ).toBe(true)
  expect(plan.matrix.include.flatMap((job) => job.files).sort()).toEqual([...files].sort())
})

it('retains new specs and deterministic assignments when durations are missing', () => {
  const files = Array.from({ length: 13 }, (_, i) => `tests/ui/feature-${i}.spec.ts`)
  const durations = { [files[0]!]: 100, [files[1]!]: 10 }
  const forward = planUi(files, files, false, durations)
  const reversed = planUi([...files].reverse(), [...files].reverse(), false, durations)
  expect(forward.matrix).toEqual(reversed.matrix)
  expect(forward.matrix.include.every((job) => job.files.length > 0)).toBe(true)
  expect(forward.matrix.include.flatMap((job) => job.files).sort()).toEqual([...files].sort())
})
