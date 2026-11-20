import catalog from '../../../../design/icons/kubai.json'
import type { IconName } from './symbols'

/**
 * Kubai's 31-unit canvas cropped about its glyphs' centre (15.5, 12.5) to 27 units, so their ink
 * fills the box as much as Lucide's does; the drop shadow still paints past it (`overflow`).
 */
export const KUBAI_VIEWBOX = '2 -1 27 27'

/**
 * The Devot icons Kubai draws (https://icons.kubai.design, MIT). Kubai draws objects, so the bare
 * marks (chevrons, check, plus, the status circles and the tag dot) stay Lucide's.
 */
export const KUBAI_ICONS: Readonly<Partial<Record<IconName, string>>> = catalog.symbols

let loading: Promise<void> | undefined
const listeners = new Set<() => void>()

export type KubaiGlyphs =
  | { phase: 'loading' }
  | { phase: 'ready'; glyphs: Readonly<Record<string, string>> }
  | { phase: 'failed' }

let state: KubaiGlyphs = { phase: 'loading' }

function settle(next: KubaiGlyphs) {
  state = next
  for (const notify of listeners) notify()
}

/** Loads the Kubai glyphs, one chunk taken only when the setting asks for them; a failure is tried again on the next call. */
export function loadKubaiGlyphs(): Promise<void> {
  loading ??= import('./kubaiGlyphs').then(
    (module) => settle({ phase: 'ready', glyphs: module.KUBAI_GLYPHS }),
    () => {
      loading = undefined
      console.warn('W_KUBAI_GLYPHS_UNAVAILABLE')
      settle({ phase: 'failed' })
    },
  )
  return loading
}

export const kubaiGlyphs = (): KubaiGlyphs => state

export function subscribeKubaiGlyphs(notify: () => void) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

let instances = 0
/** An id for one drawn glyph, so its gradients and filters never resolve to another's. */
export const kubaiInstanceId = () => `kd${(instances++).toString(36)}`

const attributeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export const kubaiContent = (content: string, id: string) => content.replaceAll('__K__', id)

export function kubaiMarkup(content: string, box: number, className: string, id: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${KUBAI_VIEWBOX}" width="${box}" height="${box}" fill="none" overflow="visible" class="${attributeText(className)}" aria-hidden="true">${kubaiContent(content, id)}</svg>`
}
