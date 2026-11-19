import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { t } from '../i18n'

type Connect = (events: HTMLAttributes<HTMLElement>, blocksEditable: boolean) => () => void

const PreviewFrameContext = createContext<Connect | null>(null)

export function PreviewFrameContent({
  children,
  blocksEditable,
  ...events
}: HTMLAttributes<HTMLElement> & { blocksEditable: boolean }) {
  const connect = useContext(PreviewFrameContext)
  useLayoutEffect(() => connect?.(events, blocksEditable))
  return <>{children}</>
}

export function PreviewFrame({ children }: { children: ReactNode }) {
  const pane = useRef<HTMLElement>(null)
  const events = useRef<HTMLAttributes<HTMLElement>>(undefined)
  const editable = useRef(false)
  const [connect] = useState<Connect>(
    () => (next: HTMLAttributes<HTMLElement>, blocksEditable: boolean) => {
      events.current = next
      editable.current = blocksEditable
      pane.current?.toggleAttribute('data-blocks-editable', blocksEditable)
      return () => {
        if (events.current === next) events.current = undefined
      }
    },
  )
  useLayoutEffect(() => {
    pane.current?.toggleAttribute('data-blocks-editable', editable.current)
  }, [])
  return (
    <PreviewFrameContext value={connect}>
      <article
        ref={pane}
        className="preview"
        data-devot-part="preview"
        aria-label={t('preview.label')}
        tabIndex={0}
        onClick={(event) => events.current?.onClick?.(event)}
        onDoubleClick={(event) => events.current?.onDoubleClick?.(event)}
        onContextMenu={(event) => events.current?.onContextMenu?.(event)}
        onCopy={(event) => events.current?.onCopy?.(event)}
        onWheel={(event) => events.current?.onWheel?.(event)}
        onPointerDown={(event) => events.current?.onPointerDown?.(event)}
        onKeyDown={(event) => events.current?.onKeyDown?.(event)}
        onScroll={(event) => events.current?.onScroll?.(event)}
      >
        {children}
      </article>
    </PreviewFrameContext>
  )
}
