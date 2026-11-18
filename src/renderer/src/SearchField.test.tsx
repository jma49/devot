// @vitest-environment happy-dom
import { act, type ComponentProps, type KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookRecord, TagRecord } from '../../core/storage'
import { SearchField } from './SearchField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./icons/Icon', () => ({ Icon: () => null }))

const BOOKS: BookRecord[] = [
  {
    id: 'b1',
    name: 'Weekly notes',
    nameHlc: '1',
    parentId: null,
    parentHlc: '',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    sortKey: '1',
    sortKeyHlc: '',
    icon: null,
    iconColor: null,
    iconHlc: '',
  },
  {
    id: 'b2',
    name: 'Work',
    nameHlc: '1',
    parentId: null,
    parentHlc: '',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    sortKey: '2',
    sortKeyHlc: '',
    icon: null,
    iconColor: null,
    iconHlc: '',
  },
]

const TAGS: TagRecord[] = [
  {
    id: 't1',
    name: 'urgent',
    nameHlc: '1',
    color: 'red',
    colorHlc: '1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
  },
]

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
})

function mount(
  initial: string,
  extra: Partial<ComponentProps<typeof SearchField>> = {},
  onParentKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void,
) {
  let latest = initial
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onChange = vi.fn<(next: string) => void>((next) => {
    latest = next
    draw(next)
  })
  const onClear = vi.fn<() => void>(() => {
    latest = ''
    draw('')
  })
  const draw = (value: string) =>
    act(() =>
      root.render(
        <div onKeyDown={onParentKeyDown}>
          <SearchField
            value={value}
            onChange={onChange}
            onClear={onClear}
            placeholder="Search"
            {...extra}
          />
        </div>,
      ),
    )
  draw(initial)
  unmounts.push(() => {
    act(() => root.unmount())
    host.remove()
  })
  const input = () => host.querySelector<HTMLInputElement>('input[type="search"]')!
  const suggestions = () => host.querySelectorAll<HTMLElement>('[role="option"]')
  const pills = () => host.querySelectorAll<HTMLElement>('.search-pill')
  const setValue = (text: string, caret = text.length) =>
    act(() => {
      const el = input()
      el.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
      el.setSelectionRange(caret, caret)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      )
    })
  return {
    host,
    input,
    suggestions,
    pills,
    setValue,
    setExternalValue: (next: string) => {
      latest = next
      draw(next)
    },
    press,
    onChange,
    onClear,
    value: () => latest,
  }
}

