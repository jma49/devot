import { useLayoutEffect, useRef } from 'react'
import { t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import type { ListLayout } from './lastState'
import { useSegmentSlide } from './segmentSlide'

const LAYOUTS: { layout: ListLayout; icon: IconName; label: MessageKey; title: MessageKey }[] = [
  { layout: 'list', icon: 'layout.list', label: 'layout.list', title: 'command.showList' },
  { layout: 'board', icon: 'layout.board', label: 'layout.board', title: 'command.showBoard' },
]

// A switch mounts a new control, so the thumb's last place outlives the old one.
const lastSegment: { view: string; index: number } = { view: '', index: -1 }

/**
 * The List and Board segments. The list and the board each render their own
 * header, so a switch mounts a new control: `onChange` says whether the
 * pressed segment had the keyboard, and `takesKeyboard` (asked once on mount)
 * whether the new control's pressed segment takes it back.
 */
export function LayoutControl(props: {
  layout: ListLayout
  view: string
  onChange: (layout: ListLayout, keyboard: boolean) => void
  takesKeyboard?: () => boolean
}) {
  const pressed = useRef<HTMLButtonElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const index = LAYOUTS.findIndex((l) => l.layout === props.layout)
  const from = useRef(lastSegment.view === props.view ? lastSegment.index : index)
  useSegmentSlide(group, index, from)
  useLayoutEffect(() => {
    lastSegment.view = props.view
    lastSegment.index = index
  }, [props.view, index])
  const { takesKeyboard } = props
  useLayoutEffect(() => {
    if (takesKeyboard?.()) pressed.current?.focus()
  }, [takesKeyboard])
  return (
    <div
      ref={group}
      className="segmented layout-control"
      role="group"
      aria-label={t('layout.label')}
    >
      {LAYOUTS.map((l) => (
        <button
          key={l.layout}
          ref={props.layout === l.layout ? pressed : undefined}
          type="button"
          className="segment"
          aria-label={t(l.label)}
          title={t(l.title)}
          aria-pressed={props.layout === l.layout}
          onClick={(e) => props.onChange(l.layout, document.activeElement === e.currentTarget)}
        >
          <Icon name={l.icon} size="sm" />
        </button>
      ))}
    </div>
  )
}
