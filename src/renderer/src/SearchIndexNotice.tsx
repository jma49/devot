import { t } from './i18n'
import { countOf } from './format'
import type { RebuildState } from './searchIndex'
import { failureText } from './failure'
import { Notice } from './Notices'

export function SearchIndexNotice(props: {
  state: RebuildState
  locale: string
  onDismiss: () => void
}) {
  const { state } = props
  const text =
    state.phase === 'running'
      ? t('searchIndex.rebuilding')
      : state.phase === 'done'
        ? countOf(state.notes, props.locale, 'searchIndex.rebuiltOne', 'searchIndex.rebuiltOther')
        : failureText('searchIndex.failed', state.code)
  return (
    <Notice
      role={state.phase === 'failed' ? 'alert' : 'status'}
      text={text}
      onDismiss={state.phase === 'running' ? undefined : props.onDismiss}
      data-devot-search-index={state.phase}
    />
  )
}
