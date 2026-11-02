import { describe, expect, it } from 'vitest'
import {
  enteringPanes,
  paneEnterFrames,
  paneAnimations,
  paneMoves,
  paneTiming,
  riderMoves,
  shownPanes,
} from './paneMotion'

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

  it('leaves a pane that stays hidden to the fade it has under way', () => {
    expect(
      paneMoves(
        { sidebar: { left: 0, shown: false, opacity: 0.5 }, list: box(0), content: box(300) },
        { sidebar: box(0, false), list: box(0, false), content: box(0) },
      ).sidebar,
    ).toBeUndefined()
  })

  it('brings back a pane still fading out from where it is seen, not from its new place', () => {
    const fading = { left: 0, shown: false, opacity: 0.5, shift: 200 }
    expect(paneMoves({ list: fading }, { list: box(0) }).list).toEqual({ kind: 'fade-in', dx: 200 })
    expect(paneMoves({ list: { ...fading, opacity: 0 } }, { list: box(0) }).list).toEqual({
      kind: 'fade-in',
    })
  })

  it('leaves a pane alone that did not move or was not there', () => {
    expect(paneMoves({ list: box(0) }, { list: box(0), content: box(300) })).toEqual({})
  })
})

describe('the frames of a move', () => {
  it('slides from the old place, added to a slide under way, and not under Reduce Motion', () => {
    expect(paneAnimations({ kind: 'slide', dx: -200 }, false)).toEqual([
      {
        frames: [{ transform: 'translateX(-200px)' }, { transform: 'translateX(0px)' }],
        add: true,
        fade: false,
      },
    ])
    expect(paneAnimations({ kind: 'slide', dx: -200 }, true)).toEqual([])
  })

  it('fades a going pane out in sight, held where it was by a move added to its slide', () => {
    expect(paneAnimations({ kind: 'fade-out', dx: 200 }, false)).toEqual([
      {
        frames: [
          { opacity: 1, visibility: 'visible' },
          { opacity: 0, visibility: 'visible' },
        ],
        add: false,
        fade: true,
      },
      {
        frames: [{ transform: 'translateX(200px)' }, { transform: 'translateX(200px)' }],
        add: true,
        fade: true,
      },
    ])
    expect(paneAnimations({ kind: 'fade-out', dx: 0 }, false)).toHaveLength(1)
    expect(paneAnimations({ kind: 'fade-in' }, false)).toEqual([
      { frames: [{ opacity: 0 }, { opacity: 1 }], add: false, fade: true },
    ])
  })

  it('turns a fade cut short back from how opaque the pane is seen', () => {
    expect(paneAnimations({ kind: 'fade-in' }, false, 0.4)[0]?.frames).toEqual([
      { opacity: 0.4 },
      { opacity: 1 },
    ])
    expect(paneAnimations({ kind: 'fade-out', dx: 0 }, false, 0.6)[0]?.frames[0]).toMatchObject({
      opacity: 0.6,
    })
  })

  it('brings a pane still fading out back from where it is seen', () => {
    expect(paneAnimations({ kind: 'fade-in', dx: 120 }, false, 0.5)[1]).toEqual({
      frames: [{ transform: 'translateX(120px)' }, { transform: 'translateX(0px)' }],
      add: true,
      fade: false,
    })
  })

  it('shows every change at once under Reduce Motion', () => {
    expect(paneAnimations({ kind: 'fade-out', dx: 200 }, true)).toEqual([])
    expect(paneAnimations({ kind: 'fade-in' }, true)).toEqual([])
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

describe('the note column that focus mode centres', () => {
  it('slides by its own move, less what the item it sits in carries', () => {
    const panes = {}
    const editor = {}
    const title = {}
    const outer = (item: object) => (item === editor ? panes : undefined)
    expect(
      riderMoves(
        new Map([
          [panes, 0],
          [editor, 70],
          [title, 24],
        ]),
        new Map([
          [panes, 350],
          [editor, 350],
          [title, 374],
        ]),
        outer,
      ),
    ).toEqual(
      new Map([
        [panes, -350],
        [editor, 70],
        [title, -350],
      ]),
    )
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

describe('paneEnterFrames', () => {
  it('brings a pane in from its own side', () => {
    expect(paneEnterFrames('preview')[0]?.['transform']).toBe('translateX(40px)')
    expect(paneEnterFrames('editor')[0]?.['transform']).toBe('translateX(-40px)')
  })
})

describe('enteringPanes', () => {
  it('names only the panes the new mode adds', () => {
    expect(enteringPanes('edit', 'split')).toEqual(['preview'])
    expect(enteringPanes('preview', 'split')).toEqual(['editor'])
    expect(enteringPanes('edit', 'preview')).toEqual(['preview'])
    expect(enteringPanes('split', 'edit')).toEqual([])
    expect(enteringPanes('edit', 'edit')).toEqual([])
  })
})
