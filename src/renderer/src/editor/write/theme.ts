import { EditorView } from '@codemirror/view'
import { tags, type Tag } from '@lezer/highlight'
import { noteHighlightStyle } from '../markdown'
import { BOX_INSET, BOX_MARGIN, BOX_PAD } from '../boxes'

const token = (name: string) => `var(--color-${name})`

// A bullet is drawn over its list mark, which keeps its width: the text after
// it stays where it is when the caret comes and the mark shows.
const BULLET_GLYPHS = ['•', '◦', '▪']
const TASK_BOX = '0.875em'

const bullets = Object.fromEntries(
  BULLET_GLYPHS.map((glyph, i) => [
    `&[data-write] .cm-wm-bullet-${i + 1}::after`,
    {
      content: `'${glyph}'`,
      color: token(i % 2 === 0 ? 'syntax-list' : 'syntax-list-alt'),
    },
  ]),
)

const classOf = (tag: Tag) => noteHighlightStyle.style([tag]) ?? 'cm-wm-unstyled'
/** Quoted text is italic in the quote colour; emphasis keeps its slant and links and marks their colour. */
const QUOTE_TEXT = classOf(tags.quote)
const EMPHASIS = classOf(tags.emphasis)
const COLOURED = [tags.link, tags.url, tags.processingInstruction]
  .map((tag) => `:not(.${classOf(tag)})`)
  .join('')
/** Brackets that are no link lose only the link's look: a heading's or quote's colour, a strike and an address stay. */
const PLAIN_LINK = `.cm-wm-plain .${classOf(tags.link)}`

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
  // One line tall from the line's top, so the box centres on the first line and the line keeps its height.
  '.cm-wm-task': {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    height: '1lh',
    verticalAlign: 'top',
    marginInlineEnd: 'var(--space-3)',
  },
  // Drawn, not native, so an open and a done box are one size: outlined open, filled done.
  '.cm-wm-task-box': {
    appearance: 'none',
    // A control's own font would size the box apart from the check, which follows the line's.
    font: 'inherit',
    boxSizing: 'border-box',
    width: TASK_BOX,
    height: TASK_BOX,
    margin: '0',
    border: `1px solid ${token('line-control')}`,
    borderRadius: 'var(--radius-mark)',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  '.cm-wm-task-done .cm-wm-task-box': {
    borderColor: 'transparent',
    backgroundColor: token('accent-fill'),
  },
  '.cm-wm-task-done::after': {
    content: "''",
    position: 'absolute',
    top: '50%',
    left: `calc(${TASK_BOX} / 2)`,
    width: '0.22em',
    height: '0.45em',
    borderStyle: 'solid',
    borderColor: token('accent-on-fill'),
    borderWidth: '0 0.12em 0.12em 0',
    transform: 'translate(-50%, -60%) rotate(45deg)',
    pointerEvents: 'none',
  },
  // On the baseline the 1em buffer image can outgrow a short line box in a fallback font, so a line that hides its marks grows.
  '&[data-write] .cm-widgetBuffer': { verticalAlign: 'text-top' },
  '.cm-wm-alert-label': { fontWeight: 'var(--font-weight-semibold)' },
  // An alert reads as the preview draws it: upright body text, only a plain quote is italic.
  [`&[data-write] .cm-md-alert .${QUOTE_TEXT}:not(.${EMPHASIS})`]: { fontStyle: 'normal' },
  [`&[data-write] .cm-md-alert .${QUOTE_TEXT}${COLOURED}`]: { color: token('text-editor') },
  '.cm-wm-note-chip': { textUnderlineOffset: '4px' },
  [`&[data-write] ${PLAIN_LINK}:not(.${classOf(tags.url)})`]: {
    color: token('text-editor'),
    textDecoration: 'none',
  },
  [`&[data-write] ${PLAIN_LINK}.${classOf(tags.heading)}`]: { color: token('syntax-heading') },
  [`&[data-write] ${PLAIN_LINK}.${QUOTE_TEXT}`]: { color: token('syntax-quote') },
  [`&[data-write] .cm-md-alert ${PLAIN_LINK}.${QUOTE_TEXT}`]: { color: token('text-editor') },
  [`&[data-write] ${PLAIN_LINK}.${classOf(tags.strikethrough)}`]: {
    textDecoration: 'line-through',
  },
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
  '&[data-write] .cm-wm-fence, &[data-write] .cm-wm-fence *': { color: 'transparent' },
  // Where the preview's code header puts its language, at the box's inner right edge.
  '.cm-wm-code-language': {
    position: 'absolute',
    top: '50%',
    right: `calc(${BOX_PAD} + ${BOX_INSET})`,
    transform: 'translateY(-50%)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-caption)',
    lineHeight: '1',
    color: token('text-tertiary'),
    cursor: 'text',
  },
  '.cm-wm-footnote-definition': { marginInlineEnd: 'var(--space-2)' },
  // Drawn as the preview draws them (content.css), but never taller than the line, so showing their source moves no line.
  '.cm-wm-inline': { lineHeight: '0' },
  '.cm-wm-inline kbd': { display: 'inline', lineHeight: '1' },
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
