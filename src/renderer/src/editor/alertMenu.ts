// The alert pop-up: a native menu under the toolbar's Alert button that
// picks the kind (Note, Tip, Important, Warning, Caution). The kind the
// selection already has is checked; picking it removes the alert. Each item
// is the registry's `format.alert*` command, named by its kind here.
import type { EditorView } from '@codemirror/view'
import { useCallback } from 'react'
import type { CommandId } from '../commands/registry'
import { commandEntry, useContextMenu, type MenuGroups } from '../contextMenu'
import { ALERT_KINDS, alertKind, type AlertKind } from './blocks'
import { alertFormat, formatCommand } from './formats'

export interface AlertMenuTarget {
  view: EditorView
  kind: AlertKind | null
}

export type ShowAlertMenu = (view: EditorView, anchor: Element) => Promise<void>

export const alertCommand = (kind: AlertKind): CommandId => `format.${alertFormat(kind)}`

export const ALERT_MENU: MenuGroups<AlertKind, AlertMenuTarget> = [
  ALERT_KINDS.map((kind) =>
    commandEntry<AlertKind, AlertMenuTarget>(kind, alertCommand(kind), {
      label: `alert.${kind}`,
      checked: (target) => target.kind === kind,
    }),
  ),
]

export function useAlertMenu(): ShowAlertMenu {
  const pick = useCallback((kind: AlertKind, target: AlertMenuTarget) => {
    formatCommand(alertFormat(kind))(target.view)
  }, [])
  const show = useContextMenu('alert', ALERT_MENU, pick)
  return useCallback(
    (view: EditorView, anchor: Element) => {
      const box = anchor.getBoundingClientRect()
      return show({ view, kind: alertKind(view.state) }, { x: box.left, y: box.bottom })
    },
    [show],
  )
}
