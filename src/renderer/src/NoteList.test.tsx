// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '../../core'
import { NoteList } from './NoteList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note = (id: string, pinned = false): NoteSummary => ({
  id,
  title: `Note ${id}`,
  createdAt: 0,
  updatedAt: 0,
  bodyVersion: 1,
  bookId: null,
  status: 'active',
  pinned,
  tagIds: [],
})

let root: Root
let host: HTMLElement
let onSelect: ReturnType<typeof vi.fn<(id: string) => void>>

beforeEach(async () => {
  onSelect = vi.fn<(id: string) => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(
      <NoteList
        view="all"
        title="All Notes"
        pinned={[note('p', true)]}
        notes={[note('a'), note('b')]}
        tags={new Map()}
        selected="b"
        onSelect={onSelect}
        onCreate={undefined}
      />,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const row = (id: string) => document.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!
const header = () => document.querySelector<HTMLElement>('[data-section="section:others"]')!
const fire = (el: Element, type: string) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
  })

describe('a press on a row', () => {
  it('opens its row when the release lands elsewhere in the list, as the row moved away', async () => {
    await fire(row('a'), 'mousedown')
    await fire(header(), 'mouseup')
    expect(onSelect).toHaveBeenCalledWith('a')
  })

  it('that ends in a drag opens nothing on a later click on a section header', async () => {
    await fire(row('a'), 'mousedown')
    await act(async () => {
      const drag = new Event('dragstart', { bubbles: true, cancelable: true })
      const data = new DataTransfer()
      // This DOM draws no drag images.
      data.setDragImage = () => undefined
      Object.defineProperty(drag, 'dataTransfer', { value: data })
      row('a').dispatchEvent(drag)
    })
    await fire(header(), 'mousedown')
    await fire(header(), 'mouseup')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('released outside the list opens nothing on a later click on a section header', async () => {
    await fire(row('a'), 'mousedown')
    await fire(document.body, 'mouseup')
    await fire(header(), 'mousedown')
    await fire(header(), 'mouseup')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
