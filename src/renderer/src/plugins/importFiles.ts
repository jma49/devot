import { effectivePermissions, type InstalledPlugin } from '../../../core/plugins'
import type { Core } from '../core-client'
import { imageName, importableName } from '../dropImport'
import { stopsImport } from './contributions'
import type { PluginHost } from './host'

const MAX_FILES = 20
const MAX_BYTES = 5 * 1024 * 1024
type ImportFile = { name: string; text: string }

export function routeImport(name: string, plugins: readonly InstalledPlugin[]) {
  if (importableName(name)) return { kind: 'builtin' as const }
  if (imageName(name)) return { kind: 'image' as const }
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  for (const plugin of [...plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    if (!plugin.enabled || !effectivePermissions(plugin).has('import')) continue
    const format = plugin.manifest.contributes.importFormats.find((item) =>
      item.extensions.some((ext) => ext.toLowerCase() === extension),
    )
    if (format) return { kind: 'plugin' as const, plugin, format: format.id }
  }
  return { kind: 'unsupported' as const }
}

export async function readPluginFiles(files: readonly File[]): Promise<ImportFile[]> {
  if (files.length > MAX_FILES) throw new Error('E_PLUGIN_IMPORT_TOO_MANY')
  const out: ImportFile[] = []
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
    const bytes = await file.arrayBuffer()
    if (bytes.byteLength > MAX_BYTES) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new Error('E_PLUGIN_IMPORT_NOT_TEXT')
    }
    out.push({ name: file.name, text })
  }
  return out
}

export async function importPluginFiles(
  plugin: InstalledPlugin,
  format: string,
  files: readonly ImportFile[],
  host: Pick<PluginHost, 'convertImport'>,
  core: Pick<Core, 'capture'>,
  destination: string | null,
  allowed: () => boolean,
  failed: (error: unknown) => void,
): Promise<string[]> {
  if (!plugin.enabled || !effectivePermissions(plugin).has('import'))
    throw new Error('E_PLUGIN_PERMISSION_DENIED')
  if (!plugin.manifest.contributes.importFormats.some((item) => item.id === format))
    throw new Error('E_PLUGIN_FORMAT_UNKNOWN')
  if (files.length > MAX_FILES) throw new Error('E_PLUGIN_IMPORT_TOO_MANY')
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.text)
    if (bytes.length > MAX_BYTES) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== file.text)
      throw new Error('E_PLUGIN_IMPORT_NOT_TEXT')
  }
  if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
  const ids: string[] = []
  for (const file of files) {
    try {
      if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
      const note = await host.convertImport(plugin.manifest.id, format, file)
      if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
      ids.push(await core.capture(note.title, note.markdown, destination))
    } catch (error) {
      failed(error)
      if (stopsImport(error) || !allowed()) break
    }
  }
  return ids
}
