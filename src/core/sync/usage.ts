// What a relay holds and may hold (docs/sync-relay.md, Quota), as Settings > Sync and the notices
// read it. Pure: the relay's `usage` message in, plain figures and bands out.

export type Fill = 'ok' | 'warn' | 'full'

/** A band changes at this share of a cap, and again at the cap. */
export const WARN_FRACTION = 0.8

/** What a relay's `usage` message says about storage. */
export interface RelayStorage {
  storedBytes: number
  fileBytes: number
  /** The relay's caps. Null: it runs without (`RELAY_QUOTA=off`). Undefined: too old to say. */
  caps: { storedBytes: number; fileBytes?: number } | null | undefined
}

export interface StorageFigures {
  storedBytes: number
  /** Notes, notebooks, tags and everything else that is not an image. */
  recordBytes: number
  fileBytes: number
}

export type StorageView =
  | ({ cap: 'unknown' | 'none' } & StorageFigures)
  | ({
      cap: 'set'
      /** The most the relay stores in total. */
      limit: number
      /** The most images may take; null when the relay holds no images. */
      imageLimit: number | null
      /** Bytes left in total. */
      room: number
      /** Bytes left for images: their own share, and never more than the total left. */
      imageRoom: number | null
      storage: Fill
      images: Fill
    } & StorageFigures)

const fillOf = (used: number, limit: number): Fill =>
  used >= limit ? 'full' : used >= limit * WARN_FRACTION ? 'warn' : 'ok'

export function viewStorage(usage: RelayStorage): StorageView {
  const figures: StorageFigures = {
    storedBytes: usage.storedBytes,
    fileBytes: usage.fileBytes,
    recordBytes: Math.max(0, usage.storedBytes - usage.fileBytes),
  }
  if (usage.caps === undefined) return { cap: 'unknown', ...figures }
  if (usage.caps === null) return { cap: 'none', ...figures }
  const { storedBytes: limit, fileBytes: imageLimit = null } = usage.caps
  const room = Math.max(0, limit - usage.storedBytes)
  return {
    cap: 'set',
    ...figures,
    limit,
    imageLimit,
    room,
    imageRoom:
      imageLimit === null ? null : Math.min(room, Math.max(0, imageLimit - usage.fileBytes)),
    storage: fillOf(usage.storedBytes, limit),
    images: imageLimit === null ? 'ok' : fillOf(usage.fileBytes, imageLimit),
  }
}

/** The bands last told to the person, per relay. */
export interface Seen {
  storage: Fill
  images: Fill
}

export const NOTHING_SEEN: Seen = { storage: 'ok', images: 'ok' }

export type UsageNotice = 'storageWarn' | 'storageFull' | 'imagesWarn' | 'imagesFull'

const RANK: Record<Fill, number> = { ok: 0, warn: 1, full: 2 }

/**
 * The one notice a reading calls for, if any, and the bands to remember. A band is told once: a
 * notice comes when a cap's band goes up from the one last told, and a drop is remembered without
 * a word, so the same band is not repeated on every launch but a return to it is.
 */
export function noticeFor(
  view: StorageView,
  seen: Seen,
): { notice: UsageNotice | null; seen: Seen } {
  if (view.cap !== 'set') return { notice: null, seen: NOTHING_SEEN }
  const now: Seen = { storage: view.storage, images: view.images }
  const up = (key: keyof Seen) => RANK[now[key]] > RANK[seen[key]]
  const notice: UsageNotice | null =
    up('storage') && now.storage === 'full'
      ? 'storageFull'
      : up('images') && now.images === 'full'
        ? 'imagesFull'
        : up('storage')
          ? 'storageWarn'
          : up('images')
            ? 'imagesWarn'
            : null
  return { notice, seen: now }
}
