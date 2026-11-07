import { useCallback, useEffect, useRef, useState } from 'react'
import { errorCode } from '../../../core/errors'
import type { NoteSummary } from '../../../core/storage'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { sizes } from '../theme/tokens'
import { haptic } from './haptics'
import { refusedWrite } from './requireEditing'
import { completeNote, trashNote, undoNote, type UndoEntry } from './undo'
import type { PhoneStore } from './usePhoneData'

// How long it can be read, not a motion: a slowed-down development build keeps it.
const TOAST_MS = Number.parseFloat(sizes['motion.duration.phone-toast'])

const LOOK: Readonly<
  Record<UndoEntry['kind'], { text: MessageKey; icon: IconName; color: string }>
> = {
  trash: { text: 'phone.toast.trashed', icon: 'trash', color: 'var(--color-phone-destructive)' },
  complete: {
    text: 'phone.toast.completed',
    icon: 'phone.completed',
    color: 'var(--color-status-done-mark)',
  },
}

export interface UndoToast {
  readonly kind: UndoEntry['kind']
  readonly seq: number
  readonly shown: boolean
  readonly onUndo: () => void
}

/** Trash and complete with the toast that takes them back; a second action replaces the toast and the first stays done. */
export function useUndoToast(store: PhoneStore) {
  const [current, setCurrent] = useState<{ entry: UndoEntry; seq: number } | null>(null)
  const [last, setLast] = useState<{ kind: UndoEntry['kind']; seq: number }>({
    kind: 'trash',
    seq: 0,
  })
  const seq = useRef(0)
  const { core, refresh } = store

  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => setCurrent(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [current])

  const offer = useCallback(
    (entry: UndoEntry) => {
      seq.current += 1
      const offered = { entry, seq: seq.current }
      setCurrent(offered)
      setLast({ kind: entry.kind, seq: seq.current })
      haptic(entry.kind === 'trash' ? 'warning' : 'success')
      void entry.done.then(refresh, (e: unknown) => {
        if (!refusedWrite(entry.kind, e)) console.warn('W_PHONE_NOTE_ACTION_FAILED', errorCode(e))
        setCurrent((now) => (now === offered ? null : now))
        refresh()
      })
    },
    [refresh],
  )

  const trash = useCallback(
    (note: NoteSummary) => {
      if (core) offer(trashNote(core, note))
    },
    [core, offer],
  )
  const complete = useCallback(
    (note: NoteSummary) => {
      const entry = core && completeNote(core, note)
      if (entry) offer(entry)
    },
    [core, offer],
  )

  const toast: UndoToast = {
    kind: last.kind,
    seq: last.seq,
    shown: current !== null,
    onUndo: () => {
      if (!core || !current) return
      const { entry } = current
      setCurrent(null)
      void undoNote(core, entry)
        .catch((e: unknown) => console.warn('W_PHONE_UNDO_FAILED', errorCode(e)))
        .then(refresh)
    },
  }
  return { toast, trash, complete }
}

export function PhoneToast(props: { toast: UndoToast }) {
  const { kind, seq, shown, onUndo } = props.toast
  const look = LOOK[kind]
  return (
    <div
      role="status"
      aria-live="polite"
      className="phone-glass phone-toast"
      data-shown={shown || undefined}
      inert={!shown}
    >
      <span key={seq} className="phone-toast-text">
        <span aria-hidden="true" className="phone-toast-icon" style={{ color: look.color }}>
          <Icon name={look.icon} size="phone-toast" />
        </span>
        {t(look.text)}
      </span>
      <button type="button" className="phone-toast-undo" onClick={onUndo}>
        <span className="phone-toast-undo-pill">{t('phone.toast.undo')}</span>
      </button>
    </div>
  )
}
