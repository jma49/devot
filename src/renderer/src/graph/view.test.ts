import { describe, expect, it } from 'vitest'
import { fitCamera, MAX_ZOOM, neighbourhood, noteAt, toScreen, zoomAt } from './view'

const note = (x: number, y: number, links = 0) => ({ id: `${x},${y}`, title: '', x, y, links })

describe('the graph camera', () => {
  it('fits every note inside the canvas, centred, never larger than 1.5', () => {
    const notes = [note(-100, -50), note(100, 50)]
    const camera = fitCamera(notes, 400, 300, 0)
    expect(camera.zoom).toBe(1.5)
    expect(toScreen(camera, note(0, 0))).toEqual({ x: 200, y: 150 })
    const wide = fitCamera([note(-1000, 0), note(1000, 0)], 400, 300, 0)
    expect(toScreen(wide, note(1000, 0)).x).toBeCloseTo(400)
  })

  it('zooms about the pointer, which stays over the same point, within its limits', () => {
    const camera = { zoom: 1, x: 10, y: 20 }
    const zoomed = zoomAt(camera, 2, 110, 120)
    expect(zoomed.zoom).toBe(2)
    expect(toScreen(zoomed, { x: 100, y: 100 })).toEqual({ x: 110, y: 120 })
    expect(zoomAt(camera, 1000, 0, 0).zoom).toBe(MAX_ZOOM)
  })
})

describe('what lies under the pointer', () => {
  it('finds the nearest dot within its radius and a few pixels, or none', () => {
    const notes = [note(0, 0), note(6, 0)]
    const camera = { zoom: 1, x: 0, y: 0 }
    expect(noteAt(notes, camera, 5, 0)).toBe(1)
    expect(noteAt(notes, camera, 1, 1)).toBe(0)
    expect(noteAt(notes, camera, 50, 50)).toBe(-1)
  })

  it("names a note's neighbours, itself included", () => {
    expect(
      [
        ...neighbourhood(
          [
            [0, 1],
            [2, 0],
            [3, 4],
          ],
          0,
        ),
      ].sort(),
    ).toEqual([0, 1, 2])
  })
})
