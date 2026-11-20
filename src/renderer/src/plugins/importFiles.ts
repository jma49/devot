import { effectivePermissions, type InstalledPlugin } from '../../../core/plugins'
import { imageName, importableName } from '../dropImport'
import type { ImportReport } from '../../../core/import'
import type { Converted } from '../../../core/plugins/protocol'
import { importBatch } from './importBatch'
import type { PluginHost } from './host'

const MAX_FILES = 20
const MAX_BYTES = 5 * 1024 * 1024
type ImportFile = { name: string; text: string }

export async function importDroppedFiles(
  files: readonly File[],
  plugins: readonly InstalledPlugin[],
  convert: (
    plugin: string,
    format: string,
    files: ImportFile[],
  ) => Promise<{ ids: string[]; failed: boolean }>,
) {
  const groups = new Map<string, { plugin: InstalledPlugin; format: string; files: File[] }>()
  for (const file of files) {
    const route = routeImport(file.name, plugins)
    if (route.kind !== 'plugin') throw new Error('E_PLUGIN_FORMAT_UNKNOWN')
    const key = `${route.plugin.manifest.id}/${route.format}`
    let group = groups.get(key)
    if (!group) {
      group = { plugin: route.plugin, format: route.format, files: [] }
      groups.set(key, group)
    }
    group.files.push(file)
  }
  const prepared = []
  for (const group of groups.values()) {
    const contribution = group.plugin.manifest.contributes.importFormats.find(
      (item) => item.id === group.format,
    )!
    prepared.push({
      ...group,
      files: await readPluginFiles(group.files, contribution.maxFileBytes),
    })
  }
  const ids: string[] = []
  let failed = false
  for (const group of prepared) {
    try {
      const result = await convert(group.plugin.manifest.id, group.format, group.files)
      ids.push(...result.ids)
      failed ||= result.failed
    } catch {
      failed = true
    }
  }
  return { ids, failed }
}

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

export async function readPluginFiles(
  files: readonly File[],
  maxBytes = MAX_BYTES,
): Promise<ImportFile[]> {
  if (files.length > MAX_FILES) throw new Error('E_PLUGIN_IMPORT_TOO_MANY')
  const out: ImportFile[] = []
  for (const file of files) {
    if (file.size > maxBytes) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
    const bytes = await file.arrayBuffer()
    if (bytes.byteLength > maxBytes) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
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
  core: {
    importConverted: (
      name: string,
      converted: Converted | Converted[],
      destination: string | null,
    ) => Promise<ImportReport>
  },
  destination: string | null,
  allowed: () => boolean,
) {
  if (!plugin.enabled || !effectivePermissions(plugin).has('import'))
    throw new Error('E_PLUGIN_PERMISSION_DENIED')
  const contribution = plugin.manifest.contributes.importFormats.find((item) => item.id === format)
  if (!contribution) throw new Error('E_PLUGIN_FORMAT_UNKNOWN')
  const maxBytes = contribution.maxFileBytes ?? MAX_BYTES
  if (files.length > MAX_FILES) throw new Error('E_PLUGIN_IMPORT_TOO_MANY')
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.text)
    if (bytes.length > maxBytes) throw new Error('E_PLUGIN_IMPORT_TOO_LARGE')
    if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== file.text)
      throw new Error('E_PLUGIN_IMPORT_NOT_TEXT')
  }
  if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
  const ids: string[] = []
  const batch = await importBatch([...files], async (file) => {
    if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
    const converted = await host.convertImport(plugin.manifest.id, format, file)
    if (!allowed()) throw new Error('E_LICENCE_REQUIRED')
    const report = await core.importConverted(file.name, converted, destination)
    ids.push(...Object.values(report.noteIds))
    return report
  })
  return { ...batch, ids }
}
