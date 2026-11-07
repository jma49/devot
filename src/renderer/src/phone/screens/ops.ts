import type { ScreensOp } from './message'

export type ScreensHandler = (args: Readonly<Record<string, unknown>>) => Promise<unknown>
export type ScreensHandlers = Readonly<Partial<Record<ScreensOp, ScreensHandler>>>

/**
 * The operations the page runs for the native screens, whose arguments Rust has checked. An
 * operation gets its handler with the pull request that first sends it; until then the page
 * answers it `E_SCREENS_OP_UNSUPPORTED`.
 */
export const SCREENS_HANDLERS: ScreensHandlers = {
  ping: async () => ({}),
}
