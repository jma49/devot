import { describe, expect, it } from 'vitest'
import { paneFrames, paneMoves, paneTiming, shownPanes } from './paneMotion'

const box = (left: number, shown = true) => ({ left, shown })

describe('hiding or showing the sidebar', () => {
  it('fades the sidebar out where it was and slides the list and editor left', () => {
    expect(
      paneMoves(
        { sidebar: box(0), list: box(200), content: box(500) },
        { sidebar: box(0, false), list: box(0), content: box(300) },
      ),
    ).toEqual({
      sidebar: { kind: 'fade-out', dx: 0 },
      list: { kind: 'slide', dx: 200 },
      content: { kind: 'slide', dx: 200 },
    })
  })

  it('fades the sidebar in and slides the list and editor right', () => {
    expect(
      paneMoves(
        { sidebar: box(0, false), list: box(0), content: box(300) },
        { sidebar: box(0), list: box(200), content: box(500) },
      ),
    ).toEqual({
      sidebar: { kind: 'fade-in' },
      list: { kind: 'slide', dx: -200 },
      content: { kind: 'slide', dx: -200 },
    })
  })

  it('fades the list out where it was when focus mode starts', () => {
    expect(
      paneMoves(
        { sidebar: box(0, false), list: box(0), content: box(300) },
        { sidebar: box(0, false), list: box(0, false), content: box(0) },
      ),
    ).toEqual({
      list: { kind: 'fade-out', dx: 0 },
      content: { kind: 'slide', dx: 300 },
    })
    expect(
      paneMoves({ list: box(200), content: box(500) }, { list: box(0, false), content: box(0) })
        .list,
    ).toEqual({ kind: 'fade-out', dx: 200 })
  })

  it('leaves a pane alone that did not move or was not there', () => {
    expect(paneMoves({ list: box(0) }, { list: box(0), content: box(300) })).toEqual({})
  })
})

describe('the frames of a move', () => {
  it('slides from the old place, and not under Reduce Motion', () => {
    expect(paneFrames({ kind: 'slide', dx: -200 }, false)).toEqual([
      { transform: 'translateX(-200px)' },
      { transform: 'none' },
    ])
    expect(paneFrames({ kind: 'slide', dx: -200 }, true)).toBeNull()
  })

  it('fades a going pane out in sight, held where it was, under Reduce Motion too', () => {
    expect(paneFrames({ kind: 'fade-out', dx: 200 }, false)).toEqual([
      { opacity: 1, visibility: 'visible', transform: 'translateX(200px)' },
      { opacity: 0, visibility: 'visible', transform: 'translateX(200px)' },
    ])
    expect(paneFrames({ kind: 'fade-out', dx: 200 }, true)).toEqual(
      paneFrames({ kind: 'fade-out', dx: 200 }, false),
    )
    expect(paneFrames({ kind: 'fade-in' }, true)).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })

  it('takes 400 ms on the slide curve', () => {
    expect(paneTiming).toEqual({
      duration: 400,
      easing: 'cubic-bezier(0.4, 0, 0.1, 1)',
    })
  })
})

describe('which panes show', () => {
  it('hides the sidebar for the toggle, and the sidebar and list in focus mode', () => {
    expect(shownPanes({ focus: false, sidebarOff: false })).toEqual({
      sidebar: true,
      list: true,
      content: true,
    })
    expect(shownPanes({ focus: false, sidebarOff: true }).sidebar).toBe(false)
    expect(shownPanes({ focus: true, sidebarOff: false })).toEqual({
      sidebar: false,
      list: false,
      content: true,
    })
  })
})
