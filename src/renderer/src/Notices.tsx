import { useCallback, type ReactNode } from 'react'
import { leaveClosingCopy } from './closing'

let counter = 0

// Each notice leaves its own fading copy, so the kind is unique per notice.
function watchNotices(stack: HTMLElement): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || !node.classList.contains('notice')) continue
        if (node.dataset['closing'] !== undefined) continue
        leaveClosingCopy(node, 'fade', `notice-${counter++}`, {
          parent: stack,
          before: record.nextSibling,
        })
      }
    }
  })
  observer.observe(stack, { childList: true })
  return () => observer.disconnect()
}

/** The stack of notices; always mounted so a notice that goes can fade where it was. */
export function Notices({ children }: { children: ReactNode }) {
  const mount = useCallback((el: HTMLDivElement | null) => (el ? watchNotices(el) : undefined), [])
  return (
    <div className="notices" ref={mount}>
      {children}
    </div>
  )
}
