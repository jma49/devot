// A plugin's manifest (`devot-plugin.json`, ADR 0005). Rust checks it by the same rules (src-tauri/src/plugins/manifest.rs);
// both run the cases in tests/fixtures/plugins/manifests.json.
import { trimWhitespace } from '../text'

export const PLUGIN_API_VERSION = 1
export const MANIFEST_FILE = 'devot-plugin.json'

export const PLUGIN_PERMISSIONS = [
  'note.read',
  'note.edit',
  'commands',
  'menus',
  'keymaps',
  'preview',
  'import',
  'export',
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export interface PluginCommand {
  id: string
  title: string
}

export interface PluginContributions {
  commands: PluginCommand[]
  menus: { command: string }[]
  keymaps: { command: string; key: string }[]
  previewRenderers: { id: string; language: string }[]
  importFormats: { id: string; title: string; extensions: string[] }[]
  exportFormats: { id: string; title: string; extension: string }[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: typeof PLUGIN_API_VERSION
  description: string
  author: string
  main: string
  permissions: PluginPermission[]
  contributes: PluginContributions
}

/** What the user approved and whether the plugin is on, as Rust lists it (`plugins_list`). */
export interface InstalledPlugin {
  manifest: PluginManifest
  enabled: boolean
  granted: PluginPermission[]
  /** When it was installed (ms), so a plugin installed again starts again. */
  installedAt?: number
}

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const CONTRIBUTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/
const PATH_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const LANGUAGE = /^[a-z0-9][a-z0-9_+#.-]{0,31}$/
const EXTENSION = /^[a-z0-9]{1,10}$/
const KEY = /^(?:(?:Mod|Ctrl|Alt|Shift)\+){1,4}[^\s+]{1,12}$/

export const RESERVED_PLUGIN_FOLDER = '__devot'
/** Built-in renderers draw these (math, the Mermaid island). */
export const RESERVED_LANGUAGES: readonly string[] = ['math', 'mermaid']

const LIMITS = {
  id: 64,
  name: 60,
  description: 300,
  author: 100,
  main: 200,
  depth: 8,
  contributionId: 40,
  commands: 50,
  others: 20,
  extensions: 10,
  key: 40,
} as const

const fail = (code: string): never => {
  throw new Error(code)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const length = (value: string) => [...value].length

/** C0 and C1 controls and the line and paragraph separators. */
const hasControl = (value: string) =>
  [...value].some((c) => {
    const code = c.codePointAt(0)!
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
  })

function requiredText(value: unknown, max: number, code = 'E_PLUGIN_MANIFEST_INVALID'): string {
  if (typeof value !== 'string') return fail(code)
  const trimmed = trimWhitespace(value)
  if (trimmed === '' || trimmed !== value || length(value) > max || hasControl(value)) {
    return fail(code)
  }
  return value
}

function optionalText(value: unknown, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || length(value) > max || hasControl(value)) {
    return fail('E_PLUGIN_MANIFEST_INVALID')
  }
  return value
}

function list(value: unknown, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) return fail('E_PLUGIN_CONTRIBUTION_INVALID')
  return value
}

function entry(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : fail('E_PLUGIN_CONTRIBUTION_INVALID')
}

function contributionId(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= LIMITS.contributionId &&
    CONTRIBUTION_ID.test(value)
    ? value
    : fail('E_PLUGIN_CONTRIBUTION_INVALID')
}

function title(value: unknown): string {
  return requiredText(value, LIMITS.name, 'E_PLUGIN_CONTRIBUTION_INVALID')
}

function unique<T>(items: readonly T[], key: (item: T) => string): void {
  const seen = new Set<string>()
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) fail('E_PLUGIN_CONTRIBUTION_INVALID')
    seen.add(k)
  }
}

export function isPluginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LIMITS.id &&
    ID.test(value) &&
    value !== 'devot' &&
    !value.startsWith('devot.')
  )
}

/** A path inside a package: plain parts, none hidden, `__devot` never first. */
export function isPackagePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > LIMITS.main) return false
  const parts = value.split('/')
  return (
    parts.length <= LIMITS.depth &&
    parts.every((part) => PATH_PART.test(part)) &&
    parts[0] !== RESERVED_PLUGIN_FOLDER
  )
}

function permissions(value: unknown): PluginPermission[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_PERMISSIONS.length) {
    return fail('E_PLUGIN_MANIFEST_INVALID')
  }
  const out: PluginPermission[] = []
  for (const p of value) {
    if (!(PLUGIN_PERMISSIONS as readonly unknown[]).includes(p)) {
      return fail('E_PLUGIN_PERMISSION_UNKNOWN')
    }
    if (out.includes(p as PluginPermission)) return fail('E_PLUGIN_MANIFEST_INVALID')
    out.push(p as PluginPermission)
  }
  return out
}

