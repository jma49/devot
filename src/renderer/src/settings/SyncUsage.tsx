import { useState } from 'react'
import { noticeFor, NOTHING_SEEN, type StorageView } from '../../../core/sync/usage'
import { fileSize } from '../format'
import { currentLocale, format, t } from '../i18n'
import { STORAGE_FULL, type SyncSnapshot } from '../sync'
import { USAGE_NOTICE_TEXT, useRelayUsage, type UsageReading } from '../syncUsage'
import { Setting, SettingsNote } from './controls'

// What the relay holds and may hold (docs/sync-relay.md, Quota), in plain words, in Settings > Sync.

function roomText(view: Extract<StorageView, { cap: 'set' }>, locale: string): string {
  if (view.room === 0) return t('syncSettings.usage.roomNone')
  const room = fileSize(view.room, locale)
  if (view.imageRoom === null) return room
  if (view.imageRoom === 0) return format(t('syncSettings.usage.roomImagesUsed'), { room })
  return format(t('syncSettings.usage.roomImages'), {
    room,
    images: fileSize(view.imageRoom, locale),
  })
}

function figures(view: StorageView, locale: string) {
  const of = (used: number, limit: number | null) =>
    limit === null
      ? fileSize(used, locale)
      : format(t('syncSettings.usage.of'), {
          used: fileSize(used, locale),
          limit: fileSize(limit, locale),
        })
  const set = view.cap === 'set' ? view : undefined
  return {
    records: fileSize(view.recordBytes, locale),
    images: of(view.fileBytes, set?.imageLimit ?? null),
    total: of(view.storedBytes, set?.limit ?? null),
    room: set
      ? roomText(set, locale)
      : t(view.cap === 'none' ? 'syncSettings.usage.noCap' : 'syncSettings.usage.unknownCap'),
  }
}

/** The warning the figures call for now, unless the status already says it. */
function warning(view: StorageView, snapshot: SyncSnapshot) {
  const { notice } = noticeFor(view, NOTHING_SEEN)
  if (notice === null) return undefined
  const { code, unsyncedFiles } = snapshot.status
  if (notice === 'storageFull' && code === STORAGE_FULL) return undefined
  if (notice === 'imagesFull' && unsyncedFiles?.code === 'E_SYNC_ATTACHMENTS_FULL') return undefined
  return t(USAGE_NOTICE_TEXT[notice])
}

function capNote(view: StorageView, locale: string): string | undefined {
  if (view.cap !== 'set') return undefined
  const limit = fileSize(view.limit, locale)
  return view.imageLimit === null
    ? format(t('syncSettings.usage.capNoteTotal'), { limit })
    : format(t('syncSettings.usage.capNote'), { limit, images: fileSize(view.imageLimit, locale) })
}

function Unavailable({ reading, retry }: { reading: UsageReading | null; retry: () => void }) {
  const failed = reading?.state === 'unavailable' ? reading : undefined
  const text = !failed
    ? t('syncSettings.usage.reading')
    : failed.why === 'offline'
      ? t('syncSettings.usage.offline')
      : failed.why === 'old'
        ? t('syncSettings.usage.old')
        : format(t('syncSettings.usage.failed'), { code: failed.code })
  return (
    <Setting live label="syncSettings.usage.title" description={text}>
      {failed && failed.why !== 'old' ? (
        <div className="settings-buttons">
          <button type="button" className="button" onClick={retry}>
            {t('syncSettings.usage.retry')}
          </button>
        </div>
      ) : null}
    </Setting>
  )
}

/** Notes, images, the total and the room left; for a device in a vault. */
export function UsageRows({ snapshot }: { snapshot: SyncSnapshot }) {
  const [retried, setRetried] = useState(0)
  const { relayUrl, status, enrolled } = snapshot
  const reading = useRelayUsage(
    enrolled,
    [relayUrl, snapshot.enabled, status.state, status.code, status.lastSync, retried].join('|'),
  )
  const locale = currentLocale()
  if (!enrolled) return null
  if (reading?.state !== 'ready') {
    return <Unavailable reading={reading} retry={() => setRetried((n) => n + 1)} />
  }
  const { view } = reading
  const shown = figures(view, locale)
  const warn = warning(view, snapshot)
  const note = capNote(view, locale)
  return (
    <>
      <Setting live label="syncSettings.usage.records" description={shown.records}>
        {null}
      </Setting>
      <Setting live label="syncSettings.usage.images" description={shown.images}>
        {null}
      </Setting>
      <Setting live label="syncSettings.usage.total" description={shown.total}>
        {null}
      </Setting>
      <Setting live label="syncSettings.usage.room" description={shown.room}>
        {null}
      </Setting>
      {warn ? <SettingsNote>{warn}</SettingsNote> : null}
      {note ? <SettingsNote>{note}</SettingsNote> : null}
    </>
  )
}
