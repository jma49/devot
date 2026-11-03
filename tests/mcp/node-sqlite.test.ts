// The driver the helper inside Devot.app runs on: better-sqlite3's interface over Node's SQLite.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from '../../src/mcp/nodeSqlite'
import { errorCode } from '../../src/mcp/server'
import { tempDir } from '../support/temp-dirs'

const file = () => join(tempDir('devot-node-sqlite-'), 'test.sqlite')

describe('the Node SQLite driver', () => {
  it('leaves a missing file uncreated when told it must exist', () => {
    const path = file()
    expect(() => new Database(path, { fileMustExist: true })).toThrow()
    expect(() => new Database(path, { fileMustExist: true })).toThrow(
      expect.objectContaining({ code: 'SQLITE_CANTOPEN' }),
    )
  })

  it('reads a pragma as rows or as one value', () => {
    const db = new Database(file())
    db.pragma('user_version = 7')
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(db.pragma('user_version')).toEqual([{ user_version: 7 }])
    db.close()
  })

  it('binds positional, array and named parameters', () => {
    const db = new Database(file())
    db.exec('CREATE TABLE t (a, b)')
    db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'x')
    db.prepare('INSERT INTO t VALUES (?, ?)').run([2, 'y'])
    db.prepare('INSERT INTO t VALUES (@a, @b)').run({ a: 3, b: new Uint8Array([9]) })
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 })
    expect(db.prepare('SELECT b FROM t WHERE a = @a').get({ a: 2 })).toEqual({ b: 'y' })
    expect(db.prepare('SELECT b FROM t WHERE a = ?').all(3)).toEqual([{ b: new Uint8Array([9]) }])
    db.close()
  })

  it('commits a transaction, rolls one back that throws, and nests with savepoints', () => {
    const db = new Database(file())
    db.exec('CREATE TABLE t (a)')
    const insert = db.prepare('INSERT INTO t VALUES (?)')
    db.transaction(() => insert.run(1)).immediate()
    expect(() =>
      db
        .transaction(() => {
          insert.run(2)
          throw new Error('stop')
        })
        .immediate(),
    ).toThrow('stop')
    db.transaction(() => {
      insert.run(3)
      expect(db.inTransaction).toBe(true)
      expect(() =>
        db.transaction(() => {
          insert.run(4)
          throw new Error('inner')
        })(),
      ).toThrow('inner')
    })()
    expect(db.inTransaction).toBe(false)
    expect(db.prepare('SELECT a FROM t ORDER BY a').all()).toEqual([{ a: 1 }, { a: 3 }])
    db.close()
  })

  it('names a busy database so tools answer E_STORAGE_BUSY', () => {
    const path = file()
    const holder = new Database(path)
    holder.exec('CREATE TABLE t (a)')
    holder.pragma('journal_mode = WAL')
    const other = new Database(path)
    other.pragma('busy_timeout = 0')
    holder.exec('BEGIN IMMEDIATE')
    try {
      expect.assertions(1)
      other.exec('BEGIN IMMEDIATE')
    } catch (error) {
      expect(errorCode(error)).toBe('E_STORAGE_BUSY')
    }
    holder.exec('ROLLBACK')
    holder.close()
    other.close()
  })

  it('fails on a file that is not a database', () => {
    const path = file()
    writeFileSync(path, 'not sqlite, and long enough to be read as a header by the engine')
    const db = new Database(path)
    expect(() => db.prepare('SELECT * FROM sqlite_master').all()).toThrow()
    db.close()
  })

  it('runs a registered function and full-text search with trigrams', () => {
    const db = new Database(file())
    db.function('fold', { deterministic: true }, (text) => String(text).toLowerCase())
    expect(db.prepare('SELECT fold(?) AS v').get('AB')).toEqual({ v: 'ab' })
    db.exec(`CREATE VIRTUAL TABLE f USING fts5(a, tokenize = 'trigram')`)
    db.prepare('INSERT INTO f VALUES (?)').run('kiwi fruit')
    expect(db.prepare(`SELECT a FROM f WHERE f MATCH 'iwi'`).all()).toEqual([{ a: 'kiwi fruit' }])
    db.close()
  })
})
