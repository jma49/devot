import { setGlassPrefs, storedGlassTransparency, TRANSPARENCY_MAX } from '../glassPrefs'
import type { ScreensHandlers } from './ops'

const isTransparency = (value: unknown): value is number =>
  Number.isInteger(value) && Math.abs(value as number) <= TRANSPARENCY_MAX

/**
 * Under the native screens the iPhone's own store owns Glass Transparency: it takes the page's
 * value once, then sets the page's glass from its own; the page keeps a copy to paint at launch.
 */
export function glassHandlers(): ScreensHandlers {
  return {
    'glass.get': async () => ({ transparency: storedGlassTransparency() }),
    'glass.set': async (args) => {
      const transparency = args['transparency']
      if (!isTransparency(transparency)) throw new Error('E_SCREENS_ARGS_INVALID')
      setGlassPrefs({ transparency })
      return {}
    },
  }
}
