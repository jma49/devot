// Small line icons the preview draws into a note's tree: alert kinds, note
// statuses and a broken link. Devot's own drawings, 24 x 24, stroked in the
// text colour by content.css (`.glyph`), so they follow light and dark and
// show in exported pages too.
import type { Element } from 'hast'

/** A shape: a path, or a dot (a filled circle) at x, y. */
type Shape = { d: string } | { dot: [number, number] }

const GLYPHS = {
  note: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' }, { d: 'M12 11v5.5' }, { dot: [12, 7.6] }],
  tip: [
    { d: 'M9.2 17.5h5.6M10.2 20.5h3.6' },
    {
      d: 'M12 3a6 6 0 0 0-3.6 10.8c.7.6 1 1.3 1 2.1v.6h5.2v-.6c0-.8.3-1.5 1-2.1A6 6 0 0 0 12 3Z',
    },
  ],
  important: [
    {
      d: 'M4 4.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9.5L5 20.5V17H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z',
    },
    { d: 'M12 7.5v4.5' },
    { dot: [12, 14.6] },
  ],
  warning: [
    {
      d: 'M10.3 4.2 2.6 17.8A2 2 0 0 0 4.3 20.8h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z',
    },
    { d: 'M12 9.5v4.5' },
    { dot: [12, 17] },
  ],
  caution: [
    { d: 'M8.3 2.8h7.4l5.5 5.5v7.4l-5.5 5.5H8.3l-5.5-5.5V8.3Z' },
    { d: 'M12 7.5v5.2' },
    { dot: [12, 16.2] },
  ],
  active: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' }, { d: 'M10 8.6v6.8l5.4-3.4Z' }],
  on_hold: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' }, { d: 'M10 9v6M14 9v6' }],
  completed: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' }, { d: 'm8 12.4 2.7 2.7L16 9.6' }],
  dropped: [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' }, { d: 'm9 9 6 6M15 9l-6 6' }],
  'broken-link': [
    { d: 'M9.5 14.5a3.8 3.8 0 0 0 5.4 0l3-3a3.8 3.8 0 0 0-5.4-5.4l-.9.9' },
    { d: 'M14.5 9.5a3.8 3.8 0 0 0-5.4 0l-3 3a3.8 3.8 0 0 0 5.4 5.4l.9-.9' },
    { d: 'M3.5 3.5l17 17' },
  ],
} satisfies Record<string, Shape[]>

export type GlyphName = keyof typeof GLYPHS

/** The icon `name` as an inline SVG element, hidden from screen readers. */
export function glyph(name: GlyphName, className: string): Element {
  const shapes: Shape[] = GLYPHS[name]
  return {
    type: 'element',
    tagName: 'svg',
    properties: {
      className: ['glyph', className],
      viewBox: '0 0 24 24',
      ariaHidden: 'true',
      focusable: 'false',
    },
    children: shapes.map((shape): Element =>
      'd' in shape
        ? {
            type: 'element',
            tagName: 'path',
            properties: { d: shape.d },
            children: [],
          }
        : {
            type: 'element',
            tagName: 'circle',
            properties: {
              className: ['glyph-dot'],
              cx: String(shape.dot[0]),
              cy: String(shape.dot[1]),
              r: '1.2',
            },
            children: [],
          },
    ),
  }
}
