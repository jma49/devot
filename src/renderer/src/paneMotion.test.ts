import { describe, expect, it } from 'vitest'
import { paneFrames, paneMoves, paneTiming, riderMoves, shownPanes } from './paneMotion'

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
      { transform: 'translateX(0px)' },
    ])
    expect(paneFrames({ kind: 'slide', dx: -200 }, true)).toBeNull()
  })

  it('fades a going pane out in sight, where it was, and a coming one in', () => {
    expect(paneFrames({ kind: 'fade-out', dx: 200 }, false)).toEqual([
      { opacity: 1, visibility: 'visible', transform: 'translateX(200px)' },
      { opacity: 0, visibility: 'visible', transform: 'translateX(200px)' },
    ])
    expect(paneFrames({ kind: 'fade-in' }, false)).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })

  it('turns a fade cut short back from how opaque the pane is seen', () => {
    expect(paneFrames({ kind: 'fade-in' }, false, 0.4)).toEqual([{ opacity: 0.4 }, { opacity: 1 }])
    expect(paneFrames({ kind: 'fade-out', dx: 0 }, false, 0.6)?.[0]).toMatchObject({ opacity: 0.6 })
  })

  it('shows every change at once under Reduce Motion', () => {
    expect(paneFrames({ kind: 'fade-out', dx: 200 }, true)).toBeNull()
    expect(paneFrames({ kind: 'fade-in' }, true)).toBeNull()
  })

  it('takes 380 ms on the move curve', () => {
    expect(paneTiming()).toEqual({ duration: 380, easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)' })
  })
})

describe('toolbar items making room for the window controls', () => {
  it('slide by how far they moved within their pane', () => {
    const toggle = {}
    const title = {}
    const gone = {}
    expect(
      riderMoves(
        new Map([
          [toggle, 4],
          [title, 50],
          [gone, 90],
        ]),
        new Map([
          [toggle, 74],
          [title, 50.4],
        ]),
      ),
    ).toEqual(new Map([[toggle, -70]]))
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
