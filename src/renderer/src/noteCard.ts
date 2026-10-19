// The card a note link shows on hover and in the `[[` popup: the linked
// note's title over the start of its body in plain text. One DOM builder and
// one set of rules serve the editor (a CodeMirror theme, in its shadow root)
// and the preview (preview/content.css has the same rules for the page).
import { EditorView } from '@codemirror/view'
import { t } from './i18n'
import type { NotePreview } from './notePreview'

export function noteCardDom(preview: NotePreview | null): HTMLElement {
  const card = document.createElement('div')
  card.className = 'note-card'
  const title = document.createElement('div')
  title.className = 'note-card-title'
  title.textContent = preview ? preview.title || t('note.untitled') : t('notePreview.missing')
  card.append(title)
  if (preview) {
    const body = document.createElement('div')
    body.className = 'note-card-excerpt'
    body.textContent = preview.excerpt || t('notePreview.empty')
    card.append(body)
  }
  return card
}

const noteCardStyles = {
  '.note-card': {
    boxSizing: 'border-box',
    width: 'var(--size-menu-width)',
    maxWidth: '100%',
    padding: 'var(--space-4) var(--space-5)',
    fontFamily: 'var(--font-family-ui)',
    color: 'var(--color-text-primary)',
  },
  '.note-card-title': {
    fontSize: 'var(--font-size-body)',
    fontWeight: 'var(--font-weight-semibold)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.note-card-excerpt': {
    marginTop: 'var(--space-2)',
    fontSize: 'var(--font-size-footnote)',
    color: 'var(--color-text-secondary)',
    overflowWrap: 'anywhere',
  },
}

export const noteCardTheme = EditorView.theme(noteCardStyles)
