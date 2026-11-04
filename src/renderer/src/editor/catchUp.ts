import * as Y from 'yjs'
import { errorCode } from '../../../core/errors'

/**
 * Brings a replica made from an earlier state up to the core's document. The core sends changes as
 * increments: one sent while no editor took it leaves every later one from that writer pending.
 */
export function catchUp(
  doc: Y.Doc,
  open: (known: Uint8Array) => Promise<{ state: Uint8Array }>,
  stillShown: () => boolean,
  origin: unknown,
): Promise<void> {
  return open(Y.encodeStateVector(doc)).then(
    (opened) => {
      if (stillShown()) Y.applyUpdate(doc, opened.state, origin)
    },
    (e: unknown) => console.warn('W_NOTE_CATCH_UP_FAILED', errorCode(e)),
  )
}
