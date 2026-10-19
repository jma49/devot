import { afterEach, describe, expect, it } from 'vitest'
import { restoreBackup } from './backups'

const global = globalThis as { window?: unknown }

function commands(log: string[], answer: () => Promise<unknown>) {
  global.window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string) => {
        log.push(cmd)
        return answer()
      },
    },
  }
}

afterEach(() => {
  delete global.window
})

function compaction(log: string[]) {
  let finish = () => {}
  const running = new Promise<void>((resolve) => (finish = resolve))
  return {
    finish: () => finish(),
    hold: async () => {
      log.push('hold')
      await running
      log.push('held')
    },
    resume: () => void log.push('resume'),
  }
}

describe('restoreBackup', () => {
  it('replaces the database only once a running sweep has finished', async () => {
    const log: string[] = []
    commands(log, () => Promise.resolve(null))
    const sweeps = compaction(log)
    const restoring = restoreBackup('id', sweeps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toEqual(['hold'])
    sweeps.finish()
    await restoring
    expect(log).toEqual(['hold', 'held', 'backup_restore'])
  })

  it('lets sweeps start again when the restore fails', async () => {
    const log: string[] = []
    commands(log, () => Promise.reject('E_BACKUP_RESTORE_FAILED'))
    const sweeps = compaction(log)
    sweeps.finish()
    await expect(restoreBackup('id', sweeps)).rejects.toThrow('E_BACKUP_RESTORE_FAILED')
    expect(log).toEqual(['hold', 'held', 'backup_restore', 'resume'])
  })
})
