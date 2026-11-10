import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { lastGreen } from '../../scripts/ci/last-green'

const plan = (files: string[]) =>
  execFileSync('sh', ['scripts/ci/main-plan.sh'], {
    input: files.map((file) => `${file}\n`).join(''),
    encoding: 'utf8',
  })
    .trim()
    .split('\n')

it('runs main in full when code changed since its last run that passed, less the Swift packages left alone', () => {
  expect(plan(['src/core/notes.ts', 'docs/specs/quality.md'])).toEqual([
    'web=true',
    'rust=true',
    'docs_only=false',
    'iphone_ui=true',
    'screens=false',
    'storekit=false',
  ])
  // A web-only pull request skips the Rust and iPhone jobs; main does not.
  expect(plan(['src-tauri/apple/DevotStore/Sources/Store.swift'])).toEqual([
    'web=true',
    'rust=true',
    'docs_only=false',
    'iphone_ui=true',
    'screens=false',
    'storekit=true',
  ])
  expect(plan(['.github/workflows/ci.yml']).slice(4)).toEqual(['screens=true', 'storekit=true'])
})

it('runs only the always-on gates when nothing but documentation changed since then', () => {
  expect(plan(['README.md', 'docs/releasing.md'])).toEqual([
    'web=false',
    'rust=false',
    'docs_only=true',
    'iphone_ui=false',
    'screens=false',
    'storekit=false',
  ])
})

it('runs everything when no file is named', () => {
  expect(plan([])).toEqual([
    'web=true',
    'rust=true',
    'docs_only=false',
    'iphone_ui=true',
    'screens=true',
    'storekit=true',
  ])
})

it("takes the newest passed run's commit that is not this one", () => {
  const runs = [{ head_sha: 'this' }, { head_sha: 'green' }, { head_sha: 'older' }]
  expect(lastGreen(runs, 'this')).toBe('green')
  expect(lastGreen([{ head_sha: 'this' }], 'this')).toBeUndefined()
  expect(lastGreen([], 'this')).toBeUndefined()
})

it('is how a push to main is planned, and anything else that is not a pull request runs in full', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: {
      changes: { permissions: Record<string, string>; steps: { id?: string; run?: string }[] }
    }
  }
  const changes = workflow.jobs.changes
  expect(changes.permissions).toEqual({ contents: 'read', actions: 'read' })
  const run = changes.steps.find((step) => step.id === 'diff')?.run ?? ''
  expect(run).toContain('base=$(node scripts/ci/last-green.ts)')
  expect(run).toContain('git fetch --no-tags --depth=1 origin "$base"')
  expect(run).toContain(
    'git diff --no-renames --name-only "$base" HEAD | sh scripts/ci/main-plan.sh >> "$GITHUB_OUTPUT"',
  )
  expect(run).toContain(
    "printf 'web=true\\nrust=true\\ndocs_only=false\\niphone_ui=true\\nscreens=true\\nstorekit=true\\n'",
  )
})
