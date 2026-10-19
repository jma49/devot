import { useLayoutEffect, useRef, useState } from 'react'
import { MAX_TAG_NAME_CHARS } from '../../core/tags'
import type { TagColor, TagRecord } from '../../core/storage'
import { trimWhitespace } from '../../core/text'
import { t } from './i18n'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'
import { ColorSwatches } from './ColorSwatches'

export function TagSettingsDialog(props: {
  tag: Pick<TagRecord, 'id' | 'name' | 'color'>
  onSave: (change: { name: string; color: TagColor | null }) => void
  onCancel: () => void
}) {
  const { tag } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState<TagColor | null>(tag.color)
  const limit = useNameLimit(name, MAX_TAG_NAME_CHARS, setName)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const clean = trimWhitespace(name)
  const save = () => {
    if (clean === '') return
    props.onSave({ name: clean, color })
  }

  return (
    <dialog
      ref={dialog}
      className="sheet tag-settings"
      aria-labelledby="tag-settings-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="tag-settings-title" className="sheet-title">
        {t('tagSettings.title')}
      </h2>
      <label className="sheet-field">
        <span className="sheet-detail">{t('tag.nameLabel')}</span>
        <input
          className="pick-filter"
          type="text"
          aria-label={t('tag.nameLabel')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={name}
          {...limit}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
        />
      </label>
      <ColorSwatches
        value={color}
        onChange={setColor}
        label={t('tagMenu.color')}
        noneLabel={t('tagColor.none')}
      />
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button button-default"
          disabled={clean === ''}
          onClick={save}
        >
          {t('dialog.save')}
        </button>
      </div>
    </dialog>
  )
}