function contributions(value: unknown, granted: readonly PluginPermission[]): PluginContributions {
  if (value !== undefined && !isRecord(value)) return fail('E_PLUGIN_CONTRIBUTION_INVALID')
  const c = value ?? {}
  const commands = list(c['commands'], LIMITS.commands).map((raw): PluginCommand => {
    const e = entry(raw)
    return { id: contributionId(e['id']), title: title(e['title']) }
  })
  unique(commands, (x) => x.id)
  const known = new Set(commands.map((x) => x.id))
  const command = (raw: unknown) =>
    typeof raw === 'string' && known.has(raw) ? raw : fail('E_PLUGIN_CONTRIBUTION_INVALID')
  const menus = list(c['menus'], LIMITS.commands).map((raw) => ({
    command: command(entry(raw)['command']),
  }))
  unique(menus, (x) => x.command)
  const keymaps = list(c['keymaps'], LIMITS.commands).map((raw) => {
    const e = entry(raw)
    const key = e['key']
    if (typeof key !== 'string' || key.length > LIMITS.key || !KEY.test(key)) {
      return fail('E_PLUGIN_CONTRIBUTION_INVALID')
    }
    return { command: command(e['command']), key }
  })
  unique(keymaps, (x) => x.command)
  const previewRenderers = list(c['previewRenderers'], LIMITS.others).map((raw) => {
    const e = entry(raw)
    const language = e['language']
    if (
      typeof language !== 'string' ||
      !LANGUAGE.test(language) ||
      RESERVED_LANGUAGES.includes(language)
    ) {
      return fail('E_PLUGIN_CONTRIBUTION_INVALID')
    }
    return { id: contributionId(e['id']), language }
  })
  unique(previewRenderers, (x) => x.id)
  unique(previewRenderers, (x) => x.language)
  const extension = (raw: unknown) =>
    typeof raw === 'string' && EXTENSION.test(raw) ? raw : fail('E_PLUGIN_CONTRIBUTION_INVALID')
  const importFormats = list(c['importFormats'], LIMITS.others).map((raw) => {
    const e = entry(raw)
    const extensions = e['extensions']
    if (!Array.isArray(extensions) || extensions.length === 0) {
      return fail('E_PLUGIN_CONTRIBUTION_INVALID')
    }
    const out = list(extensions, LIMITS.extensions).map(extension)
    unique(out, (x) => x)
    return { id: contributionId(e['id']), title: title(e['title']), extensions: out }
  })
  unique(importFormats, (x) => x.id)
  const exportFormats = list(c['exportFormats'], LIMITS.others).map((raw) => {
    const e = entry(raw)
    return {
      id: contributionId(e['id']),
      title: title(e['title']),
      extension: extension(e['extension']),
    }
  })
  unique(exportFormats, (x) => x.id)
  const needs: [unknown[], PluginPermission][] = [
    [commands, 'commands'],
    [menus, 'menus'],
    [menus, 'commands'],
    [keymaps, 'keymaps'],
    [keymaps, 'commands'],
    [previewRenderers, 'preview'],
    [importFormats, 'import'],
    [exportFormats, 'export'],
  ]
  for (const [items, permission] of needs) {
    if (items.length > 0 && !granted.includes(permission)) fail('E_PLUGIN_PERMISSION_MISSING')
  }
  return { commands, menus, keymaps, previewRenderers, importFormats, exportFormats }
}

/** Throws the first rule broken as its code; unknown keys are left out. */
export function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) return fail('E_PLUGIN_MANIFEST_INVALID')
  if (!isPluginId(value['id'])) return fail('E_PLUGIN_ID_INVALID')
  if (value['apiVersion'] !== PLUGIN_API_VERSION) return fail('E_PLUGIN_API_VERSION')
  const version = value['version']
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return fail('E_PLUGIN_MANIFEST_INVALID')
  }
  const main = value['main']
  if (!isPackagePath(main) || !main.endsWith('.js')) return fail('E_PLUGIN_MANIFEST_INVALID')
  const granted = permissions(value['permissions'])
  return {
    id: value['id'],
    name: requiredText(value['name'], LIMITS.name),
    version,
    apiVersion: PLUGIN_API_VERSION,
    description: optionalText(value['description'], LIMITS.description),
    author: optionalText(value['author'], LIMITS.author),
    main,
    permissions: granted,
    contributes: contributions(value['contributes'], granted),
  }
}

/** The permissions in effect: granted by the user and still asked for by the manifest. */
export function effectivePermissions(plugin: InstalledPlugin): Set<PluginPermission> {
  return new Set(plugin.granted.filter((p) => plugin.manifest.permissions.includes(p)))
}
