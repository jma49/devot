import { useContext, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { errorCode } from '../backups'
import { useKeyLayout } from '../commands/dispatch'
import { shortcutLabel } from '../commands/keys'
import {
  assignKey,
  clearKeys,
  isCustomized,
  keyProblem,
  resetAllKeys,
  resetKeys,
  shortcutOfPress,
  type KeyChange,
  type KeyProblem,
} from '../commands/keymap'
import { COMMANDS, command, type CommandId, type CommandScope } from '../commands/registry'
import { changeShortcuts, useKeymap, useShortcutOverrides } from '../commands/shortcutSettings'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../icons/Icon'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { isImeKey } from '../ime'
import { MoreMenu, SettingsSection } from './controls'
import { GROUP_LABELS, groupedShortcuts } from './shortcutSearch'
import { ToolbarEnd } from './toolbar'

const SCOPES: Readonly<Record<Exclude<CommandScope, 'window'>, MessageKey>> = {
  editor: 'shortcuts.scope.editor',
  outsideEditor: 'shortcuts.scope.outsideEditor',
  panes: 'shortcuts.scope.panes',
  sidebar: 'shortcuts.scope.sidebar',
  list: 'shortcuts.scope.list',
  noteList: 'shortcuts.scope.noteList',
  trashList: 'shortcuts.scope.trashList',
  notebookRow: 'shortcuts.scope.notebookRow',
  tagRow: 'shortcuts.scope.tagRow',
  sidebarRow: 'shortcuts.scope.sidebarRow',
}

const PROBLEMS: Readonly<Record<KeyProblem, MessageKey>> = {
  invalid: 'shortcuts.problem.invalid',
  reserved: 'shortcuts.problem.reserved',
  navigation: 'shortcuts.problem.navigation',
  editMenu: 'shortcuts.problem.editMenu',
  needsModifier: 'shortcuts.problem.needsModifier',
}

const label = (id: CommandId) => t(command(id).label)

interface Pending {
  id: CommandId
  keys: readonly string[]
  change: KeyChange
}

/**
 * Settings > Keyboard Shortcuts: every command in a card per group, with its keys in effect in a
 * field on the right. The field is a button: pressed, it records the next key combination (Escape
 * cancels; keys an input method is composing are left to it). A key another command has where both
 * work is taken from it after asking; a key the command may not have is refused with the reason,
 * under the command's name. Left of the field, Reset gives a changed command its defaults back
 * (shown while it is changed), and Copy and Clear show while the row is under the pointer or has the
 * keyboard; Reset All Shortcuts is in the toolbar's More menu. These buttons are `aria-disabled`
 * rather than `disabled` when there is nothing to do, so the one just used keeps the keyboard (a
 * disabled button would drop it to the page). What happens is announced through a live region.
 */
export function KeyboardSection() {
  const keymap = useKeymap()
  const overrides = useShortcutOverrides()
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [problem, setProblem] = useState<{ id: CommandId; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [resettingAll, setResettingAll] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  useKeyLayout()
  const ids = useId()
  const list = useMemo(
    () => new Intl.ListFormat(currentLocale(), { style: 'long', type: 'conjunction' }),
    [],
  )
  const keysText = (keys: readonly string[]) =>
    keys.length === 0 ? t('shortcuts.none') : list.format(keys.map(shortcutLabel))

  const apply = (id: CommandId, change: KeyChange, keys: readonly string[]) => {
    setProblem(null)
    setAnnouncement(format(t('shortcuts.set'), { command: label(id), keys: keysText(keys) }))
    changeShortcuts(change.patch).then(
      () => setError(undefined),
      (e: unknown) => setError(errorCode(e)),
    )
  }

  const offer = (id: CommandId, keys: readonly string[], change: KeyChange) => {
    if (change.takes.length > 0) setPending({ id, keys, change })
    else apply(id, change, keys)
  }

  const recorded = (id: CommandId, key: string) => {
    setRecording(null)
    const why = keyProblem(id, key)
    if (why !== undefined) {
      const text = format(t(PROBLEMS[why]), { key: shortcutLabel(key) })
      setProblem({ id, text })
      setAnnouncement(text)
      return
    }
    offer(id, [key], assignKey(id, key, keymap))
  }

  const cancel = () => {
    setRecording(null)
    setAnnouncement(t('shortcuts.cancelled'))
  }

  const onRecorderKey = (id: CommandId, e: KeyboardEvent<HTMLButtonElement>) => {
    if (recording !== id) return
    if (isImeKey(e.nativeEvent)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.repeat) return
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (e.key === 'Escape' && plain) {
      cancel()
      return
    }
    const key = shortcutOfPress(e)
    // A modifier on its own: wait for the key that goes with it.
    if (key !== undefined) recorded(id, key)
  }

  const groups = groupedShortcuts(COMMANDS, keymap, query)
  const toolbarEnd = useContext(ToolbarEnd)
  const customized = Object.keys(overrides).length > 0

  const copy = (text: string) => {
    const done = () => setAnnouncement(format(t('shortcuts.copied'), { keys: text }))
    // Needs no permission of the page: the click is the user's gesture.
    navigator.clipboard.writeText(text).then(done, () => console.warn('W_SHORTCUT_COPY_FAILED'))
  }

  return (
    <section className="settings-section" aria-labelledby="shortcuts-title">
      <h2 id="shortcuts-title" className="visually-hidden">
        {t('shortcuts.title')}
      </h2>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t('shortcuts.failed'), { code: error })}
        </p>
      ) : null}
      <div className="settings-search shortcuts-filter">
        <Icon name="search" size="sm" />
        <input
          type="search"
          className="settings-search-field"
          aria-label={t('shortcuts.search')}
          placeholder={t('shortcuts.search')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <p>{t('shortcuts.detail')}</p>
      {groups.length === 0 ? <p>{t('shortcuts.noMatch')}</p> : null}
      {groups.map(({ group, commands }) => (
        <SettingsSection key={group} title={GROUP_LABELS[group]}>
          <ul className="shortcut-list">
            {commands.map((c) => {
              const keys = keymap.get(c.id) ?? []
              const changed = isCustomized(c.id, overrides)
              const isRecording = recording === c.id
              const scope = c.scope === 'window' ? undefined : SCOPES[c.scope]
              const problemId = `${ids}-${c.id}-problem`
              const rowProblem = problem?.id === c.id ? problem.text : undefined
              return (
                <li
                  key={c.id}
                  className="setting shortcut-row"
                  data-command={c.id}
                  data-customized={changed || undefined}
                >
                  <div className="setting-text">
                    <span className="setting-label">{t(c.label)}</span>
                    {scope ? <span className="setting-description">{t(scope)}</span> : null}
                    {rowProblem ? (
                      <span id={problemId} className="setting-description settings-error">
                        {rowProblem}
                      </span>
                    ) : null}
                  </div>
                  <div className="shortcut-controls">
                    <button
                      type="button"
                      className="shortcut-action"
                      aria-label={format(t('shortcuts.copy'), { command: t(c.label) })}
                      title={format(t('shortcuts.copy'), { command: t(c.label) })}
                      aria-disabled={keys.length === 0}
                      onClick={() => {
                        if (keys.length > 0) copy(keysText(keys))
                      }}
                    >
                      <Icon name="settings.copy" size="sm" />
                    </button>
                    <button
                      type="button"
                      className="shortcut-action"
                      aria-label={format(t('shortcuts.clearLabel'), { command: t(c.label) })}
                      title={format(t('shortcuts.clearLabel'), { command: t(c.label) })}
                      aria-disabled={keys.length === 0}
                      onClick={() => {
                        if (keys.length > 0) apply(c.id, { patch: clearKeys(c.id), takes: [] }, [])
                      }}
                    >
                      <Icon name="settings.clear" size="sm" />
                    </button>
                    <button
                      type="button"
                      className="shortcut-action shortcut-reset"
                      aria-label={format(t('shortcuts.resetLabel'), { command: t(c.label) })}
                      title={format(t('shortcuts.resetLabel'), { command: t(c.label) })}
                      aria-disabled={!changed}
                      onClick={() => {
                        if (changed) offer(c.id, c.keys, resetKeys(c.id, keymap))
                      }}
                    >
                      <Icon name="settings.reset" size="sm" />
                    </button>
                    <button
                      type="button"
                      className="shortcut-key"
                      aria-label={
                        isRecording
                          ? format(t('shortcuts.recordingLabel'), { command: t(c.label) })
                          : format(t('shortcuts.recorderLabel'), {
                              command: t(c.label),
                              keys: keysText(keys),
                            })
                      }
                      aria-pressed={isRecording}
                      aria-describedby={rowProblem ? problemId : undefined}
                      onClick={(e) => {
                        if (isRecording) {
                          cancel()
                          return
                        }
                        // WebKit does not focus a clicked button; the keys go to it.
                        e.currentTarget.focus()
                        setProblem(null)
                        setRecording(c.id)
                      }}
                      onKeyDown={(e) => onRecorderKey(c.id, e)}
                      onBlur={() => {
                        if (isRecording) cancel()
                      }}
                    >
                      {isRecording ? (
                        t('shortcuts.recording')
                      ) : keys.length === 0 ? (
                        <span className="shortcut-none">{t('shortcuts.record')}</span>
                      ) : (
                        keys.map(shortcutLabel).join('\u2002')
                      )}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </SettingsSection>
      ))}
      {toolbarEnd
        ? createPortal(
            <MoreMenu
              label={t('shortcuts.more')}
              items={[
                {
                  label: t('shortcuts.resetAll'),
                  disabled: !customized,
                  onSelect: () => setResettingAll(true),
                },
              ]}
            />,
            toolbarEnd,
          )
        : null}
      {pending ? (
        <ConfirmDialog
          message={format(t('shortcuts.takeMessage'), {
            keys: list.format(
              pending.keys
                .filter((key) =>
                  pending.change.takes.some((other) => keymap.get(other)?.includes(key)),
                )
                .map(shortcutLabel),
            ),
            others: list.format(pending.change.takes.map(label)),
          })}
          detail={format(t('shortcuts.takeDetail'), {
            command: label(pending.id),
            others: list.format(pending.change.takes.map(label)),
          })}
          confirm={t('shortcuts.takeConfirm')}
          onConfirm={() => {
            setPending(null)
            apply(pending.id, pending.change, pending.keys)
          }}
          onCancel={() => {
            setPending(null)
            setAnnouncement(t('shortcuts.cancelled'))
          }}
        />
      ) : null}
      {resettingAll ? (
        <ConfirmDialog
          message={t('shortcuts.resetAllMessage')}
          detail={t('shortcuts.resetAllDetail')}
          confirm={t('shortcuts.resetAllConfirm')}
          onConfirm={() => {
            setResettingAll(false)
            setProblem(null)
            setAnnouncement(t('shortcuts.resetAllDone'))
            changeShortcuts(resetAllKeys(overrides)).then(
              () => setError(undefined),
              (e: unknown) => setError(errorCode(e)),
            )
          }}
          onCancel={() => setResettingAll(false)}
        />
      ) : null}
    </section>
  )
}
