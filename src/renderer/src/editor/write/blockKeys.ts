// The keys around Write mode's rendered blocks (blockRanges.ts): the arrows
// enter a closed block's source, Backspace and Delete select it first.
import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'
import { blockBackspace, blockDelete, blockEnter, enterBlock } from './blockRanges'

const run =
  (make: typeof blockEnter): Command =>
  (view) => {
    const spec = make(view.state)
    if (!spec) return false
    view.dispatch(spec)
    return true
  }

const vertical =
  (forward: boolean): Command =>
  (view) => {
    const { state } = view
    let moved = false
    const selection = EditorSelection.create(
      state.selection.ranges.map((range) => {
        const next = view.moveVertically(range, forward)
        const head = enterBlock(state, range, next.head, forward)
        if (head === next.head) return next
        moved = true
        return EditorSelection.cursor(head, forward ? 1 : -1)
      }),
      state.selection.mainIndex,
    )
    if (!moved) return false
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' })
    return true
  }

// The arrows give way to pop-up lists (completions), which take them at the highest precedence.
export const writeBlockKeys: Extension = [
  Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: vertical(true) },
      { key: 'ArrowUp', run: vertical(false) },
    ]),
  ),
  Prec.highest(
    keymap.of([
      { key: 'Backspace', run: run(blockBackspace) },
      { key: 'Delete', run: run(blockDelete) },
      { key: 'Enter', run: run(blockEnter) },
    ]),
  ),
]
