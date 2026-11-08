// A copy button on each fenced code block in the preview. It is the page's
// own control, never part of the note's HTML: the core renders no button,
// the patcher leaves it alone (`UI_ATTRIBUTE`), and printing hides it.
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboardText } from '../clipboard'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { UI_ATTRIBUTE, type ShownPiece } from './dom'

const FEEDBACK_MS = 1500

export function codeText(pre: Element): string {
  return (pre.querySelector(':scope > code')?.textContent ?? '').replace(/\n$/, '')
}

const hasText = (pre: Element) => {
  const text = pre.querySelector(':scope > code')?.textContent ?? ''
  return text !== '' && text !== '\n'
}

const CODE_BLOCK = 'pre:not(.frontmatter)'

// Keyed by the node list, which a piece waiting to be built (`buildPending`) gets anew.
const blocksOf = new WeakMap<readonly ChildNode[], HTMLElement[]>()

/**
 * The fenced code blocks of `pieces` that have text to copy (front matter is shown as code, but
 * is not a code block). Runs after every rendering: a piece the page kept is read once.
 */
export function pieceCodeBlocks(pieces: readonly ShownPiece[]): HTMLElement[] {
  return pieces.flatMap((piece) => {
    let blocks = blocksOf.get(piece.nodes)
    if (!blocks) {
      blocks = []
      for (const node of piece.nodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches(CODE_BLOCK)) blocks.push(node)
        blocks.push(...node.querySelectorAll<HTMLElement>(CODE_BLOCK))
      }
      blocks = blocks.filter(hasText)
      blocksOf.set(piece.nodes, blocks)
    }
    return blocks
  })
}

type State = 'idle' | 'copied' | 'failed'

const LABELS = {
  idle: 'preview.copyCode',
  copied: 'preview.codeCopied',
  failed: 'preview.codeCopyFailed',
} as const

const ICONS = { idle: 'code.copy', copied: 'code.copied', failed: 'code.copyFailed' } as const

// Kept from rendering again with the preview: each button's icon reads the appearance.
const CopyButton = memo(function CopyButton({ block }: { block: HTMLElement }) {
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
})

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

function buttonHost(block: HTMLElement): HTMLElement {
  const header = block.parentElement?.matches('.code-block')
    ? block.parentElement.querySelector<HTMLElement>(':scope > .code-header')
    : null
  return header ?? block
}

export function CodeCopyButtons({ blocks }: { blocks: readonly HTMLElement[] }) {
  return blocks.map((block) =>
    createPortal(<CopyButton block={block} />, buttonHost(block), keyOf(block)),
  )
}
