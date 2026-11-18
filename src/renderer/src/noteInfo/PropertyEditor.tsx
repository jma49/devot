import { useState, type RefObject } from 'react'
import { frontMatterHead } from '../../../core/frontMatterHead'
import type { EditorHandle } from '../editor/handle'
import { t } from '../i18n'

export function PropertyEditor({
  head,
  editor,
  noteId,
}: {
  head: string
  editor: RefObject<EditorHandle | null>
  noteId: string
}) {
  const [draft, setDraft] = useState<string>()
  if (draft === undefined)
    return (
      <button
        className="button"
        type="button"
        onClick={() => setDraft(head.split('\n').slice(1, -1).join('\n'))}
      >
        {t('noteInfo.editProperties')}
      </button>
    )
  const replacement = `---\n${draft}\n---`
  return (
    <div className="property-editor">
      <textarea
        aria-label={t('noteInfo.properties')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className="button"
        type="button"
        disabled={frontMatterHead(replacement) !== replacement}
        onClick={() => {
          const handle = editor.current
          if (handle?.noteId !== noteId) return
          void handle
            .moveRange(0, head.length, async (current) => (current === head ? replacement : null))
            .then((saved) => {
              if (saved) setDraft(undefined)
            })
        }}
      >
        {t('dialog.save')}
      </button>
      <button className="button" type="button" onClick={() => setDraft(undefined)}>
        {t('dialog.cancel')}
      </button>
    </div>
  )
}
