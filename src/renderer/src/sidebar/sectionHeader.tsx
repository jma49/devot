import type { ReactNode } from 'react'
import { Chevron } from '../Chevron'
import { format as fill, t } from '../i18n'
import type { CollapsibleSection } from '../sidebarSections'
import type { SidebarView } from './view'

export const sectionHeader = (
  v: SidebarView,
  section: CollapsibleSection,
  headingId: string,
  label: string,
  listId: string,
  tools: ReactNode,
  topLevelDrop = false,
) => {
  const { folded, sectionToggles, toggleSection } = v.folds
  const { dropAt, onDragOver, onDragLeave, onDrop } = v.drops
  const isFolded = folded.has(section)
  return (
    <div
      className={`section-header${topLevelDrop && dropAt && dropAt.id === null ? ' drop-target' : ''}`}
      onDragEnter={topLevelDrop ? (e) => onDragOver(e, null) : undefined}
      onDragOver={topLevelDrop ? (e) => onDragOver(e, null) : undefined}
      onDragLeave={topLevelDrop ? (e) => onDragLeave(e, null) : undefined}
      onDrop={topLevelDrop ? (e) => onDrop(e, null) : undefined}
    >
      <span id={headingId}>{label}</span>
      <span className="section-tools">
        {tools}
        <button
          type="button"
          className="tool tool-small section-toggle"
          ref={(el) => {
            if (el) sectionToggles.current.set(section, el)
            else sectionToggles.current.delete(section)
          }}
          aria-label={fill(t(isFolded ? 'sidebar.expandSection' : 'sidebar.collapseSection'), {
            section: label,
          })}
          aria-expanded={!isFolded}
          aria-controls={isFolded ? undefined : listId}
          onClick={() => toggleSection(section)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && isFolded) {
              e.preventDefault()
              toggleSection(section, true)
            } else if (e.key === 'ArrowLeft' && !isFolded) {
              e.preventDefault()
              toggleSection(section, false)
            }
          }}
        >
          <Chevron open={!isFolded} closed="up" />
        </button>
      </span>
    </div>
  )
}
