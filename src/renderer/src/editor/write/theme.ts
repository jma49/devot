import { EditorView } from '@codemirror/view'
import { BOX_MARGIN, BOX_PAD } from '../boxes'

const token = (name: string) => `var(--color-${name})`

// A bullet is drawn over its list mark, which keeps its width: the text after
// it stays where it is when the caret comes and the mark shows.
const BULLET_GLYPHS = ['•', '◦', '▪']

const bullets = Object.fromEntries(
  BULLET_GLYPHS.map((glyph, i) => [
    `&[data-write] .cm-wm-bullet-${i + 1}::after`,
    {
      content: `'${glyph}'`,
      color: token(i % 2 === 0 ? 'syntax-list' : 'syntax-list-alt'),
    },
  ]),
)

export const writeTheme = EditorView.theme({
  '&[data-write] .cm-wm-bullet, &[data-write] .cm-wm-bullet *': { color: 'transparent' },
  '&[data-write] .cm-wm-bullet': { position: 'relative' },
  '&[data-write] .cm-wm-bullet::after': {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
  },
  ...bullets,
  // Inside the line box, so a task line is as tall with its box as with its source.
  '.cm-wm-task': {
    display: 'inline-block',
    width: '1em',
    height: '1em',
    margin: '0',
    verticalAlign: '-0.125em',
    accentColor: token('accent-fill'),
    cursor: 'pointer',
  },
  // On the baseline the 1em buffer image can outgrow a short line box in a fallback font, so a line that hides its marks grows.
  '&[data-write] .cm-widgetBuffer': { verticalAlign: 'text-top' },
  '.cm-wm-alert-label': { fontWeight: 'var(--font-weight-semibold)' },
  '.cm-wm-note-chip': { textUnderlineOffset: '4px' },
  // Raised by position, so the line keeps its height with the number as with its source.
  '.cm-wm-footnote': {
    position: 'relative',
    top: '-0.5em',
    fontSize: 'var(--font-size-caption)',
    lineHeight: '0',
    verticalAlign: 'baseline',
    color: token('syntax-link'),
    cursor: 'text',
  },
  '.cm-wm-footnote-definition': { marginInlineEnd: 'var(--space-2)' },
  '.cm-wm-note-title': { color: token('syntax-link'), textDecoration: 'underline' },
  '.cm-wm-note-missing': { color: token('text-tertiary'), textDecoration: 'line-through' },
  '.cm-line.cm-wm-rule': {
    backgroundImage: `linear-gradient(${token('line-hairline')}, ${token('line-hairline')})`,
    backgroundSize: '100% 1px',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundOrigin: 'content-box',
    backgroundClip: 'content-box',
  },
  '.cm-wm-front-matter': {
    paddingInline: BOX_PAD,
    color: token('text-tertiary'),
    cursor: 'pointer',
  },
  '.cm-wm-front-matter-label': { fontWeight: 'var(--font-weight-semibold)' },
  '.cm-wm-front-matter-keys': { marginInlineStart: 'var(--space-3)' },
  // A rendered block sits in the text column, as a code block's box does.
  '.cm-wm-block': {
    marginInline: BOX_PAD,
    paddingBlock: BOX_MARGIN,
    borderRadius: 'var(--radius-card)',
    cursor: 'text',
  },
  '.cm-wm-block-selected': {
    outline: `var(--size-focus-ring) solid ${token('focus-ring')}`,
  },
  '.cm-wm-block img': { cursor: 'zoom-in' },
  '.cm-wm-block img.image-missing': { cursor: 'default' },
})
