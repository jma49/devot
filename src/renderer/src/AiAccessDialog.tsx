import { useEffect, useRef, useState } from 'react'
import type { BookNode } from '../../core/books'
import { aiAccessChanges, notebooksInOrder, type AiAccessChange } from './aiAccess'
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
  // The draft holds only what the user ticked, applied over each tree, so a
  // reload of the library keeps it and a notebook that is gone drops out.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const rows = notebooksInOrder(props.tree)
  const checked = new Set(
    rows.filter((node) => overrides.get(node.id) ?? node.aiAccess).map((node) => node.id),
  )
  const changes = aiAccessChanges(props.tree, checked)
  const allChecked = rows.every((node) => checked.has(node.id))
  const setAll = (on: boolean) => setOverrides(new Map(rows.map((node) => [node.id, on])))
  const toggle = (node: BookNode) =>
    setOverrides((prev) => new Map(prev).set(node.id, !(prev.get(node.id) ?? node.aiAccess)))

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
        <button type="button" className="button" onClick={() => setAll(true)} disabled={allChecked}>
          {t('aiAccess.all')}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setAll(false)}
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
              <input type="checkbox" checked={checked.has(node.id)} onChange={() => toggle(node)} />
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
