import { useCallback, type ComponentPropsWithoutRef, type ReactNode, type Ref } from 'react'
import { leaveClosingCopy } from './closing'
import { t, type MessageKey } from './i18n'

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

export interface NoticeProps extends Omit<ComponentPropsWithoutRef<'div'>, 'role'> {
  role?: 'alert' | 'status'
  text: ReactNode
  dismissLabel?: MessageKey
  onDismiss?: (() => void) | undefined
  ref?: Ref<HTMLDivElement>
}

export function Notice({
  role = 'alert',
  text,
  dismissLabel = 'notice.dismiss',
  onDismiss,
  className,
  children,
  ref,
  ...rest
}: NoticeProps) {
  return (
    <div
      {...rest}
      ref={ref}
      role={role}
      className={className ? `notice ${className}` : 'notice'}
      data-devot-part="notice"
    >
      <span className="notice-text">{text}</span>
      {children}
      {onDismiss ? (
        <button type="button" className="button" onClick={onDismiss}>
          {t(dismissLabel)}
        </button>
      ) : null}
    </div>
  )
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
