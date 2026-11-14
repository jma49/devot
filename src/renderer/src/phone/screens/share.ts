import type { SharedNote } from '../../../../core/capture'
import type { ScreensHandlers } from './ops'

/** What the page needs to make a note of a share Swift drained from the inbox. */
export interface NativeShare {
  /** Whether the licence lets the page write: a locked share stays in the inbox for later. */
  readonly allowed: () => boolean
  /** Makes the note in the default notebook (`bookId` is left to it) and saves it. */
  readonly capture: (
    share: Omit<SharedNote, 'bookId'>,
  ) => Promise<{ id: string; refused: readonly string[] }>
  /** Where the page keeps the inbox files it made notes of; null without storage. */
  readonly ledger: Pick<Storage, 'getItem' | 'setItem'> | null
}

export const SHARE_LEDGER_KEY = 'devot.share.made'
/** Far more than one drain sends, so a reply lost on its way never makes a share twice. */
const LEDGER_SIZE = 100

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw invalid()
  return value
}

function bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

type Ledger = [string, string][]

function readLedger(storage: NativeShare['ledger']): Ledger {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(SHARE_LEDGER_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is [string, string] =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
        )
      : []
  } catch {
    return []
  }
}

function remember(storage: NativeShare['ledger'], item: string, note: string) {
  try {
    const kept = readLedger(storage).filter(([id]) => id !== item)
    storage?.setItem(SHARE_LEDGER_KEY, JSON.stringify([...kept, [item, note]].slice(-LEDGER_SIZE)))
  } catch {
    // Without storage a lost reply can make a share twice; the note itself is safe.
  }
}

export function shareHandlers(share: () => NativeShare | null): ScreensHandlers {
  return {
    'share.capture': async (args) => {
      const native = share()
      if (!native) throw new Error('E_SCREENS_UNAVAILABLE')
      const item = text(args['id'])
      const made = readLedger(native.ledger).find(([id]) => id === item)
      if (made) return { id: made[1], refused: [] }
      if (!native.allowed()) throw new Error('E_LICENCE_REQUIRED')
      const url = args['url']
      const images = args['images']
      if (!Array.isArray(images)) throw invalid()
      const { id, refused } = await native.capture({
        title: text(args['title']),
        text: text(args['text']),
        url: url === undefined ? null : text(url),
        images: images.map((image: unknown) => {
          if (typeof image !== 'object' || image === null) throw invalid()
          const { name, data } = image as Record<string, unknown>
          return { name: text(name), data: bytes(text(data)) }
        }),
      })
      remember(native.ledger, item, id)
      return { id, refused }
    },
  }
}
