import { useCallback, useEffect, useRef, useState } from 'react'
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

export type PhoneStore = PhoneData & { readonly refresh: () => void }

/** The phone's one core: started once, every list reloaded after each write. */
export function usePhoneData(): PhoneStore {
  const [data, setData] = useState<PhoneData>(EMPTY)
  const coreRef = useRef<Core | null>(null)

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

  const refresh = useCallback(() => {
    const core = coreRef.current
    if (core)
      void load(core).catch((e: unknown) => console.warn('W_PHONE_LOAD_FAILED', errorCode(e)))
  }, [load])

  useEffect(() => {
    let alive = true
    let started: Core | null = null
    void startCore(
      () => {},
      () => refresh(),
      (code) => console.warn('W_PHONE_CORE_FAILED', code),
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
  }, [load, refresh])

  return { ...data, refresh }
}
