// A plugin folder read as Devot reads it (src-tauri/src/plugins/package.rs): hidden files and what only development needs left
// out, a link, a name outside the rules or a package over its limits refused whole, the manifest checked by the app's own rules (src/core/plugins/manifest.ts).
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPackagePath, parseManifest, type PluginManifest } from '../../src/core/plugins/manifest'

export const MANIFEST_FILE = 'devot-plugin.json'
export const PACKAGE_LIMITS = {
  files: 256,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  depth: 8,
  manifestBytes: 64 * 1024,
} as const

export interface PluginPackage {
  manifest: PluginManifest
  /** By path in the package, `/` between parts, in name order. */
  files: Map<string, Uint8Array>
}

export class PackageError extends Error {
  constructor(
    readonly code: string,
    readonly path?: string,
  ) {
    super(path ? `${code} ${path}` : code)
  }
}

/** What a plugin's development needs and Devot does not: left out of a packed plugin. */
const DEVELOPMENT_ONLY =
  /^(?:node_modules|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.zip)$/

/** The package the folder at `root` packs into. */
export function readPackage(root: string): PluginPackage {
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new PackageError('E_PLUGIN_PACKAGE_INVALID', root)
  }
  const files = new Map<string, Uint8Array>()
  let total = 0
  const walk = (dir: string, prefix: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      const path = `${prefix}${name}`
      if (name.startsWith('.') || DEVELOPMENT_ONLY.test(path)) continue
      const stat = lstatSync(join(dir, name))
      if (stat.isSymbolicLink()) throw new PackageError('E_PLUGIN_PACKAGE_LINK', path)
      if (stat.isDirectory()) {
        if (depth >= PACKAGE_LIMITS.depth) throw new PackageError('E_PLUGIN_PACKAGE_INVALID', path)
        walk(join(dir, name), `${path}/`, depth + 1)
        continue
      }
      if (!stat.isFile() || !isPackagePath(path)) {
        throw new PackageError('E_PLUGIN_PACKAGE_INVALID', path)
      }
      if (files.size >= PACKAGE_LIMITS.files) throw new PackageError('E_PLUGIN_PACKAGE_TOO_LARGE')
      total += stat.size
      if (stat.size > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes) {
        throw new PackageError('E_PLUGIN_PACKAGE_TOO_LARGE', path)
      }
      files.set(path, readFileSync(join(dir, name)))
    }
  }
  walk(root, '', 1)
  const raw = files.get(MANIFEST_FILE)
  if (!raw) throw new PackageError('E_PLUGIN_MANIFEST_MISSING')
  if (raw.length > PACKAGE_LIMITS.manifestBytes) {
    throw new PackageError('E_PLUGIN_MANIFEST_INVALID', MANIFEST_FILE)
  }
  let manifest: PluginManifest
  try {
    manifest = parseManifest(JSON.parse(new TextDecoder().decode(raw)))
  } catch (error) {
    const code = error instanceof SyntaxError ? 'E_PLUGIN_MANIFEST_INVALID' : codeOf(error)
    throw new PackageError(code, MANIFEST_FILE)
  }
  if (!files.has(manifest.main)) throw new PackageError('E_PLUGIN_MAIN_MISSING', manifest.main)
  return { manifest, files }
}

const codeOf = (error: unknown) =>
  error instanceof Error && /^E_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'E_PLUGIN_MANIFEST_INVALID'
