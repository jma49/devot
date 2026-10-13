import { useId, useMemo, useState, type KeyboardEvent } from 'react'
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
import {
  COMMANDS,
  command,
  type CommandGroup,
  type CommandId,
  type CommandScope,
} from '../commands/registry'
import { changeShortcuts, useKeymap, useShortcutOverrides } from '../commands/shortcutSettings'
import { ConfirmDialog } from '../ConfirmDialog'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { isImeKey } from '../ime'

/** Each group's name, in the order the page lists them (every group has one). */
const GROUP_LABELS: Readonly<Record<CommandGroup, MessageKey>> = {
  note: 'shortcuts.group.note',
  notebook: 'shortcuts.group.notebook',
  tag: 'shortcuts.group.tag',
  view: 'shortcuts.group.view',
  search: 'shortcuts.group.search',
  find: 'shortcuts.group.find',
  edit: 'shortcuts.group.edit',
  format: 'shortcuts.group.format',
  table: 'shortcuts.group.table',
  image: 'shortcuts.group.image',
  app: 'shortcuts.group.app',
}

const GROUPS = (Object.entries(GROUP_LABELS) as [CommandGroup, MessageKey][]).map(
  ([group, label]) => ({ group, label }),
)

/** Where a command's keys work, unless that is the whole window. */
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
}

const PROBLEMS: Readonly<Record<KeyProblem, MessageKey>> = {
  invalid: 'shortcuts.problem.invalid',
  reserved: 'shortcuts.problem.reserved',
  navigation: 'shortcuts.problem.navigation',
  editMenu: 'shortcuts.problem.editMenu',
  needsModifier: 'shortcuts.problem.needsModifier',
}

const label = (id: CommandId) => t(command(id).label)

/** A change waiting for the user to agree to take keys from other commands. */
interface Pending {
  id: CommandId
  keys: readonly string[]
  change: KeyChange
}

/**
 * Settings > Keyboard Shortcuts: every command by group with its keys in
 * effect. A command's shortcut is a button: pressed, it records the next key
 * combination (Escape cancels; keys an input method is composing are left
 * to it). A key another command has where both work is taken from it after
 * asking; a key the command may not have is refused with the reason. Clear
 * removes a command's keys, Reset gives it its defaults back, Reset All every
 * command. These buttons are `aria-disabled` rather than `disabled` when there
 * is nothing to do, so the one just used keeps the keyboard (a disabled
 * button would drop it to the page). What happens is announced through a
 * live region.
 */
export function KeyboardSection() {
  const keymap = useKeymap()
  const overrides = useShortcutOverrides()
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [problem, setProblem] = useState<{ id: CommandId; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [resettingAll, setResettingAll] = useState(false)
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

  /** Applies a change, after asking when it takes keys from other commands. */
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
    // Keys an input method is composing are its own.
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

  return (
    <section className="settings-section" aria-labelledby="shortcuts-title">
      <h2 id="shortcuts-title">{t('shortcuts.title')}</h2>
      <p>{t('shortcuts.detail')}</p>
      <p>{t('shortcuts.howTo')}</p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <p role="alert" className="settings-error">
          {format(t('shortcuts.failed'), { code: error })}
        </p>
      ) : null}
      {GROUPS.map(({ group, label: groupLabel }) => (
        <table key={group} className="shortcuts" aria-label={t(groupLabel)}>
          <caption>{t(groupLabel)}</caption>
          <thead className="visually-hidden">
            <tr>
              <th scope="col">{t('shortcuts.commandColumn')}</th>
              <th scope="col">{t('shortcuts.keyColumn')}</th>
              <th scope="col">{t('shortcuts.actionsColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {COMMANDS.filter((c) => c.group === group).map((c) => {
              const keys = keymap.get(c.id) ?? []
              const changed = isCustomized(c.id, overrides)
              const isRecording = recording === c.id
              const scope = c.scope === 'window' ? undefined : SCOPES[c.scope]
              const problemId = `${ids}-${c.id}-problem`
              const rowProblem = problem?.id === c.id ? problem.text : undefined
              return (
                <tr key={c.id} data-command={c.id}>
                  <th scope="row">
                    <span className="shortcut-command">{t(c.label)}</span>
                    {scope ? <span className="settings-hint">{t(scope)}</span> : null}
                    {changed ? (
                      <span className="settings-hint shortcut-changed">
                        {t('shortcuts.changed')}
                      </span>
                    ) : null}
                  </th>
                  <td>
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
                        <span className="shortcut-none">{t('shortcuts.none')}</span>
                      ) : (
                        keys.map((key) => <kbd key={key}>{shortcutLabel(key)}</kbd>)
                      )}
                    </button>
                    {rowProblem ? (
                      <span id={problemId} className="settings-hint settings-error">
                        {rowProblem}
                      </span>
                    ) : null}
                  </td>
                  <td className="shortcut-actions">
                    <button
                      type="button"
                      className="button"
                      aria-label={format(t('shortcuts.clearLabel'), { command: t(c.label) })}
                      aria-disabled={keys.length === 0}
                      onClick={() => {
                        if (keys.length > 0) apply(c.id, { patch: clearKeys(c.id), takes: [] }, [])
                      }}
                    >
                      {t('shortcuts.clear')}
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-label={format(t('shortcuts.resetLabel'), { command: t(c.label) })}
                      aria-disabled={!changed}
                      onClick={() => {
                        if (changed) offer(c.id, c.keys, resetKeys(c.id, keymap))
                      }}
                    >
                      {t('shortcuts.reset')}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ))}
      <div className="settings-actions">
        <button
          type="button"
          className="button"
          aria-disabled={Object.keys(overrides).length === 0}
          onClick={() => {
            if (Object.keys(overrides).length > 0) setResettingAll(true)
          }}
        >
          {t('shortcuts.resetAll')}
        </button>
      </div>
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
