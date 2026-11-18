import { shortcutLabel } from '../commands/keys'
import { commandKeys, type CommandId } from '../commands/registry'
import { useKeymap } from '../commands/shortcutSettings'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'

interface LauncherAction {
  id: string
  command: CommandId
  label: string
  icon: IconName
  requiresEditing: boolean
  run: () => void
}

/** Calm centered Glass launcher inside `.content` when no note, trash item, multi-selection, or built-in template is active. */
export function EmptyNotePane({
  editing,
  onNewNote,
  onOpenToday,
  onOpenPalette,
  onNewFromTemplate,
}: {
  editing: boolean
  onNewNote: () => void
  onOpenToday: () => void
  onOpenPalette: () => void
  onNewFromTemplate: () => void
}) {
  useKeymap()
  const paneLabel = t('empty.paneLabel')
  const actions: LauncherAction[] = [
    {
      id: 'new-note',
      command: 'note.new',
      label: t('noteList.newNote'),
      icon: 'note.new',
      requiresEditing: true,
      run: onNewNote,
    },
    {
      id: 'open-today',
      command: 'note.today',
      label: t('command.openToday'),
      icon: 'note.today',
      requiresEditing: false,
      run: onOpenToday,
    },
    {
      id: 'command-palette',
      command: 'palette.open',
      label: t('command.palette'),
      icon: 'terminal',
      requiresEditing: false,
      run: onOpenPalette,
    },
    {
      id: 'new-from-template',
      command: 'note.newFromTemplate',
      label: t('command.newFromTemplate'),
      icon: 'templates',
      requiresEditing: true,
      run: onNewFromTemplate,
    },
  ]

  return (
    <section className="empty-pane" aria-label={paneLabel}>
      <p className="empty-pane-hint">{t('empty.paneHint')}</p>
      <div className="empty-pane-card">
        {actions.map((action) => {
          const disabled = action.requiresEditing && !editing
          const key = commandKeys(action.command)[0]
          const shortcut = key ? shortcutLabel(key) : ''
          return (
            <button
              key={action.id}
              type="button"
              className="empty-pane-action"
              data-launcher-action={action.id}
              aria-label={shortcut ? undefined : `${action.label} \u2014 ${paneLabel}`}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) action.run()
              }}
            >
              <span className="empty-pane-action-icon">
                <Icon name={action.icon} size="sm" />
              </span>
              <span className="empty-pane-action-label">{action.label}</span>
              {shortcut ? <kbd className="empty-pane-key">{shortcut}</kbd> : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}
