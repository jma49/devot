import { format, t } from './i18n'
import { countOf } from './format'
import type { RebuildState } from './searchIndex'

/** Shows the search index rebuild: running (no progress to report), done, or failed with its code. */
export function SearchIndexNotice(props: {
  state: RebuildState
  locale: string
  onDismiss: () => void
}) {
  const { state } = props
  const failed = state.phase === 'failed'
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="notice"
      data-devot-part="notice"
      data-devot-search-index={state.phase}
    >
      <span className="notice-text">
        {state.phase === 'running'
          ? t('searchIndex.rebuilding')
          : state.phase === 'done'
            ? countOf(
                state.notes,
                props.locale,
                'searchIndex.rebuiltOne',
                'searchIndex.rebuiltOther',
              )
            : format(t('searchIndex.failed'), { code: state.code })}
      </span>
      {state.phase === 'running' ? null : (
        <button type="button" className="button" onClick={props.onDismiss}>
          {t('notice.dismiss')}
        </button>
      )}
    </div>
  )
}
