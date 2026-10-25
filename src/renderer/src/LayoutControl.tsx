import { t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import type { ListLayout } from './lastState'

const LAYOUTS: { layout: ListLayout; icon: IconName; label: MessageKey; title: MessageKey }[] = [
  { layout: 'list', icon: 'layout.list', label: 'layout.list', title: 'command.showList' },
  { layout: 'board', icon: 'layout.board', label: 'layout.board', title: 'command.showBoard' },
]

export function LayoutControl(props: {
  layout: ListLayout
  onChange: (layout: ListLayout) => void
}) {
  return (
    <div className="segmented layout-control" role="group" aria-label={t('layout.label')}>
      {LAYOUTS.map((l) => (
        <button
          key={l.layout}
          type="button"
          className="segment"
          aria-label={t(l.label)}
          title={t(l.title)}
          aria-pressed={props.layout === l.layout}
          onClick={() => props.onChange(l.layout)}
        >
          <Icon name={l.icon} size="sm" />
        </button>
      ))}
    </div>
  )
}
