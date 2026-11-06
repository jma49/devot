import { useEffect, useRef, useState } from 'react'
import type { TagColorValue } from '../../../core/storage'
import type { MessageKey } from '../i18n'
import { t } from '../i18n'
import { isImeKey } from '../ime'
import { useNameLimit } from '../nameLimit'
import { tagDotClass } from '../tagColorStyle'
import { TagDot } from '../TagDot'

export function TagGlyph(props: { color: TagColorValue | null }) {
  return (
    <span className="tag-dot-box">
      {props.color ? (
        <TagDot color={props.color} />
      ) : (
        <span className={tagDotClass(null)} aria-hidden="true" />
      )}
    </span>
  )
}

/** A name edited in place, at most `max` code points. `byKey`: ended with Return or Escape (focus goes back to the row), not by focus moving away; one that ends an input method's composition ends only that. */
export function NameField(props: {
  name: string
  max: number
  label?: MessageKey
  onDone: (name: string | null, byKey: boolean) => void
}) {
  const { name, onDone } = props
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const [draft, setDraft] = useState(name)
  const limit = useNameLimit(draft, props.max, setDraft)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (value: string | null, byKey: boolean) => {
    if (done.current) return
    done.current = true
    onDone(value, byKey)
  }
  return (
    <input
      ref={input}
      className="book-name-field"
      aria-label={t(props.label ?? 'book.nameLabel')}
      value={draft}
      {...limit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (isImeKey(e.nativeEvent)) return
        if (e.key === 'Enter') finish(e.currentTarget.value, true)
        if (e.key === 'Escape') finish(null, true)
      }}
      onBlur={(e) => finish(e.currentTarget.value, false)}
    />
  )
}
