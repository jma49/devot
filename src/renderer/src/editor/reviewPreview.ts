// What Undo N Edits takes back, marked while its button has the pointer or the keyboard: every place
// of those writes, tinted as the review's selection is when the editor does not have the keyboard.
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

export interface PreviewPlace {
  from: number
  to: number
}

export const setReviewPreview = StateEffect.define<readonly PreviewPlace[]>()

class DeletionPoint extends WidgetType {
  override eq() {
    return true
  }

  toDOM() {
    const point = document.createElement('span')
    point.className = 'cm-review-preview-point'
    return point
  }
}

const inserted = Decoration.mark({ class: 'cm-review-preview' })
const deletion = Decoration.widget({ widget: new DeletionPoint(), side: 1 })

export function previewDecorations(places: readonly PreviewPlace[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = places
    .filter((place) => place.from <= length)
    .map((place) => {
      const to = Math.min(place.to, length)
      return to > place.from ? inserted.range(place.from, to) : deletion.range(place.from)
    })
  return Decoration.set(ranges, true)
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewPreview)) return previewDecorations(effect.value, tr.state.doc.length)
    }
    return marks.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

const theme = EditorView.theme({
  '.cm-review-preview': {
    backgroundColor: 'var(--color-accent-selection-inactive)',
  },
  '.cm-review-preview-point': {
    display: 'inline-block',
    width: 'var(--size-focus-ring)',
    height: '1em',
    marginInline: 'calc(var(--size-focus-ring) / -2)',
    verticalAlign: 'text-bottom',
    backgroundColor: 'var(--color-accent-selection)',
  },
})

export const reviewPreview: Extension = [field, theme]
