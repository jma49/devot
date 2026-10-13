import { describe, expect, it } from 'vitest'
import { nextArea, type Area } from './areas'

const shown =
  (...areas: Area[]) =>
  (area: Area) =>
    areas.includes(area)

describe('nextArea', () => {
  it('goes sidebar, list, editor and round again', () => {
    const all = shown('sidebar', 'list', 'editor')
    expect(nextArea('sidebar', 1, all)).toBe('list')
    expect(nextArea('list', 1, all)).toBe('editor')
    expect(nextArea('editor', 1, all)).toBe('sidebar')
    expect(nextArea('sidebar', -1, all)).toBe('editor')
    expect(nextArea('list', -1, all)).toBe('sidebar')
    expect(nextArea('editor', -1, all)).toBe('list')
  })

  it('starts at the sidebar, or the editor going back, from outside the areas', () => {
    expect(nextArea(undefined, 1, shown('sidebar', 'list', 'editor'))).toBe('sidebar')
    expect(nextArea(undefined, -1, shown('sidebar', 'list', 'editor'))).toBe('editor')
    expect(nextArea(undefined, 1, shown('list'))).toBe('list')
  })

  it('skips areas that are hidden or empty', () => {
    // The sidebar hidden.
    expect(nextArea('editor', 1, shown('list', 'editor'))).toBe('list')
    expect(nextArea('list', -1, shown('list', 'editor'))).toBe('editor')
    // No note open.
    expect(nextArea('list', 1, shown('sidebar', 'list'))).toBe('sidebar')
  })

  it('has nowhere to go when only the current area shows', () => {
    expect(nextArea('editor', 1, shown('editor'))).toBeUndefined()
    expect(nextArea(undefined, 1, shown())).toBeUndefined()
  })
})