describe('SearchField filter pills and autocomplete', () => {
  it('compiles and works without optional books or tags props', () => {
    const ui = mount('')
    ui.setValue('is:')
    expect(ui.suggestions().length).toBe(5)
    ui.press('ArrowDown')
    ui.press('Enter')
    expect(ui.value()).toBe('is:active ')
    expect(ui.pills()).toHaveLength(1)
  })

  it('accepts autocomplete without propagating Enter, dismisses on Escape before clearing, and guards IME', () => {
    const parentKeyDown = vi.fn<(e: KeyboardEvent<HTMLDivElement>) => void>()
    const ui = mount('', { books: BOOKS, tags: TAGS }, parentKeyDown)
    ui.setValue('in:we')
    expect(ui.suggestions().length).toBe(1)

    // IME Enter must be ignored.
    ui.press('Enter', { isComposing: true })
    expect(ui.value()).toBe('in:we')
    expect(parentKeyDown).toHaveBeenCalledTimes(1)
    parentKeyDown.mockClear()

    // Normal Enter accepts suggestion and stops propagation so ListHeader doesn't steal focus.
    ui.press('Enter')
    expect(ui.value()).toBe('in:"Weekly notes" ')
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(ui.pills()).toHaveLength(1)
    expect(ui.input().value).toBe('')

    // Open # suggestion, first Escape dismisses popover and preserves query, second clears.
    ui.setValue('#u')
    expect(ui.suggestions().length).toBe(1)
    ui.press('Escape')
    expect(ui.suggestions()).toHaveLength(0)
    expect(ui.onClear).not.toHaveBeenCalled()
    ui.press('Escape')
    expect(ui.onClear).toHaveBeenCalledTimes(1)
    expect(ui.value()).toBe('')
  })

  it('removes a single pill via close button and unwraps/removes on Backspace at caret 0 only', () => {
    const ui = mount('in:"Weekly notes" pinned:true ', { books: BOOKS, tags: TAGS })
    expect(ui.pills()).toHaveLength(2)

    act(() => {
      ui.pills()[0]!.querySelector<HTMLButtonElement>('.search-pill-remove')!.click()
    })
    expect(ui.value()).toBe('pinned:true ')
    expect(ui.pills()).toHaveLength(1)

    // With empty input at caret 0, Backspace unwraps the pill back into the input.
    ui.input().focus()
    ui.input().setSelectionRange(0, 0)
    ui.press('Backspace')
    expect(ui.value()).toBe('pinned:true')
    expect(ui.pills()).toHaveLength(0)

    // With non-empty draft, Backspace at caret 0 removes the last pill.
    const ui2 = mount('in:Work plan', { books: BOOKS, tags: TAGS })
    ui2.input().focus()
    ui2.input().setSelectionRange(0, 0)
    ui2.press('Backspace')
    expect(ui2.value()).toBe('plan')
  })

  it('associates <label htmlFor> with the text input so clicking pills or label area does not remove a pill', () => {
    const ui = mount('in:Work -tag:urgent ', { books: BOOKS, tags: TAGS })
    const label = ui.host.querySelector<HTMLLabelElement>('label.search-field')!
    expect(label.control).toBe(ui.input())
    expect(ui.input().id).not.toBe('')
    ui.onChange.mockClear()

    act(() => {
      ui.pills()[0]!
        .querySelector<HTMLElement>('.search-pill-label')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(ui.pills()).toHaveLength(2)
    expect(ui.value()).toBe('in:Work -tag:urgent ')
    expect(ui.onChange).not.toHaveBeenCalled()
  })

  it('keeps preedit intact during IME composition, suppresses suggestions, and commits on compositionend', () => {
    const ui = mount('', { books: BOOKS, tags: TAGS })
    ui.onChange.mockClear()

    act(() => {
      const el = ui.input()
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        el,
        'in:zhong\u2006wen',
      )
      el.setSelectionRange(12, 12)
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          isComposing: true,
          data: 'in:zhong\u2006wen',
        }),
      )
    })

    expect(ui.pills()).toHaveLength(0)
    expect(ui.input().value).toBe('in:zhong\u2006wen')
    expect(ui.suggestions()).toHaveLength(0)
    expect(ui.onChange).not.toHaveBeenCalled()

    // External value reset discards stale preedit state immediately.
    ui.setExternalValue('Work')
    expect(ui.input().value).toBe('Work')

    // Commit Chinese text with a trailing space: now extract pill on compositionend.
    const commitBooks: BookRecord[] = [...BOOKS, { ...BOOKS[0]!, id: 'b-zh', name: '\u4e2d\u6587' }]
    const uiZh = mount('', { books: commitBooks, tags: TAGS })
    uiZh.onChange.mockClear()

    act(() => {
      const el = uiZh.input()
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        el,
        'in:zhong\u2006wen',
      )
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, isComposing: true, data: 'in:zhong\u2006wen' }),
      )
    })
    expect(uiZh.pills()).toHaveLength(0)
    expect(uiZh.onChange).not.toHaveBeenCalled()

    act(() => {
      const el = uiZh.input()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        el,
        'in:\u4e2d\u6587 ',
      )
      el.setSelectionRange(6, 6)
      el.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '\u4e2d\u6587 ' }),
      )
    })
    expect(uiZh.value()).toBe('in:\u4e2d\u6587 ')
    expect(uiZh.pills()).toHaveLength(1)
    expect(uiZh.pills()[0]!.querySelector('.search-pill-label')?.textContent).toBe('\u4e2d\u6587')
    expect(uiZh.input().value).toBe('')
  })
})
