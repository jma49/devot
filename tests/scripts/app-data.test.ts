import Database from 'better-sqlite3'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// scripts/app-data.sh runs in bash with HOME in a temporary folder, as the scripts source it:
// the data folder comes from HOME alone.

const root = join(import.meta.dirname, '../..')
const LIBRARY = join(root, 'scripts/app-data.sh')
const DEV_FOLDER = 'Library/Application Support/io.github.jma49.devot.dev'
/** A release build's data folder, or a debug build's from before they had their own. */
const RELEASE_FOLDER = 'Library/Application Support/io.github.jma49.devot'

/** sqlite3, lsof and Node processes start slowly on a busy machine; none measures time. */
const PROCESSES = { timeout: 30_000 }

const has = (tool: string) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0

const open: { close(): void }[] = []
afterEach(() => open.splice(0).forEach((db) => db.close()))

function home() {
  const dir = tempDir('devot-home-')
  const data = join(dir, DEV_FOLDER)
  return { dir, data, db: join(data, 'devot.sqlite') }
}

function bash(homeDir: string, script: string) {
  const run = spawnSync('bash', ['-c', `set -euo pipefail; source "$LIBRARY"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, LIBRARY },
  })
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr }
}

async function database(path: string, names: string[]) {
  mkdirSync(join(path, '..'), { recursive: true })
  const storage = openSqliteAdapter(path)
  const notes = createNoteService({
    storage,
    clock: createClock('smoke1'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  for (const name of names) await notes.create(name)
  await notes.flush()
  storage.close()
}

function titles(path: string): string[] {
  const db = new Database(path, { readonly: true })
  try {
    return db
      .prepare<[], { title: string }>('SELECT title FROM notes ORDER BY title')
      .all()
      .map((row) => row.title)
  } finally {
    db.close()
  }
}

function holdOpen(path: string) {
  const db = new Database(path)
  open.push(db)
  db.prepare('SELECT count(*) FROM notes').get()
  return db
}

it("finds the debug builds' data folder under HOME", () => {
  const { dir, data, db } = home()
  const run = bash(dir, 'printf "%s\\n%s" "$DEVOT_DEV_DATA" "$DEVOT_DEV_DB"')
  expect(run.stdout.split('\n')).toEqual([data, db])
})

it("makes a HOME for an app it starts in which only the dev folder is the user's", () => {
  const { dir, data } = home()
  const appHome = join(tempDir('devot-work-'), 'home')
  expect(bash(dir, `dev_app_home "${appHome}"`)).toMatchObject({ status: 0, stderr: '' })
  expect(lstatSync(join(appHome, DEV_FOLDER)).isSymbolicLink()).toBe(true)
  expect(realpathSync(join(appHome, DEV_FOLDER))).toBe(realpathSync(data))
  expect(readdirSync(appHome)).toEqual(['Library'])
  expect(readdirSync(join(appHome, 'Library'))).toEqual(['Application Support'])
  expect(readdirSync(join(appHome, 'Library/Application Support'))).toEqual([basename(DEV_FOLDER)])
  expect(bash(dir, `dev_app_home "${appHome}"`).status).toBe(1)
  expect(readdirSync(data)).toEqual([])
  writeFileSync(join(data, 'kept'), 'dev data')
  expect(bash(dir, `rm -rf "${appHome}"`).status).toBe(0)
  expect(existsSync(appHome)).toBe(false)
  expect(readFileSync(join(data, 'kept'), 'utf8')).toBe('dev data')
})

// macOS has both tools; a Linux machine may lack them, and the scripts run on macOS only.
describe.skipIf(!has('sqlite3') || !has('lsof'))('with sqlite3 and lsof', PROCESSES, () => {
  it('copies the dev notes aside before a run and puts them back after it', async () => {
    const { dir, data, db } = home()
    await database(db, ['Kept one', 'Kept two'])

    const begin = bash(dir, 'dev_data_begin')
    expect(begin).toMatchObject({ status: 0 })
    const backup = begin.stdout
    expect(backup.startsWith(join(data, 'smoke-backups/devot-'))).toBe(true)
    expect(titles(backup)).toEqual(['Kept one', 'Kept two'])
    const copy = new Database(backup, { readonly: true })
    // A plain file: no write-ahead log to lose when it is copied back.
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete')
    copy.close()

    // The smoke run: a fresh database each time, left behind by a killed app.
    expect(bash(dir, 'dev_data_clear').status).toBe(0)
    expect(existsSync(db)).toBe(false)
    await database(db, ['Smoke'])
    writeFileSync(`${db}-wal`, 'left by a killed app')
    writeFileSync(`${db}-shm`, 'left by a killed app')

    expect(bash(dir, `dev_data_end "${backup}"`)).toMatchObject({ status: 0 })
    expect(titles(db)).toEqual(['Kept one', 'Kept two'])
    expect(existsSync(`${db}-wal`)).toBe(false)
    expect(existsSync(`${db}-shm`)).toBe(false)
    expect(existsSync(backup)).toBe(true)
  })

  it('makes no copy without a dev database, and leaves none behind', async () => {
    const { dir, data, db } = home()
    expect(bash(dir, 'dev_data_begin')).toMatchObject({ status: 0, stdout: '' })
    await database(db, ['Smoke'])
    expect(bash(dir, 'dev_data_end ""')).toMatchObject({ status: 0 })
    expect(existsSync(db)).toBe(false)
    expect(existsSync(join(data, 'smoke-backups'))).toBe(false)
  })

  it('refuses while another process has the dev database open, and changes nothing', async () => {
    const { dir, data, db } = home()
    await database(db, ['Open elsewhere'])
    holdOpen(db)
    const begin = bash(dir, 'dev_data_begin')
    expect(begin.status).toBe(1)
    expect(begin.stderr).toContain('E_SMOKE_DEV_DATA_IN_USE')
    expect(existsSync(join(data, 'smoke-backups'))).toBe(false)
    expect(titles(db)).toEqual(['Open elsewhere'])
  })

  it('never puts a copy back under a running app', async () => {
    const { dir, db } = home()
    await database(db, ['Kept'])
    const backup = bash(dir, 'dev_data_begin').stdout
    expect(bash(dir, 'dev_data_clear').status).toBe(0)
    await database(db, ['Still running'])
    holdOpen(db)
    const end = bash(dir, `dev_data_end "${backup}"`)
    expect(end.status).toBe(1)
    expect(end.stderr).toContain('E_SMOKE_DEV_DATA_IN_USE')
    expect(end.stderr).toContain(backup)
    expect(titles(db)).toEqual(['Still running'])
    expect(titles(backup)).toEqual(['Kept'])
  })

  it('refuses a dev database it cannot read, and keeps it', () => {
    const { dir, data, db } = home()
    mkdirSync(data, { recursive: true })
    writeFileSync(db, 'not a database, but maybe notes')
    const begin = bash(dir, 'dev_data_begin')
    expect(begin.status).toBe(1)
    expect(begin.stderr).toContain('E_SMOKE_DEV_DATA_UNREADABLE')
    expect(readFileSync(db, 'utf8')).toBe('not a database, but maybe notes')
  })

  it('tells whether an app it started opened its database in the dev folder', async () => {
    const { dir, db } = home()
    const other = join(dir, 'elsewhere/devot.sqlite')
    await database(other, ['Not for scripts'])
    holdOpen(other)
    const elsewhere = bash(dir, `app_wait_for_db ${process.pid} "$DEVOT_DEV_DATA" 5`)
    expect(elsewhere.status).toBe(2)
    expect(elsewhere.stderr).toContain('E_APP_OTHER_DATABASE')

    await database(db, [])
    holdOpen(db)
    expect(bash(dir, `app_wait_for_db ${process.pid} "$DEVOT_DEV_DATA" 5`).status).toBe(0)

    // A process that has ended opens nothing more.
    const ended = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    expect(bash(dir, `app_wait_for_db ${ended} "$DEVOT_DEV_DATA" 5`).status).toBe(1)
  })

  it('gives a build that keeps its data elsewhere nothing real, and refuses it', async () => {
    const { dir, db } = home()
    await database(db, ['Dev note'])
    const appHome = join(tempDir('devot-work-'), 'home')
    expect(bash(dir, `dev_app_home "${appHome}"`).status).toBe(0)

    // An app takes its folders from its HOME: a build that does not add `.dev` opens a new one.
    const stale = join(appHome, RELEASE_FOLDER, 'devot.sqlite')
    await database(stale, [])
    const held = holdOpen(stale)
    const refused = bash(dir, `app_wait_for_db ${process.pid} "$DEVOT_DEV_DATA" 5`)
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('E_APP_OTHER_DATABASE')
    held.close()
    expect(existsSync(join(dir, RELEASE_FOLDER))).toBe(false)
    expect(titles(db)).toEqual(['Dev note'])

    holdOpen(join(appHome, DEV_FOLDER, 'devot.sqlite'))
    expect(bash(dir, `app_wait_for_db ${process.pid} "$DEVOT_DEV_DATA" 5`).status).toBe(0)
  })
})

describe('ending an app a script started', PROCESSES, () => {
  const started: ChildProcess[] = []
  afterEach(() => started.splice(0).forEach((child) => child.kill('SIGKILL')))

  async function stubborn() {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    started.push(child)
    await once(child.stdout!, 'data')
    return child
  }

  it('ends only the process it is given, forcing it when asking is not enough', async () => {
    const { dir } = home()
    const app = await stubborn()
    const other = await stubborn()
    const exit = once(app, 'exit')
    expect(bash(dir, `app_stop ${app.pid} 1`).status).toBe(0)
    expect((await exit)[1]).toBe('SIGKILL')
    expect(other.exitCode).toBeNull()
    expect(bash(dir, `app_running ${other.pid}`).status).toBe(0)
    expect(bash(dir, `app_running ${app.pid}`).status).toBe(1)
  })
})
