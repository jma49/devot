import type { EditorCounts } from './editor/counts'
import { formatNumber } from './format'
import { currentLocale, format, t } from './i18n'

/** `12 of 340` for a selection, `340` for the note. */
export function countText(whole: number, selected: number | undefined, locale: string): string {
  const total = formatNumber(whole, locale)
  if (selected === undefined) return total
  return format(t('counts.of'), { part: formatNumber(selected, locale), total })
}

/** Words and characters along the editor's bottom edge (View > Settings > Editing > Word and Character Counts). */
export function CountsFooter(props: { counts: EditorCounts | null }) {
  const { counts } = props
  if (!counts) return null
  const locale = currentLocale()
  const { selection } = counts
  return (
    <p className="editor-counts">
      <span>
        {t('counts.words')} {countText(counts.words, selection?.words, locale)}
      </span>
      <span>
        {t('counts.characters')} {countText(counts.characters, selection?.characters, locale)}
      </span>
    </p>
  )
}
