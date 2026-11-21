// The `devot` global a plugin's script runs with (ADR 0005), for plugin API version 3.
// Every promise rejects with an Error whose `code` names the refusal, such as E_PLUGIN_PERMISSION_DENIED.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface DevotNote {
  title: string
  markdown: string
}

/** API 3: attachment URLs are `attachment:0`, `attachment:1`, in array order. */
export type DevotConvertedNote = {
  title: string
  tags?: string[]
  createdAt?: number
  updatedAt?: number
  attachments?: { name: string; mime: string; data: string }[]
  diagnostics?: string[]
} & ({ markdown: string; html?: never } | { html: string; markdown?: never })

export interface DevotSelection {
  /** UTF-16 offsets in the note's Markdown; equal at the caret. */
  from: number
  to: number
  text: string
}

export interface DevotNoteSummary {
  id: string
  title: string
  notebook: string | null
  createdAt: number
  updatedAt: number
  /** Tag names. */
  tags: string[]
  status: DevotNoteStatus
  pinned: boolean
}

export type DevotNoteStatus = 'none' | 'active' | 'on_hold' | 'completed' | 'dropped'

export interface DevotStoredNote {
  id: string
  title: string
  notebook: string | null
  markdown: string
  /** The note's front matter as JSON values; empty when it has none or it cannot be read. */
  properties: { [key: string]: JsonValue }
}

export interface DevotNotebook {
  id: string
  name: string
  parent: string | null
}

export interface DevotFile {
  name: string
  text: string
}

export type DevotSettingValue = boolean | string | number

/** The theme an SVG drawing goes on: colours as `#rrggbb` or `#rrggbbaa`. */
export interface DevotDrawingTheme {
  appearance: 'light' | 'dark'
  colors: {
    /** The page behind the drawing. */
    ground: string
    card: string
    hairline: string
    edge: string
    text: string
    label: string
    series1: string
    series2: string
    series3: string
    series4: string
    series5: string
    series6: string
    onSeries: string
    barTask: string
    barActive: string
    barCrit: string
    onBar: string
  }
}

export interface DevotApi {
  /** The plugin API version this Devot speaks. */
  readonly apiVersion: number
  readonly commands: {
    handle(id: string, run: () => unknown): void
  }
  readonly preview: {
    /**
     * Returns the block as Markdown, which Devot sanitizes, or null to leave the block as code.
     * A renderer whose `output` is `svg` (API 2) returns SVG markup instead, drawn for `theme`.
     */
    handle(
      id: string,
      render: (
        source: string,
        theme: DevotDrawingTheme | undefined,
      ) => string | null | Promise<string | null>,
    ): void
    /**
     * For a renderer marked `editable` (API 2): the user chose Edit on its drawing. Show a panel, let them edit, and
     * return the block's new text, or null to leave it; closing the panel leaves it too.
     */
    edit(id: string, edit: (source: string) => string | null | Promise<string | null>): void
  }
  readonly importer: {
    handle(
      id: string,
      convert: (
        file: DevotFile,
      ) =>
        | DevotConvertedNote
        | DevotConvertedNote[]
        | Promise<DevotConvertedNote | DevotConvertedNote[]>,
    ): void
  }
  readonly exporter: {
    handle(id: string, convert: (note: DevotNote) => string | Promise<string>): void
  }
  /** The open note, while a command of the plugin runs or its panel shows. */
  readonly note: {
    /** Needs `note.read`. */
    read(): Promise<DevotNote>
    /** Needs `note.edit`; refused with E_PLUGIN_NOTE_CHANGED when the note is no longer `base`. */
    replace(edit: { base: string; markdown: string }): Promise<void>
    /** Needs `note.read` (API 2). */
    selection(): Promise<DevotSelection>
    /** Needs `note.edit` (API 2): puts `text` in place of the selection, refused once it no longer holds `replacing`. */
    insert(text: string, options?: { replacing?: string }): Promise<void>
  }
  /** Needs `storage` (API 2): the plugin's own values, kept across updates. */
  readonly storage: {
    get(key: string): Promise<JsonValue | null>
    set(key: string, value: JsonValue): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }
  /** Needs `notes.read` (API 2): live notes outside Templates and the Trash, at any time. */
  readonly notes: {
    list(options?: { limit?: number }): Promise<DevotNoteSummary[]>
    search(text: string, options?: { limit?: number }): Promise<DevotNoteSummary[]>
    get(id: string): Promise<DevotStoredNote>
    /** The note the editor shows, as last heard, or null. */
    opened(): string | null
    onOpened(listener: (id: string | null) => void): void
  }
  readonly notebooks: {
    list(): Promise<DevotNotebook[]>
  }
  /** The settings the manifest declares (API 2), with the values the user chose. */
  readonly settings: {
    get(): Promise<Record<string, DevotSettingValue>>
    onChange(listener: () => void): void
  }
  readonly ui: {
    /** Shows the plugin's page in a sheet, while a command of it runs. */
    show(options?: { height?: number }): Promise<void>
    hide(): Promise<void>
    onHidden(listener: () => void): void
  }
}

export type DevotPermission =
  | 'note.read'
  | 'note.edit'
  | 'commands'
  | 'menus'
  | 'keymaps'
  | 'preview'
  | 'import'
  | 'export'
  | 'storage'
  | 'notes.read'
  | 'themes'

/** A theme file (API 2): colors by token, each named as its CSS variable after `--color-`, as `#rrggbb` or `#rrggbbaa`. Icon, tag, status, destructive and button tokens (`status-*`, `icon-tile-*`, `tag-*`, `phone-status-tile-*`, `phone-action-*`, `*destructive*`, `accent-fill`, `accent-hover`, `accent-on-fill`, `focus-ring`, `switch-handle`, `phone-on-action`) are not applied: they keep Devot's colors. A text or selection color with less contrast than Devot's own is raised to it, keeping its hue. */
export interface DevotThemeFile {
  colors: Record<string, string>
}

interface SettingBase {
  id: string
  title: string
  description?: string
}

export type DevotSetting =
  | (SettingBase & { type: 'toggle'; default?: boolean })
  | (SettingBase & { type: 'text'; default?: string })
  | (SettingBase & { type: 'number'; default?: number; min?: number; max?: number })
  | (SettingBase & { type: 'choice'; default?: string; choices: { id: string; title: string }[] })

/** `devot-plugin.json`. */
export interface DevotManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  minAppVersion?: string
  description?: string
  author?: string
  main: string
  permissions?: DevotPermission[]
  contributes?: {
    commands?: { id: string; title: string }[]
    menus?: { command: string }[]
    slashMenu?: { command: string }[]
    keymaps?: { command: string; key: string }[]
    previewRenderers?: {
      id: string
      language: string
      output?: 'markdown' | 'svg'
      /** Only with `output: 'svg'`: the drawing offers Edit, which calls `devot.preview.edit`. */
      editable?: boolean
    }[]
    importFormats?: { id: string; title: string; extensions: string[]; maxFileBytes?: number }[]
    exportFormats?: { id: string; title: string; extension: string }[]
    settings?: DevotSetting[]
    /** Needs `themes` (API 2): colors drawn over the theme chosen for that appearance in Settings > Appearance. */
    themes?: { id: string; title: string; appearance: 'light' | 'dark'; path: string }[]
  }
}

declare global {
  const devot: DevotApi
}
