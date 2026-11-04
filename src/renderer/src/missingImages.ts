// An image that did not load shows a placeholder, and the image replaces it once it is here: an attachment that
// has not arrived yet (sync pulls it from the relay, docs/adr/0003-sync-attachments-as-records.md) anywhere, and in
// the preview and Write mode's blocks any image. The placeholder is the same <img>, marked; app.css keeps the web
// view from drawing its broken-image icon in it, and content.css draws a block image's placeholder in its paragraph.
import { DB_CHANGED } from './externalChanges'
import { format, t } from './i18n'

export const MISSING_IMAGE = 'image-missing'

const ATTACHMENT_SRC = /^devot:\/\/file\//
const ALT = 'data-missing-alt'

/** On a block image's paragraph: the alt text its placeholder shows under the glyph. */
const BLOCK_ALT = 'data-image-missing-alt'
const BLOCK_IMAGE = 'image-block'

export const isMissingImage = (img: Element) => img.classList.contains(MISSING_IMAGE)

/** What a placeholder is called, or null when `src` gets none: only attachments do unless `anyImage`. */
export function missingImageLabel(src: string, alt: string, anyImage: boolean): string | null {
  const attachment = ATTACHMENT_SRC.test(src)
  if (!attachment && !anyImage) return null
  const [named, plain] = attachment
    ? (['image.missingNamed', 'image.missing'] as const)
    : (['image.failedNamed', 'image.failed'] as const)
  return alt ? format(t(named), { alt }) : t(plain)
}

/** Marks `img` as a placeholder when it gets one (`missingImageLabel`); false otherwise. */
export function markMissing(img: HTMLImageElement, anyImage = false): boolean {
  if (isMissingImage(img)) return true
  const alt = img.getAttribute('alt') ?? ''
  const label = missingImageLabel(img.getAttribute('src') ?? '', alt, anyImage)
  if (label === null) return false
  img.setAttribute(ALT, alt)
  img.setAttribute('alt', '')
  img.setAttribute('role', 'img')
  img.setAttribute('aria-label', label)
  img.classList.add(MISSING_IMAGE)
  if (img.classList.contains(BLOCK_IMAGE)) img.parentElement?.setAttribute(BLOCK_ALT, alt)
  return true
}

function restore(img: HTMLImageElement) {
  img.parentElement?.removeAttribute(BLOCK_ALT)
  img.setAttribute('alt', img.getAttribute(ALT) ?? '')
  img.removeAttribute(ALT)
  img.removeAttribute('role')
  img.removeAttribute('aria-label')
  img.classList.remove(MISSING_IMAGE)
}

/**
 * Marks the attachment images under `root` that fail to load, and loads them again whenever the
 * database changes (a pulled image arrives that way). Returns the stop.
 */
export function watchMissingImages(root: HTMLElement, { anyImage = false } = {}): () => void {
  const failed = (event: Event) => {
    if (event.target instanceof HTMLImageElement) markMissing(event.target, anyImage)
  }
  const arrived = (event: Event) => {
    if (event.target instanceof HTMLImageElement && isMissingImage(event.target))
      restore(event.target)
  }
  // The placeholder stays until the image loads, so its box does not collapse while it reloads.
  // The same address again: the protocol answers with the image once it is stored.
  const retryAll = () => {
    for (const img of root.querySelectorAll<HTMLImageElement>(`img.${MISSING_IMAGE}`)) {
      const src = img.getAttribute('src') ?? ''
      if (ATTACHMENT_SRC.test(src)) img.src = src
    }
  }
  // Load and error do not bubble: caught on the way down.
  root.addEventListener('error', failed, true)
  root.addEventListener('load', arrived, true)
  // Only attachments come later; another image that failed stays failed until the note is drawn again.
  // Sync raises the database change in the main window only: a window opened later looks again on focus.
  window.addEventListener(DB_CHANGED, retryAll)
  window.addEventListener('focus', retryAll)
  return () => {
    root.removeEventListener('error', failed, true)
    root.removeEventListener('load', arrived, true)
    window.removeEventListener(DB_CHANGED, retryAll)
    window.removeEventListener('focus', retryAll)
  }
}
