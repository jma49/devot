import type { ReactNode } from 'react'
import { Activity } from '../Activity'
import type { Core } from '../core-client'
import { t } from '../i18n'
import { ImageViewer, type ViewedImage } from '../ImageViewer'
import { CommandPalette } from '../palette/CommandPalette'
import { commandEntries, sourceEntries } from '../palette/entries'
import type { PaletteEntry } from '../palette/results'
import type { useAppCommands } from './useAppCommands'
import type { usePalette, usePaletteLibrary } from './usePalette'

const NO_LIBRARY = { book: [], tag: [], note: [] }

/** The main window's sheets and dialogs that stack above the notices, in their order. */
export function WindowSheets(props: {
  mirror: ReactNode
  licence: ReactNode
  plugins: ReactNode
  noteActions: ReactNode
  templatePicker: ReactNode
  palette: ReturnType<typeof usePalette>
  paletteLibrary: ReturnType<typeof usePaletteLibrary>
  commands: ReturnType<typeof useAppCommands>
  pluginEntries: (noteOpen: boolean) => PaletteEntry[]
  noteOpen: boolean
  history: ReactNode
  ai: ReactNode
  viewing: ViewedImage | null
  closeViewer: () => void
  aiAccess: ReactNode
  clearAuthorship: ReactNode
  activity: { core: Core | undefined; open: boolean; close: () => void }
  exported: ReactNode
  headerMenus: ReactNode
  savedSearch: ReactNode
  confirm: ReactNode
}) {
  const { palette, commands, activity } = props
  return (
    <>
      {props.mirror}
      {props.licence}
      {props.plugins}
      {props.noteActions}
      {props.templatePicker}
      {palette.paletteOpen ? (
        <CommandPalette
          entries={{
            command: [
              ...commandEntries(commands.commands, t),
              ...props.pluginEntries(props.noteOpen),
            ],
            source: sourceEntries(t),
            outline: palette.paletteOutline,
            line: [],
            ...(props.paletteLibrary ?? NO_LIBRARY),
          }}
          actions={commands.actionsOfEntry}
          initialScope={palette.paletteScope}
          lineCount={commands.commands['edit.goToLine'] ? palette.paletteLines : 0}
          onClose={palette.closePalette}
        />
      ) : null}
      {props.history}
      {props.ai}
      {props.viewing ? <ImageViewer image={props.viewing} onClose={props.closeViewer} /> : null}
      {props.aiAccess}
      {props.clearAuthorship}
      {activity.core && activity.open ? (
        <Activity core={activity.core} onClose={activity.close} />
      ) : null}
      {props.exported}
      {props.headerMenus}
      {props.savedSearch}
      {props.confirm}
    </>
  )
}
