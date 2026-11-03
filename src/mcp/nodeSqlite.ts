// better-sqlite3's interface, as much of it as src/mcp/sqlite.ts uses, on Node's built-in SQLite.
// The helper inside Devot.app is one Mach-O with no addon to load, since library validation under
// the hardened runtime refuses a module not signed by the same team.
import { existsSync } from 'node:fs'
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite'

const PRIMARY_CODES: Record<number, string> = {
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  14: 'SQLITE_CANTOPEN',
}

/** Gives a failure the `code` better-sqlite3 would, which errorCode in server.ts reads. */
function coded<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    const errcode = (error as { errcode?: unknown } | null)?.errcode
    if (typeof errcode === 'number') {
      const code = PRIMARY_CODES[errcode & 0xff]
      if (code) Object.assign(error as object, { code })
    }
    throw error
  }
}

type Params = unknown[]

function bind(params: Params): SQLInputValue[] {
  const [first] = params
  return (Array.isArray(first) && params.length === 1 ? first : params) as SQLInputValue[]
}

class Statement {
  constructor(private readonly statement: StatementSync) {}
  run(...params: Params) {
    return coded(() => this.statement.run(...bind(params)))
  }
  get(...params: Params) {
    return coded(() => this.statement.get(...bind(params)))
  }
  all(...params: Params) {
    return coded(() => this.statement.all(...bind(params)))
  }
}

export default class Database {
  private readonly db: DatabaseSync
  private savepoints = 0

  constructor(path: string, options: { fileMustExist?: boolean } = {}) {
    if (options.fileMustExist && !existsSync(path)) {
      throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' })
    }
    this.db = coded(() => new DatabaseSync(path))
  }

  get inTransaction(): boolean {
    return this.db.isTransaction
  }

  prepare(sql: string): Statement {
    return new Statement(coded(() => this.db.prepare(sql)))
  }

  exec(sql: string): this {
    coded(() => {
      this.db.exec(sql)
    })
    return this
  }

  close(): void {
    this.db.close()
  }

  function(
    name: string,
    options: { deterministic?: boolean },
    fn: (...args: SQLOutputValue[]) => SQLInputValue,
  ): this {
    this.db.function(name, options, fn)
    return this
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = coded(() => this.db.prepare(`PRAGMA ${source}`).all()) as Record<string, unknown>[]
    if (!options.simple) return rows
    const row = rows[0]
    return row ? Object.values(row)[0] : undefined
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const run =
      (begin: string) =>
      (...args: A): R => {
        const nested = this.db.isTransaction
        const savepoint = `devot_sp_${(this.savepoints += 1)}`
        this.exec(nested ? `SAVEPOINT ${savepoint}` : begin)
        try {
          const result = fn(...args)
          this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
          return result
        } catch (error) {
          if (this.db.isTransaction) {
            this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
          }
          throw error
        }
      }
    return Object.assign(run('BEGIN'), {
      deferred: run('BEGIN DEFERRED'),
      immediate: run('BEGIN IMMEDIATE'),
      exclusive: run('BEGIN EXCLUSIVE'),
    })
  }
}
