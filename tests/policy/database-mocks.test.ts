import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { DATABASE_MOCK } from '../support/policy-patterns'

// Tests run against a real SQLite file (better-sqlite3 on a temporary folder): a mocked database
// passes queries the real one refuses.
it('no test mocks the database', () => {
  const files = listFiles('.', 'tests', 'src').filter(
    (f) => /\.(ts|tsx)$/.test(f) && f !== 'tests/policy/database-mocks.test.ts',
  )
  const offenders = files.filter((file) => DATABASE_MOCK.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('the database-mock check catches a mocked driver, storage module or adapter', () => {
  expect(DATABASE_MOCK.test("vi.mock('better-sqlite3', () => ({}))")).toBe(true)
  expect(DATABASE_MOCK.test("vi.mock('../../src/core/storage')")).toBe(true)
  expect(DATABASE_MOCK.test("vi.doMock('../support/sqlite-adapter.ts', () => ({}))")).toBe(true)
  expect(DATABASE_MOCK.test("vi.mock('../../src/renderer/src/ipc')")).toBe(false)
  expect(DATABASE_MOCK.test("vi.mock('./wire-storage-view')")).toBe(false)
})
