import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  alertMatches,
  alertSource,
  alertTrigger,
  emojiMatches,
  emojiSource,
  emojiTrigger,
} from './inlineCompletions'
import { noteMarkdown } from './markdown'

function state(marked: string) {
  const at = marked.indexOf('^')
  const s = EditorState.create({
    doc: marked.slice(0, at) + marked.slice(at + 1),
    selection: EditorSelection.cursor(at),
    extensions: [noteMarkdown],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s
}
const context = (marked: string) => {
  const s = state(marked)
  return new CompletionContext(s, s.selection.main.head, false)
}

describe('emoji completion', () => {
  it('opens after `:` and two or more word characters', () => {
    expect(emojiTrigger(state(':sm^'))).toEqual({ from: 0, query: 'sm' })
    expect(emojiTrigger(state('Hi :+1^'))).toEqual({ from: 3, query: '+1' })
    expect(emojiTrigger(state(':s^'))).toBeNull()
    expect(emojiTrigger(state('12:30^'))).toBeNull()
    expect(emojiTrigger(state('https://x^'))).toBeNull()
  })

  it('ranks shortcodes that start with the query first, shorter first', () => {
    const list = [
      { name: 'smile_cat', emoji: 'a' },
      { name: 'grinning_smile', emoji: 'b' },
      { name: 'smile', emoji: 'c' },
      { name: 'tada', emoji: 'd' },
    ]
    expect(emojiMatches(list, 'SMI').map((e) => e.name)).toEqual([
      'smile',
      'smile_cat',
      'grinning_smile',
    ])
  })

  it('inserts the character for a picked shortcode', async () => {
    const result = await emojiSource(context('Done :tad^'))
    expect(result?.from).toBe(5)
    const tada = result?.options.find((o) => o.label === ':tada:')
    expect(tada?.apply).toBe('\u{1f389}')
  })

  it('stays closed in code', async () => {
    expect(await emojiSource(context('`:smile^`'))).toBeNull()
    expect(await emojiSource(context('```\n:smile^\n```'))).toBeNull()
  })
})

describe('alert completion', () => {
  it('opens after `> [!` and filters the kinds', () => {
    expect(alertTrigger(state('> [!^'))).toEqual({ from: 2, to: 4, query: '' })
    // The `]` the bracket closing added goes with the pick.
    expect(alertTrigger(state('> [!w^]'))).toEqual({ from: 2, to: 6, query: 'w' })
    expect(alertTrigger(state('[!^'))).toBeNull()
    expect(alertTrigger(state('> text [!^'))).toBeNull()
    expect(alertMatches('')).toEqual(['note', 'tip', 'important', 'warning', 'caution'])
    expect(alertMatches('I')).toEqual(['important'])
  })

  it('completes the `[!KIND]` line', () => {
    const s = state('> [!wa^]')
    const result = alertSource(new CompletionContext(s, s.selection.main.head, false))!
    expect(result.options.map((o) => o.label)).toEqual(['[!WARNING]'])
    let next = s
    const view = {
      state: s,
      dispatch: (spec: object) => (next = s.update(spec).state),
    }
    const apply = result.options[0]!.apply as (
      v: unknown,
      c: unknown,
      from: number,
      to: number,
    ) => void
    apply(view, result.options[0], result.from, result.to ?? 0)
    expect(next.doc.toString()).toBe('> [!WARNING]')
    expect(next.selection.main.head).toBe(12)
  })
})
