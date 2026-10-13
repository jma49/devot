// A copy button on each fenced code block in the preview, and a header with
// the block's language mark and title (or its language) when it names one.
// Both are the page's own, never part of the note's HTML: the core renders
// neither, the patcher leaves them alone (`UI_ATTRIBUTE`), and printing
// hides the button.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboardText } from '../clipboard'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { codeLabel, languageMark, markPath } from './codeLanguages'
import { UI_ATTRIBUTE } from './dom'

/** How long the button shows that it copied (or could not). */
const FEEDBACK_MS = 1500

/** A code block's text as written in the note: no markup, without its last line break. */
export function codeText(pre: Element): string {
  return (pre.querySelector(':scope > code')?.textContent ?? '').replace(/\n$/, '')
}

/**
 * The fenced code blocks in `host` that have text to copy (front matter is
 * shown as code, but is not a code block). Runs after every rendering, so it
 * looks at the text without copying it.
 */
export function codeBlocks(host: Element): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('pre:not(.frontmatter)')).filter((pre) => {
    const text = pre.querySelector(':scope > code')?.textContent ?? ''
    return text !== '' && text !== '\n'
  })
}

type State = 'idle' | 'copied' | 'failed'

const LABELS = {
  idle: 'preview.copyCode',
  copied: 'preview.codeCopied',
  failed: 'preview.codeCopyFailed',
} as const

const ICONS = { idle: 'code.copy', copied: 'code.copied', failed: 'code.copyFailed' } as const

function CopyButton({ block }: { block: HTMLElement }) {
  const [state, setState] = useState<State>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [state])

  const copy = () => {
    const text = codeText(block)
    if (text === '') return
    // Through Rust, which takes any block a note can hold (writeClipboardText).
    writeClipboardText(text).then(
      () => setState('copied'),
      () => {
        console.warn('W_CODE_COPY_FAILED')
        setState('failed')
      },
    )
  }

  const label = t(LABELS[state])
  return (
    <button
      type="button"
      className="code-copy"
      {...{ [UI_ATTRIBUTE]: '' }}
      data-state={state}
      aria-label={label}
      title={label}
      onClick={copy}
    >
      <Icon name={ICONS[state]} size="sm" />
    </button>
  )
}

/** A key per block element, so a block keeps its button while it stays. */
const keys = new WeakMap<HTMLElement, string>()
let nextKey = 0
const keyOf = (block: HTMLElement) => {
  let key = keys.get(block)
  if (key === undefined) {
    key = String((nextKey += 1))
    keys.set(block, key)
  }
  return key
}

const codeOf = (block: HTMLElement) => block.querySelector(':scope > code')

/** Every block's language and title, one line each: changes when a header must. */
export function codeLabels(blocks: readonly HTMLElement[]): string {
  return blocks
    .map((block) => {
      const { language, title } = codeLabel(codeOf(block))
      return `${language}\u0000${title}`
    })
    .join('\n')
}

/**
 * The block's header: the language's mark (a generic code symbol for a
 * language without one) and the title, or the language as the note wrote it.
 */
function CodeHead({ block }: { block: HTMLElement }) {
  const { language, title } = codeLabel(codeOf(block))
  if (language === '' && title === '') return null
  const mark = language === '' ? undefined : languageMark(language)
  return (
    <div className="code-head" {...{ [UI_ATTRIBUTE]: '' }} data-language={language || undefined}>
      {mark ? (
        <svg className="code-mark" viewBox="0 0 24 24" aria-hidden="true" data-mark={mark}>
          <path d={markPath(mark)} />
        </svg>
      ) : (
        <Icon name="format.code" size="sm" />
      )}
      <span className="code-title">{title || language}</span>
    </div>
  )
}

/** A header and a copy button inside each of `blocks`. */
export function CodeCopyButtons({
  blocks,
}: {
  blocks: readonly HTMLElement[]
  /** `codeLabels(blocks)`, so a block whose language or title changed shows it. */
  labels?: string
}) {
  return blocks.map((block) =>
    createPortal(
      <>
        <CodeHead block={block} />
        <CopyButton block={block} />
      </>,
      block,
      keyOf(block),
    ),
  )
}
