import { EditorView } from '@codemirror/view'
import { BOX_PAD } from '../boxes'

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
  '.cm-wm-alert-label': { fontWeight: 'var(--font-weight-semibold)' },
  '.cm-wm-note-chip': { textUnderlineOffset: '4px' },
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
})
