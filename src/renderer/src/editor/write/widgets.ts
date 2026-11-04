// What Write mode shows in place of hidden marks. Each widget is one unit for
// the caret (atomic). A click on a label or a title places the caret like a
// click on text; a checkbox answers its own clicks, so ticking a task never
// moves the caret onto its line.
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { Facet } from '@codemirror/state'
import type { AlertKind } from '../blocks'
import type { LoadPreview } from '../../notePreview'
import { t } from '../../i18n'
import { taskToggle } from '../tasks'
import type { WriteRange } from './rules'

/** Loads a linked note's title for a note link with no text of its own. */
export const writeNoteLoader = Facet.define<LoadPreview, LoadPreview | null>({
  combine: (values) => values[0] ?? null,
})

class TaskWidget extends WidgetType {
  /** `box` is where the `[` is, counted from the start of the range the box stands in for. */
  constructor(
    readonly done: boolean,
    readonly box: number,
  ) {
    super()
  }

  override eq(other: TaskWidget): boolean {
    return other.done === this.done && other.box === this.box
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-wm-task'
    box.checked = this.done
    box.tabIndex = -1
    box.setAttribute('aria-label', t('command.toggleTask'))
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      // The note changes and draws the box again; the box never ticks itself.
      event.preventDefault()
      const change = taskToggle(view.state, view.posAtDOM(box) + this.box + 1)
      if (change) view.dispatch(change)
    })
    return box
  }

  override ignoreEvent(): boolean {
    return true
  }
}

class AlertLabelWidget extends WidgetType {
  constructor(readonly alert: AlertKind) {
    super()
  }

  override eq(other: AlertLabelWidget): boolean {
    return other.alert === this.alert
  }

  override toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'cm-wm-alert-label'
    label.textContent = t(`alert.${this.alert}`)
    return label
  }

  /** A click puts the caret there, as on text. */
  override ignoreEvent(): boolean {
    return false
  }
}

class NoteTitleWidget extends WidgetType {
  constructor(readonly id: string) {
    super()
  }

  override eq(other: NoteTitleWidget): boolean {
    return other.id === this.id
  }

  override toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'cm-wm-note-chip cm-wm-note-title'
    chip.textContent = t('note.untitled')
    const load = view.state.facet(writeNoteLoader)
    void load?.(this.id).then(
      (note) => {
        if (note === null) {
          chip.classList.add('cm-wm-note-missing')
          chip.textContent = t('preview.missingNote')
        } else if (note.title) chip.textContent = note.title
      },
      () => console.warn('W_WRITE_NOTE_TITLE_FAILED'),
    )
    return chip
  }

  override ignoreEvent(): boolean {
    return false
  }
}

class FootnoteWidget extends WidgetType {
  constructor(
    readonly number: number,
    readonly definition: boolean,
  ) {
    super()
  }

  override eq(other: FootnoteWidget): boolean {
    return other.number === this.number && other.definition === this.definition
  }

  override toDOM(): HTMLElement {
    const mark = document.createElement('sup')
    mark.className = this.definition ? 'cm-wm-footnote cm-wm-footnote-definition' : 'cm-wm-footnote'
    mark.textContent = String(this.number)
    return mark
  }

  override ignoreEvent(): boolean {
    return false
  }
}

const HIDE = Decoration.replace({})
const RULE_LINE = Decoration.line({ class: 'cm-wm-rule' })
const BULLETS = [1, 2, 3].map((n) => Decoration.mark({ class: `cm-wm-bullet cm-wm-bullet-${n}` }))
const UNIT = Decoration.mark({})

/** Whether the caret steps over `range` as one unit. */
export const atomic = (range: WriteRange) =>
  range.kind !== 'bullet' && range.kind !== 'mark' && range.kind !== 'line'

/** Whether `range` is drawn; a unit only groups characters for the caret. */
export const drawn = (range: WriteRange) => range.kind !== 'unit'

export function decorationOf(range: WriteRange): Decoration {
  switch (range.kind) {
    case 'hide':
      return HIDE
    case 'bullet':
      return BULLETS[(range.depth - 1) % BULLETS.length] as Decoration
    case 'task':
      return Decoration.replace({ widget: new TaskWidget(range.done, range.box - range.from) })
    case 'alert':
      return Decoration.replace({ widget: new AlertLabelWidget(range.alert) })
    case 'noteTitle':
      return Decoration.replace({ widget: new NoteTitleWidget(range.id) })
    case 'footnote':
      return Decoration.replace({ widget: new FootnoteWidget(range.number, range.definition) })
    case 'mark':
      return Decoration.mark({ class: range.className })
    case 'line':
      return range.className === 'cm-wm-rule'
        ? RULE_LINE
        : Decoration.line({ class: range.className })
    case 'unit':
      return UNIT
  }
}
