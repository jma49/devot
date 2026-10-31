import { useEffect, useRef, useState } from 'react'
import type { BookNode } from '../../core/books'
import {
  aiAccessChanges,
  checkedNotebooks,
  notebooksInOrder,
  type AiAccessChange,
} from './aiAccess'
import { BookIcon } from './BookIcon'
import { countOf } from './format'
import { currentLocale, t } from './i18n'

/**
 * Turns Allow AI Access on or off for several notebooks at once. Each
 * notebook is independent: checking a parent does not check its
 * sub-notebooks, and only the notebooks that differ from their current
 * switch are applied. Escape or Cancel closes it without a change.
 */
export function AiAccessDialog(props: {
  tree: readonly BookNode[]
  counts: ReadonlyMap<string, number>
  onApply: (changes: readonly AiAccessChange[]) => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [checked, setChecked] = useState(() => checkedNotebooks(props.tree))
  // The notebooks load after the core is ready: start again from what allows
  // access now rather than apply a selection made against an empty tree.
  const [listed, setListed] = useState(props.tree)
  if (props.tree !== listed) {
    setListed(props.tree)
    setChecked(checkedNotebooks(props.tree))
  }
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const rows = notebooksInOrder(props.tree)
  const changes = aiAccessChanges(props.tree, checked)
  const allChecked = rows.every((node) => checked.has(node.id))
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <dialog
      ref={dialog}
      className="sheet ai-access"
      aria-labelledby="ai-access-title"
      aria-describedby="ai-access-detail"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="ai-access-title" className="sheet-title">
        {t('aiAccess.title')}
      </h2>
      <p id="ai-access-detail" className="sheet-detail">
        {t('aiAccess.detail')}
      </p>
      <div className="ai-access-tools">
        <button
          type="button"
          className="button"
          onClick={() => setChecked(new Set(rows.map((node) => node.id)))}
          disabled={allChecked}
        >
          {t('aiAccess.all')}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setChecked(new Set())}
          disabled={checked.size === 0}
        >
          {t('aiAccess.none')}
        </button>
      </div>
      <ul className="pick-list" aria-label={t('sidebar.notebooks')}>
        {rows.map((node) => (
          <li key={node.id} className="pick-row">
            <label
              className="ai-access-label"
              style={{ paddingInlineStart: `calc(${node.depth} * var(--space-7))` }}
            >
              <input
                type="checkbox"
                checked={checked.has(node.id)}
                onChange={() => toggle(node.id)}
              />
              <BookIcon icon={node.icon} color={node.iconColor} size="sm" />
              <span className="ai-access-name" dir="auto">
                {node.name}
              </span>
              <span className="ai-access-count">
                {countOf(
                  props.counts.get(node.id) ?? 0,
                  currentLocale(),
                  'aiAccess.notesOne',
                  'aiAccess.notesOther',
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button"
          disabled={changes.length === 0}
          onClick={() => props.onApply(changes)}
        >
          {t('aiAccess.apply')}
        </button>
      </div>
    </dialog>
  )
}
