// Tooltips that name a command's key: the key in effect, so they follow the
// user's changes (Settings > Keyboard Shortcuts). Components that show them
// re-render with the keymap (`useKeymap`).
import { format, t, type MessageKey } from '../i18n'
import { shortcutLabel } from './keys'
import { commandKeys, type CommandId } from './registry'

/** `title` with the command's first key in effect, or alone when it has none. */
export function titleWithKey(title: MessageKey, id: CommandId): string {
  const key = commandKeys(id)[0]
  return key === undefined
    ? t(title)
    : format(t('shortcut.titleWithKey'), { title: t(title), key: shortcutLabel(key) })
}

const HEADINGS = [1, 2, 3, 4, 5, 6] as const

/**
 * The Heading button's tooltip: Heading with Option-Command-1 to 6 while the six heading
 * keys are one chord with the digits 1 to 6; otherwise the first heading's
 * key, or none.
 */
export function headingTitle(): string {
  const keys = HEADINGS.map((n) => commandKeys(`format.heading${n}`)[0])
  const first = keys[0]
  const run =
    first?.endsWith('+1') === true &&
    keys.every((key, i) => key === `${first.slice(0, -1)}${i + 1}`)
  return run
    ? format(t('shortcut.titleWithKeyRange'), {
        title: t('format.headingTitle'),
        first: shortcutLabel(first),
        last: String(HEADINGS.length),
      })
    : titleWithKey('format.headingTitle', 'format.heading1')
}
