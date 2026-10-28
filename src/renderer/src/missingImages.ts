// An attachment whose image has not arrived yet (sync pulls it from the relay, docs/adr/0003-sync-attachments-as-records.md)
// shows a placeholder at the fixed inline image height, and the image replaces it once it is here.
// The placeholder is the same <img>, marked: an empty alt keeps the web view from drawing its broken-image icon.
import { DB_CHANGED } from './externalChanges'

export const MISSING_IMAGE = 'image-missing'

const ATTACHMENT_SRC = /^devot:\/\/file\//
const ALT = 'data-missing-alt'

export const isMissingImage = (img: Element) => img.classList.contains(MISSING_IMAGE)

/** Marks `img` as a placeholder when it is an attachment; false for any other image. */
export function markMissing(img: HTMLImageElement): boolean {
  if (!ATTACHMENT_SRC.test(img.getAttribute('src') ?? '')) return false
  if (isMissingImage(img)) return true
  img.setAttribute(ALT, img.getAttribute('alt') ?? '')
  img.setAttribute('alt', '')
  img.classList.add(MISSING_IMAGE)
  return true
}

function retry(img: HTMLImageElement) {
  img.setAttribute('alt', img.getAttribute(ALT) ?? '')
  img.removeAttribute(ALT)
  img.classList.remove(MISSING_IMAGE)
  // The same address again: the protocol answers with the image once it is stored.
  img.src = img.getAttribute('src') ?? ''
}

/**
 * Marks the attachment images under `root` that fail to load, and loads them again whenever the
 * database changes (a pulled image arrives that way). Returns the stop.
 */
export function watchMissingImages(root: HTMLElement): () => void {
  const failed = (event: Event) => {
    if (event.target instanceof HTMLImageElement) markMissing(event.target)
  }
  const retryAll = () => {
    for (const img of root.querySelectorAll<HTMLImageElement>(`img.${MISSING_IMAGE}`)) retry(img)
  }
  // Load and error do not bubble: caught on the way down.
  root.addEventListener('error', failed, true)
  window.addEventListener(DB_CHANGED, retryAll)
  return () => {
    root.removeEventListener('error', failed, true)
    window.removeEventListener(DB_CHANGED, retryAll)
  }
}
