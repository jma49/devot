import { useCallback, useEffect, useRef, useState } from 'react'
import type { TakenIn } from '../../../core'
import type {
  BookRecord,
  NoteSummary,
  SavedSearchRecord,
  TagRecord,
  TrashedNote,
} from '../../../core/storage'
import { listBackups } from '../backups'
import { startCore, stopCore, type Core } from '../core-client'
import { errorCode } from '../../../core/errors'
import { useExternalChanges } from '../externalChanges'
import { saveEdits } from '../saveGuards'
import { welcomeContent } from '../welcome/content'

export interface PhoneData {
  readonly core: Core | null
  readonly notes: readonly NoteSummary[]
  readonly templates: readonly NoteSummary[]
  readonly books: readonly BookRecord[]
  readonly tags: readonly TagRecord[]
  readonly savedSearches: readonly SavedSearchRecord[]
  readonly trash: readonly TrashedNote[]
  /** When the newest backup was made; null before the first, undefined until known. */
  readonly lastBackup: number | null | undefined
  /** When the lists were read: dates are shown relative to it. */
  readonly loadedAt: number
}

const EMPTY: PhoneData = {
  core: null,
  notes: [],
  templates: [],
  books: [],
  tags: [],
  savedSearches: [],
  trash: [],
  lastBackup: undefined,
  loadedAt: 0,
}

async function newestBackup(): Promise<number | null | undefined> {
  try {
    const status = await listBackups()
    if (!status || !Array.isArray(status.backups)) return undefined
    return status.backups.reduce<number | null>(
      (newest, b) => (newest === null || b.createdAt > newest ? b.createdAt : newest),
      null,
    )
  } catch (e) {
    console.warn('W_PHONE_BACKUPS_FAILED', errorCode(e))
    return undefined
  }
}

export type PhoneStore = PhoneData & {
  readonly refresh: () => Promise<void>
  /** Hears each change a note in memory took in that the phone did not make (sync's, merged in); returns the stop. */
  readonly onTakenIn: (listener: (change: TakenIn) => void) => () => void
}

/** The phone's one core: started once, every list reloaded after each write. */
export function usePhoneData(): PhoneStore {
  const [data, setData] = useState<PhoneData>(EMPTY)
  const coreRef = useRef<Core | null>(null)
  const [takenIn] = useState(() => new Set<(change: TakenIn) => void>())
  const onTakenIn = useCallback(
    (listener: (change: TakenIn) => void) => {
      takenIn.add(listener)
      return () => void takenIn.delete(listener)
    },
    [takenIn],
  )

  const load = useCallback(async (core: Core) => {
    const [listed, books, tags, savedSearches, trash, lastBackup] = await Promise.all([
      core.listWithTemplates(),
      core.listBooks(),
      core.listTags(),
      core.listSavedSearches(),
      core.listTrash(),
      newestBackup(),
    ])
    setData({
      core,
      notes: listed.notes,
      templates: listed.templates,
      books,
      tags,
      savedSearches,
      trash,
      lastBackup,
      loadedAt: Date.now(),
    })
  }, [])

  const refresh = useCallback(async () => {
    const core = coreRef.current
    if (core)
      await load(core).catch((e: unknown) => console.warn('W_PHONE_LOAD_FAILED', errorCode(e)))
  }, [load])

  useEffect(() => {
    let alive = true
    let started: Core | null = null
    void startCore(
      () => {},
      () => void refresh(),
      (code) => console.warn('W_PHONE_CORE_FAILED', code),
      { onTakenIn: (change) => takenIn.forEach((listener) => listener(change)) },
    )
      .then(async (core) => {
        started = core
        if (!alive) return stopCore(core)
        coreRef.current = core
        if (!DEVOT_UI_TEST || (globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome) {
          await core.seedWelcome(welcomeContent()).catch((e: unknown) => {
            console.warn('W_WELCOME_FAILED', errorCode(e))
          })
        }
        await load(core)
      })
      .catch((e: unknown) => console.warn('W_PHONE_CORE_START_FAILED', errorCode(e)))
    return () => {
      alive = false
      coreRef.current = null
      if (started) stopCore(started)
    }
  }, [load, refresh, takenIn])

  // Sync wrote what other devices changed: the notes in memory take it in and are saved, then the lists reload.
  const { core } = data
  useExternalChanges(
    core
      ? async () => {
          await core.mergeStored()
          await saveEdits(core)
          await load(core)
        }
      : undefined,
  )

  return { ...data, refresh, onTakenIn }
}
