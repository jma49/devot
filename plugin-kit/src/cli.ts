// `devot-plugin`: start a plugin, check it by Devot's rules, and pack it for installing (ADR 0024).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { PackageError, readPackage } from './package'
import { templateFiles } from './template'
import { zip } from './zip'

export interface Io {
  cwd: string
  out(line: string): void
  err(line: string): void
}

const USAGE = `Usage:
  devot-plugin new <folder> [--id <id>] [--name <name>]
  devot-plugin validate [folder]
  devot-plugin pack [folder] [--out <file.zip>]`

function options(args: string[]): { rest: string[]; flags: Map<string, string> } {
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const value = args[i + 1]
      if (value === undefined) throw new PackageError('E_KIT_OPTION_VALUE_MISSING', arg)
      flags.set(arg.slice(2), value)
      i += 1
    } else rest.push(arg)
  }
  return { rest, flags }
}

const idFrom = (folder: string) =>
  `com.example.${
    basename(folder)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plugin'
  }`

const titleFrom = (folder: string) =>
  basename(folder)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ') || 'My Plugin'

/** Runs one command; the exit code. */
export function run(args: string[], io: Io): number {
  const [command, ...more] = args
  try {
    const { rest, flags } = options(more)
    const folder = resolve(io.cwd, rest[0] ?? '.')
    switch (command) {
      case 'new': {
        if (rest.length !== 1) break
        if (existsSync(folder) && readdirSync(folder).length > 0) {
          throw new PackageError('E_KIT_FOLDER_NOT_EMPTY', folder)
        }
        mkdirSync(folder, { recursive: true })
        const files = templateFiles(
          flags.get('id') ?? idFrom(folder),
          flags.get('name') ?? titleFrom(folder),
        )
        for (const [name, text] of files) writeFileSync(join(folder, name), text)
        readPackage(folder)
        io.out(`Made ${folder}`)
        return 0
      }
      case 'validate': {
        const { manifest, files } = readPackage(folder)
        io.out(
          `${manifest.id} ${manifest.version}: valid for plugin API ${manifest.apiVersion}, ${files.size} files`,
        )
        io.out(`Permissions: ${manifest.permissions.join(', ') || 'none'}`)
        return 0
      }
      case 'pack': {
        const { manifest, files } = readPackage(folder)
        const out = resolve(io.cwd, flags.get('out') ?? `${manifest.id}-${manifest.version}.zip`)
        writeFileSync(out, zip(files))
        io.out(`Packed ${files.size} files into ${out}`)
        return 0
      }
    }
    io.err(USAGE)
    return 2
  } catch (error) {
    if (!(error instanceof PackageError)) throw error
    io.err(error.message)
    return 1
  }
}
