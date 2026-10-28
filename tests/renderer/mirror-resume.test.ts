// A quit another window called off: the main window had already stopped its mirror for the exit, so
// it must start it again, or the Markdown folder stays stale for the rest of the session (A039).
import { describe, expect, it, vi } from 'vitest'
import { MIRROR_OFF, resumeMirrorAfterCancelledQuit } from '../../src/renderer/src/mirror'

const core = () => ({ mirrorReconcile: vi.fn<(generation?: number) => void>() })

describe('resumeMirrorAfterCancelledQuit', () => {
  it('starts a full pass again when a folder is set', () => {
    const c = core()
    resumeMirrorAfterCancelledQuit(c, { ...MIRROR_OFF, folder: '/notes', generation: 7 })
    // A full pass, since `stop` forgot what it had reconciled.
    expect(c.mirrorReconcile).toHaveBeenCalledWith(7)
  })

  it('does nothing when no folder is set', () => {
    const c = core()
    resumeMirrorAfterCancelledQuit(c, MIRROR_OFF)
    expect(c.mirrorReconcile).not.toHaveBeenCalled()
  })

  it('reads the status when none is given', () => {
    const c = core()
    resumeMirrorAfterCancelledQuit(c)
    // The window under test has no folder: nothing starts.
    expect(c.mirrorReconcile).not.toHaveBeenCalled()
  })
})
