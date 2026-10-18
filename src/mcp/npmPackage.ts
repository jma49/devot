// devot-mcp as an npm package: `pnpm mcp:build` writes its manifest and
// README beside the bundle, so `dist-mcp/` is the package as it would be
// published (`npm publish` there). Not published yet: Settings > Integrations
// runs devot-mcp from a checkout.
import { SERVER_VERSION } from './version'

/** The fields of Devot's own package.json the manifest takes. */
export interface RootPackage {
  license: string
  repository: { type: string; url: string }
  engines: { node: string }
  dependencies: Record<string, string>
}

export const BUNDLE_FILE = 'devot-mcp.mjs'

/** The package.json of the devot-mcp package. */
export function npmManifest(root: RootPackage): Record<string, unknown> {
  const driver = root.dependencies['better-sqlite3']
  if (!driver) throw new Error('E_MCP_PACKAGE_DRIVER_MISSING')
  return {
    name: 'devot-mcp',
    version: SERVER_VERSION,
    description:
      'Devot notes for MCP clients: search, read, create and edit notes in notebooks that allow AI access.',
    license: root.license,
    repository: { ...root.repository, directory: 'src/mcp' },
    type: 'module',
    bin: { 'devot-mcp': BUNDLE_FILE },
    files: [BUNDLE_FILE, 'README.md', 'LICENSE'],
    // Devot is a macOS app; its database is only there.
    os: ['darwin'],
    engines: root.engines,
    // The one module the bundle leaves out: a native module built per Node version.
    dependencies: { 'better-sqlite3': driver },
  }
}

/** The package's README. */
export function npmReadme(): string {
  return `# devot-mcp

Devot's notes for MCP clients (Claude Code, Codex and others), over stdio. It reads and writes
Devot's database directly, whether Devot is open or not, and sees only notebooks with
Allow AI Access on.

    devot-mcp [--db <path to devot.sqlite>]

Tools: list_notebooks, search_notes, read_note, list_tags, create_note, update_note,
trash_note, create_notebook. Devot keeps the text from before each edit in the note's
history, and trash_note only moves a note to the Trash.

Open Devot once before using it, so the database exists and is up to date. Settings >
Integrations in Devot shows ready-made configs.
`
}
