// The note editor's completion popups and the editing aids around them, in
// one place: the slash menu, the fence language list, the emoji and alert
// completions (each a source here), the code block boxes, the ghost hints,
// and the popup look they share. Each row shows what its source recorded in
// popupLook.ts before its label (an icon, an alert's coloured icon, an
// emoji). The `[[` note popup (linkCompletion.ts) shares the look.
import { autocompletion, currentCompletions, type Completion } from '@codemirror/autocomplete'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { iconElement } from '../icons/Icon'
import { codeBlocks, languageSource } from './codeBlocks'
import { chooseTemplate, editorHints } from './hints'
import { alertSource, emojiSource } from './inlineCompletions'
import { closingStyles, closingTooltips, fadeIn, motionKeyframes } from './motion'
import { unlessChoosing } from './pasteChooser'
import { lookOf } from './popupLook'
import { chooseImageFiles, slashMenu, slashSource, slashTrigger } from './slashMenu'

const ICON_BOX = 16

function rowIcon(completion: Completion): Node | null {
  const look = lookOf(completion)
  if (!look) return null
  const box = document.createElement('span')
  box.className = 'cm-popup-icon'
  box.setAttribute('aria-hidden', 'true')
  if (look.tone) box.dataset['tone'] = look.tone
  if (look.glyph !== undefined) box.textContent = look.glyph
  else if (look.icon) box.appendChild(iconElement(look.icon, ICON_BOX))
  else if (look.list === 'language') box.classList.add('cm-popup-ring')
  else return null
  return box
}

function popupClass(state: EditorState): string {
  const [first] = currentCompletions(state)
  const look = first && lookOf(first)
  if (!look) return ''
  // The slash menu is its full width while nothing filters it.
  const full = look.list === 'slash' && slashTrigger(state)?.query === ''
  return `cm-popup-${look.list}${full ? ' cm-popup-full' : ''}`
}

const completionLook = autocompletion({
  icons: false,
  addToOptions: [{ render: rowIcon, position: 20 }],
  tooltipClass: popupClass,
})

const theme = EditorView.theme({
  ...motionKeyframes,
  ...closingStyles,
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '0',
    borderRadius: 'var(--radius-popover)',
    backgroundColor: 'var(--color-surface-popover)',
    boxShadow: '0 0 0 1px var(--color-line-hairline), var(--popover-shadow)',
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    animation: fadeIn,
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-body)',
    minWidth: '0',
    maxHeight: 'var(--size-menu-max-height)',
    padding: 'var(--space-2)',
  },
  '.cm-tooltip.cm-popup-full > ul': { minWidth: 'var(--size-menu-width)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-4)',
    padding: '0 var(--space-4)',
    minHeight: 'var(--size-menu-row)',
    borderRadius: 'var(--radius-button)',
    color: 'var(--color-text-primary)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-fill-completion-selected)',
    color: 'var(--color-text-primary)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    display: 'block',
    margin: 'var(--space-2) 0 var(--space-2)',
    padding: 'var(--space-1) var(--space-4) var(--space-2)',
    borderBottom: '1px solid var(--color-line-control)',
    fontSize: 'var(--font-size-caption)',
    color: 'var(--color-text-secondary)',
    opacity: '1',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section:first-child': { marginTop: '0' },
  '.cm-completionLabel': { flex: '1 1 auto', whiteSpace: 'nowrap' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: 'var(--space-6)',
    fontStyle: 'normal',
    fontFamily: 'var(--font-family-mono)',
    color: 'var(--color-text-tertiary)',
    whiteSpace: 'nowrap',
  },
  // The selected row's fill is lighter than the popover: the hint steps up to
  // secondary so it keeps 4.5:1 there.
  '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': {
    color: 'var(--color-text-secondary)',
  },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--color-accent-text)',
  },
  '.cm-popup-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: 'var(--size-icon-menu)',
    height: 'var(--size-icon-menu)',
    color: 'var(--color-text-secondary)',
  },
  '.cm-popup-icon[data-tone="note"]': { color: 'var(--color-alert-note)' },
  '.cm-popup-icon[data-tone="tip"]': { color: 'var(--color-alert-tip)' },
  '.cm-popup-icon[data-tone="important"]': { color: 'var(--color-alert-important)' },
  '.cm-popup-icon[data-tone="warning"]': { color: 'var(--color-alert-warning)' },
  '.cm-popup-icon[data-tone="caution"]': { color: 'var(--color-alert-caution)' },
  '.cm-popup-icon .icon': {
    display: 'inline-block',
    width: '100%',
    height: '100%',
    backgroundColor: 'currentColor',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
  },
  '.cm-tooltip.cm-popup-language > ul': { fontFamily: 'var(--font-family-mono)' },
  '.cm-tooltip.cm-popup-language > ul > li': {
    minHeight: 'var(--space-7)',
    gap: 'var(--space-3)',
    fontSize: 'var(--font-size-footnote)',
  },
  '.cm-popup-ring': {
    width: 'var(--space-3)',
    height: 'var(--space-3)',
    border: '1px solid var(--color-text-tertiary)',
    borderRadius: 'var(--radius-capsule)',
    boxSizing: 'border-box',
  },
})

/**
 * The popup sources, each offering nothing while the paste chooser's list is
 * open (it stands alone). Wrapped once: CodeMirror keeps a list's result only
 * while its source is the same function, so wrapping on every lookup would
 * drop each open list on the next keystroke.
 */
const popupSources = [slashSource, languageSource, emojiSource, alertSource].map((source) => ({
  autocomplete: unlessChoosing(source),
}))

export interface CompletionHost {
  chooseImageFiles?: (view: EditorView) => void
  chooseTemplate?: () => void
}

export function editorCompletions(host: CompletionHost = {}): Extension {
  return [
    completionLook,
    theme,
    closingTooltips,
    EditorState.languageData.of(() => popupSources),
    slashMenu(),
    codeBlocks(),
    editorHints(),
    host.chooseImageFiles ? chooseImageFiles.of(host.chooseImageFiles) : [],
    host.chooseTemplate ? chooseTemplate.of(host.chooseTemplate) : [],
  ]
}
