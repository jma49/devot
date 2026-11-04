import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

// Pull requests are squash-merged under their title, so the title is the commit message on main.
const path = '.github/workflows/pr-title.yml'
type Workflow = {
  on: { pull_request: { types: string[] } }
  permissions: Record<string, string>
  jobs: Record<string, { steps: { env?: Record<string, string>; run: string }[] }>
}
const workflow = () => parse(readFileSync(path, 'utf8')) as Workflow

function check(title: string): number | null {
  const steps = Object.values(workflow().jobs).flatMap((job) => job.steps)
  const step = steps.find((s) => s.env?.['TITLE'])
  return spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 2'], {
    env: { ...process.env, TITLE: title },
    encoding: 'utf8',
  }).status
}

it('checks the title whenever it is set or changed, with no write access', () => {
  expect(existsSync(path)).toBe(true)
  expect(workflow().on.pull_request.types).toEqual(['opened', 'edited', 'synchronize', 'reopened'])
  expect(workflow().permissions).toEqual({})
  // The title reaches the script as data; interpolated into `run` it would be code.
  const step = Object.values(workflow().jobs).flatMap((job) => job.steps)[0]
  expect(step?.env?.['TITLE']).toBe('${{ github.event.pull_request.title }}')
  expect(step?.run).not.toContain('${{')
})

it.each([
  'feat: tables fit their columns',
  'fix(ci): docs-only changes run the policy tests',
  'refactor!: one writer for the store',
  'chore: bump actions',
  'docs: the release guide',
  'test: growth checks',
])('accepts %j', (title) => {
  expect(check(title)).toBe(0)
})

it.each([
  'Update stuff',
  'feat:no space',
  'feature: a type that is not listed',
  'fix: ',
  'Fix: capitalised type',
  '$(touch pwned): command substitution',
])('refuses %j', (title) => {
  expect(check(title)).toBe(1)
})
