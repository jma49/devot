import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { TAG_COLORS, type TagColorValue } from '../../core/storage'
import { isCustomTagColor } from '../../core/tags'
import { closingRef } from './closing'
import { ColorPicker } from './ColorPicker'
import { CustomSwatch } from './ColorSwatches'
import { commandKeys } from './commands/registry'
import { shortcutLabel } from './commands/keys'
import { shownGroups, type MenuPoint } from './contextMenu'
import { t, type MessageKey } from './i18n'
import { Icon } from './icons/Icon'
import { isImeKey } from './ime'
import { editingAllowed } from './licence'
import { TagDot } from './TagEditor'
import { TAG_COMMANDS, TAG_MENU, tagShortcut, type TagAction, type TagMenuTarget } from './tagMenu'

const menuRef = closingRef('scale', 'tag-menu')
const ITEM = '[role^="menuitem"]'
const SWATCH = '.tag-menu-swatch'

function moveWithin(menu: HTMLElement, key: string): boolean {
  const here = document.activeElement as HTMLElement | null
  const onSwatch = here?.matches(SWATCH) ?? false
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && onSwatch && here) {
    const swatches = [...menu.querySelectorAll<HTMLElement>(SWATCH)]
    const at = swatches.indexOf(here) + (key === 'ArrowRight' ? 1 : -1)
    swatches[(at + swatches.length) % swatches.length]?.focus()
    return true
  }
  // Up and Down treat the swatches as one row, entered at the colour the tag has.
  const rows = [...menu.querySelectorAll<HTMLElement>(ITEM)].filter(
    (el) => !el.matches(SWATCH) || el.getAttribute('aria-checked') === 'true' || el === here,
  )
  const swatchRow = rows.filter((el) => el.matches(SWATCH))
  const single = swatchRow.includes(here!) ? here : swatchRow[0]
  const stops = rows.filter((el) => !el.matches(SWATCH) || el === single)
  const at = here ? stops.indexOf(here) : -1
  const next =
    key === 'ArrowDown'
      ? stops[at < 0 ? 0 : (at + 1) % stops.length]
      : key === 'ArrowUp'
        ? stops[at <= 0 ? stops.length - 1 : at - 1]
        : key === 'Home'
          ? stops[0]
          : key === 'End'
            ? stops.at(-1)
            : undefined
  if (!next) return false
  next.focus()
  return true
}

/** The tag menu of our own, for what a native menu cannot draw: one row of colour swatches. */
export function TagMenu(props: {
  tag: TagMenuTarget & { name: string }
  at: MenuPoint
  onAction: (action: TagAction) => void
  onColor: (color: TagColorValue | null) => void
  onClose: () => void
}) {
  const { tag, onClose } = props
  const panel = useRef<HTMLDivElement>(null)
  const returnTo = useRef<Element | null>(document.activeElement)
  const [picking, setPicking] = useState(false)
  const close = (giveBack: boolean) => {
    onClose()
    if (giveBack && returnTo.current instanceof HTMLElement) returnTo.current.focus()
  }
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })

  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    const css = getComputedStyle(el)
    const margin = Number.parseFloat(css.getPropertyValue('--size-popover-margin')) || 8
    const box = el.getBoundingClientRect()
    el.style.left = `${Math.max(margin, Math.min(props.at.x, innerWidth - box.width - margin))}px`
    el.style.top = `${Math.max(margin, Math.min(props.at.y, innerHeight - box.height - margin))}px`
  }, [props.at, picking])

  useEffect(() => {
    const el = panel.current
    if (picking) el?.querySelector<HTMLElement>('[role="slider"]')?.focus()
    else el?.querySelector<HTMLElement>(ITEM)?.focus()
  }, [picking])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return
      closeRef.current(false)
    }
    const gone = () => closeRef.current(false)
    document.addEventListener('mousedown', away, true)
    window.addEventListener('resize', gone)
    window.addEventListener('blur', gone)
    return () => {
      document.removeEventListener('mousedown', away, true)
      window.removeEventListener('resize', gone)
      window.removeEventListener('blur', gone)
    }
  }, [])

  const run = (action: TagAction) => {
    close(action !== 'settings' && action !== 'delete')
    props.onAction(action)
  }
  const color = (value: TagColorValue | null) => {
    close(true)
    props.onColor(value)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A bare key here must not reach the window's commands.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
    if (picking || isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      return close(true)
    }
    if (panel.current && moveWithin(panel.current, e.key)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // The focused button's own click does the work, and the sidebar must not see the key.
      e.stopPropagation()
      return
    }
    const action = tagShortcut(e.nativeEvent)
    if (action && shown.some((entry) => entry.action === action)) {
      e.preventDefault()
      e.stopPropagation()
      run(action)
    }
  }
  const groups = shownGroups(TAG_MENU, tag)
  const shown = groups.flat()
  const custom = isCustomTagColor(tag.color) ? tag.color : null

  const swatches = editingAllowed() ? (
    <div className="tag-menu-swatches" role="group" aria-label={t('tagMenu.color')}>
      {[null, ...TAG_COLORS].map((option) => {
        const name = option === null ? t('tagColor.none') : t(`tagColor.${option}`)
        const checked = option === tag.color
        return (
          <button
            key={option ?? 'none'}
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            className="tag-swatch tag-menu-swatch"
            aria-checked={checked}
            aria-label={name}
            title={name}
            onClick={() => color(option)}
          >
            {option === null ? (
              <span className="tag-swatch-none" aria-hidden="true" />
            ) : (
              <TagDot color={option} />
            )}
          </button>
        )
      })}
      <button
        type="button"
        role="menuitemradio"
        tabIndex={-1}
        className="tag-swatch tag-menu-swatch"
        aria-checked={custom !== null}
        aria-haspopup="dialog"
        aria-label={t('tagColor.customPick')}
        title={t('tagColor.customPick')}
        onClick={() => setPicking(true)}
      >
        <CustomSwatch color={custom} />
      </button>
    </div>
  ) : null

  return createPortal(
    <div
      ref={(el) => {
        panel.current = el
        menuRef(el)
      }}
      className="picker-popover tag-menu"
      role={picking ? 'dialog' : 'menu'}
      aria-label={t(picking ? ('tagColor.customPick' as MessageKey) : 'tagMenu.label')}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {picking ? (
        <ColorPicker
          value={custom}
          tagName={tag.name}
          onDone={(hex) => color(hex)}
          onCancel={() => setPicking(false)}
        />
      ) : (
        groups.map((group, i) => (
          <div key={group[0]!.action} role="none">
            {i > 0 ? <div className="tag-menu-separator" role="separator" /> : null}
            {group.map((entry) => {
              const checked = entry.checked?.(tag)
              const key = commandKeys(TAG_COMMANDS[entry.action])[0]
              return (
                <button
                  key={entry.action}
                  type="button"
                  tabIndex={-1}
                  className="picker-option tag-menu-item"
                  role={entry.checked ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={entry.checked ? (checked ?? false) : undefined}
                  onMouseMove={(e) => e.currentTarget.focus()}
                  onClick={() => run(entry.action)}
                >
                  <span className="tag-menu-check" aria-hidden="true">
                    {checked ? <Icon name="check" size="sm" /> : null}
                  </span>
                  <span className="picker-name">{t(entry.label as MessageKey)}</span>
                  {key ? <kbd className="picker-key">{shortcutLabel(key)}</kbd> : null}
                </button>
              )
            })}
            {i === 0 && swatches ? (
              <>
                <div className="tag-menu-separator" role="separator" />
                {swatches}
              </>
            ) : null}
          </div>
        ))
      )}
    </div>,
    document.body,
  )
}
