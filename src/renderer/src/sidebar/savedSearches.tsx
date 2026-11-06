import { trimWhitespace } from '../../../core/text'
import { MAX_SAVED_SEARCH_NAME_CHARS } from '../../../core/savedSearches'
import { commandMatches, heldCommandKey } from '../commands/registry'
import { DRAG_SEARCH, setSearchDragData } from '../dragData'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { savedSearchShortcut } from '../savedSearchMenu'
import { below, format, searchRow } from './model'
import { NameField } from './NameField'
import { sectionHeader } from './sectionHeader'
import { keepFocusOnMenu } from './useMenus'
import type { SidebarView } from './view'

export function savedSearchesSection(v: SidebarView) {
  const { props } = v
  const { rowElements } = v.elements
  const savedSearches = props.savedSearches ?? []
  const { folded, revealed } = v.folds
  const { searchDrop, setSearchDrop, searchDropAt, canPlaceSearch } = v.drops
  const { editingSearch, setEditingSearch, rowMenuTarget, openSearchMenu, runSearchAction } =
    v.menus
  const { rowProps } = v.keys
  return savedSearches.length > 0 ? (
    <>
      {sectionHeader(
        v,
        'searches',
        'searches-heading',
        t('sidebar.savedSearches'),
        'searches-list',
        null,
      )}
      {folded.has('searches') ? null : (
        <ul
          id="searches-list"
          className="sources saved-searches"
          aria-labelledby="searches-heading"
          ref={revealed('section:searches')}
        >
          {savedSearches.map((search) => {
            const key = searchRow(search.id).key
            const dropClass = searchDrop?.id === search.id ? ` drop-${searchDrop.where}` : ''
            return (
              <li
                key={search.id}
                className={`saved-search-item${dropClass}`}
                data-motion-key={key}
                draggable={canPlaceSearch && editingSearch !== search.id}
                onDragStart={(e) => setSearchDragData(e.dataTransfer, search)}
                onDragEnd={() => setSearchDrop(undefined)}
                onDragEnter={canPlaceSearch ? (e) => searchDropAt(e, search.id) : undefined}
                onDragOver={canPlaceSearch ? (e) => searchDropAt(e, search.id) : undefined}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                  setSearchDrop((at) => (at?.id === search.id ? undefined : at))
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DRAG_SEARCH)
                  const at = searchDrop
                  setSearchDrop(undefined)
                  if (!id || !at || at.id !== search.id) return
                  e.preventDefault()
                  if (id !== search.id) props.onPlaceSavedSearch?.(id, search.id, at.where)
                }}
                onDoubleClick={() => props.readOnly || setEditingSearch(search.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget.firstElementChild) return
                  if (heldCommandKey(e)) return e.preventDefault()
                  if (commandMatches('sidebar.rowMenu', e)) {
                    e.preventDefault()
                    return void openSearchMenu(search.id, below(e.target as Element))
                  }
                  const action = savedSearchShortcut(e)
                  if (!action || props.readOnly) return
                  e.preventDefault()
                  runSearchAction(action, { id: search.id })
                }}
              >
                {editingSearch === search.id ? (
                  <div className="source">
                    <Icon name="search" size="md" />
                    <NameField
                      name={search.name}
                      max={MAX_SAVED_SEARCH_NAME_CHARS}
                      label="savedSearch.nameLabel"
                      onDone={(name, byKey) => {
                        setEditingSearch(undefined)
                        const clean = name === null ? '' : trimWhitespace(name)
                        if (clean && clean !== search.name) {
                          props.onRenameSavedSearch?.(search.id, clean)
                        }
                        if (byKey) {
                          requestAnimationFrame(() => rowElements.current.get(key)?.focus())
                        }
                      }}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    {...rowProps(key)}
                    className={`source filter saved-search${rowMenuTarget === key ? ' menu-target' : ''}`}
                    aria-pressed={props.activeSearch === search.id}
                    onClick={() => props.onRunSavedSearch?.(search.id)}
                    onMouseDown={keepFocusOnMenu}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      void openSearchMenu(search.id, { x: e.clientX, y: e.clientY })
                    }}
                  >
                    <Icon name="search" size="md" />
                    <span className="source-label" dir="auto">
                      {search.name}
                    </span>
                    {search.count === null ? null : (
                      <span className="source-count">{format(search.count)}</span>
                    )}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  ) : null
}
