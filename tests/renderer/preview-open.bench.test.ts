// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createPieceRenderer, type PreviewPiece } from '../../src/core'
import { buildFirstPieces, patchPieces } from '../../src/renderer/src/preview/dom'
import { sampleNote } from '../../scripts/bench/fixtures'
import { skipIfOverloaded } from '../support/budget'
import { fourfoldGrowth, GROWTH_TIMEOUT } from '../support/growth'
import { labels } from '../support/preview-html'

// Opening a note in Split or Preview built its whole preview in one task (about 0.7 s for a
// 250 KB note in the app, seconds at 1 MB and more): now the first pieces are built at once and
// the rest in slices after it, so what the opening task builds does not grow with the note.
const SMALL = 100_000
const MOST = 2

describe('opening a big note in the preview', () => {
  it(
    'builds no more at once for a note four times larger',
    async (context) => {
      const rendered = new Map<number, PreviewPiece[]>()
      for (const bytes of [SMALL, 4 * SMALL]) {
        rendered.set(
          bytes,
          await createPieceRenderer()(sampleNote(bytes), { labels, loadedEmbeds: [] }),
        )
      }
      const growth = fourfoldGrowth((bytes) => {
        const host = document.createElement('div')
        const next = rendered.get(bytes)!
        return () => {
          buildFirstPieces(host, patchPieces(host, [], next, { defer: true }))
        }
      }, SMALL)
      if (growth >= MOST) skipIfOverloaded(context, `grew ${growth.toFixed(1)} times`)
      expect(growth).toBeLessThan(MOST)
    },
    GROWTH_TIMEOUT,
  )
})
