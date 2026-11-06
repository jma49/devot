import type { ReactNode } from 'react'
import type { TagColorValue } from '../../../core/storage'
import { MAX_TAG_NAME_CHARS, type NoteFilter } from '../../../core/tags'
import { trimWhitespace } from '../../../core/text'
import { commandMatches, heldCommandKey } from '../commands/registry'
import type { MenuPoint } from '../contextMenu'
import { countOf } from '../format'
import { currentLocale, t } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { tagShortcut } from '../tagMenu'
import { WriterLabel } from '../WriterLabel'
import { agentFilter, below, filterRowOf, format, sameFilter } from './model'
import { NameField, TagGlyph } from './NameField'
import { sectionHeader } from './sectionHeader'
import { keepFocusOnMenu } from './useMenus'
import type { SidebarView } from './view'

export const filterRow = (
  v: SidebarView,
  filter: NoteFilter,
  icon: IconName,
  label: ReactNode,
  count: number,
  extra?: string,
  tag?: { color: TagColorValue | null; onMenu: (at: MenuPoint) => void },
  /** An agent's row counts its unseen changes, and none when there are none. */
  unseen?: boolean,
) => {
  const { props } = v
  const { noteTarget } = v.drops
  const { rowProps } = v.keys
  const { rowMenuTarget, openFilterRowMenu } = v.menus
  const key = filterRowOf(filter).key
  const { onTagNotes, onSetNotesStatus } = props
  const drop = noteTarget(
    key,
    filter.kind === 'status' && onSetNotesStatus
      ? (ids) => onSetNotesStatus(ids, filter.status)
      : filter.kind === 'tag' && onTagNotes
        ? (ids) => onTagNotes(ids, filter.tagId)
        : undefined,
    false,
  )
  return (
    <button
      type="button"
      {...rowProps(key)}
      {...drop.handlers}
      className={`source filter${extra ? ` ${extra}` : ''}${drop.className}${rowMenuTarget === key ? ' menu-target' : ''}`}
      aria-pressed={sameFilter(props.filter, filter)}
      onClick={() => props.onFilter(sameFilter(props.filter, filter) ? null : filter)}
      onMouseDown={keepFocusOnMenu}
      onContextMenu={(e) => {
        e.preventDefault()
        if (tag) tag.onMenu({ x: e.clientX, y: e.clientY })
        else if (filter.kind === 'pinned' || filter.kind === 'status') {
          void openFilterRowMenu(key, filter)
        }
      }}
    >
      {tag ? <TagGlyph color={tag.color} /> : <Icon name={icon} size="md" />}
      <span className="source-label" dir="auto">
        {label}
      </span>
      {unseen && count === 0 ? null : (
        <span className="source-count" aria-hidden={unseen || undefined}>
          {format(count)}
        </span>
      )}
      {unseen && count > 0 ? (
        <span className="visually-hidden">
          {countOf(count, currentLocale(), 'authorship.unseenOne', 'authorship.unseenOther')}
        </span>
      ) : null}
    </button>
  )
}

export function tagsSection(v: SidebarView) {
  const { props } = v
  const ws = props.workspace
  const { folded, revealed } = v.folds
  const { editingTag, setEditingTag, tagMenu, openTagMenu, runTagAction, tagTarget } = v.menus
  return props.tags.length > 0 ? (
    <>
      {sectionHeader(
        v,
        'tags',
        'tags-heading',
        t('sidebar.tags'),
        'tags-list',
        <button
          type="button"
          className="tool tool-small"
          aria-label={t('sidebar.searchTags')}
          title={t('sidebar.searchTags')}
          onClick={props.onSearchTags}
        >
          <Icon name="search" size="sm" />
        </button>,
      )}
      {folded.has('tags') ? null : (
        <ul
          id="tags-list"
          className="sources tags"
          aria-labelledby="tags-heading"
          ref={revealed('section:tags')}
        >
          {props.tags.map((tag) => (
            <li
              key={tag.id}
              data-motion-key={`tag:${tag.id}`}
              onDoubleClick={() => props.readOnly || setEditingTag(tag.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget.firstElementChild) return
                if (heldCommandKey(e)) return e.preventDefault()
                if (commandMatches('sidebar.rowMenu', e)) {
                  e.preventDefault()
                  return openTagMenu(tag, below(e.target as Element))
                }
                const action = tagShortcut(e)
                // A workspace deletes no tag (Backspace there does nothing).
                if (!action || (action === 'delete' && ws)) return
                e.preventDefault()
                runTagAction(action, tagTarget(tag))
              }}
            >
              {editingTag === tag.id ? (
                <div className="source tag-row">
                  <TagGlyph color={tag.color} />
                  <NameField
                    name={tag.name}
                    max={MAX_TAG_NAME_CHARS}
                    label="tag.nameLabel"
                    onDone={(name) => {
                      setEditingTag(undefined)
                      const clean = name === null ? '' : trimWhitespace(name)
                      if (clean && clean !== tag.name) {
                        props.onRenameTag(tag.id, clean)
                      }
                    }}
                  />
                </div>
              ) : (
                filterRow(
                  v,
                  { kind: 'tag', tagId: tag.id },
                  'tag',
                  tag.name,
                  props.tagCounts.get(tag.id) ?? 0,
                  `tag-row${tagMenu?.id === tag.id ? ' menu-target' : ''}`,
                  {
                    color: tag.color,
                    onMenu: (at) => openTagMenu(tag, at),
                  },
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  ) : null
}

export function agentsSection(v: SidebarView) {
  const { props } = v
  const { folded, revealed } = v.folds
  return props.agents && props.agents.length > 0 ? (
    <>
      {sectionHeader(v, 'agents', 'agents-heading', t('sidebar.agents'), 'agents-list', null)}
      {folded.has('agents') ? null : (
        <ul
          id="agents-list"
          className="sources"
          aria-labelledby="agents-heading"
          ref={revealed('section:agents')}
        >
          {props.agents.map((agent) => (
            <li key={agent.key}>
              {filterRow(
                v,
                agentFilter(agent),
                'notebook.ai',
                <WriterLabel writer={agent} />,
                agent.unseen,
                'agent-row',
                undefined,
                true,
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  ) : null
}
