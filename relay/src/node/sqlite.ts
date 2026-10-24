import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { Sql, SqlValue } from '../vault.ts'

export function sqliteSql(db: Database.Database): Sql {
  const statements = new Map<string, Database.Statement>()
  const prepare = (query: string) => {
    let statement = statements.get(query)
    if (!statement) {
      statement = db.prepare(query)
      statements.set(query, statement)
    }
    return statement
  }
  const bind = (params: SqlValue[]) =>
    params.map((p) =>
      p instanceof Uint8Array && !Buffer.isBuffer(p)
        ? Buffer.from(p.buffer, p.byteOffset, p.byteLength)
        : p,
    )
  return {
    all(query, ...params) {
      return prepare(query).all(...bind(params)) as Record<string, SqlValue>[]
    },
    run(query, ...params) {
      return prepare(query).run(...bind(params)).changes
    },
    transaction(fn) {
      return db.transaction(fn)()
    },
  }
}

/** Opens a vault's database; with `create` false, only one that already exists. */
export function openVaultDb(file: string, create: boolean): Database.Database | null {
  if (!create && !existsSync(file)) return null
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  return db
}
