import { appendFileSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Project = 'webkit' | 'webkit-prod-csp'
interface UiJob {
  project: Project
  shard: number
  shards: number
  files: string[]
}

const projects: [Project, string][] = [
  ['webkit', 'tests/ui/'],
  ['webkit-prod-csp', 'tests/ui-csp/'],
]

const features: { sources: string[]; specs: string[] }[] = [
  {
    sources: ['src/renderer/src/tipPlacement.ts'],
    specs: [
      'tests/ui/tooltips.spec.ts',
      'tests/ui/keyboard-shortcuts.spec.ts',
      'tests/ui/format-toolbar.spec.ts',
      'tests/ui/tables.spec.ts',
      'tests/ui/images.spec.ts',
      'tests/ui/links.spec.ts',
      'tests/ui-csp/csp.spec.ts',
    ],
  },
  {
    sources: ['src/renderer/src/updates.ts', 'src/renderer/src/UpdateNotice.tsx'],
    specs: ['tests/ui/updates.spec.ts', 'tests/ui/settings.spec.ts', 'tests/ui-csp/csp.spec.ts'],
  },
  {
    sources: [
      'src/renderer/src/find/FindBar.tsx',
      'src/renderer/src/find/keys.ts',
      'src/renderer/src/find/target.ts',
      'src/renderer/src/find/useFind.tsx',
    ],
    specs: [
      'tests/ui/find.spec.ts',
      'tests/ui/bar-motion.spec.ts',
      'tests/ui/ime.spec.ts',
      'tests/ui/palette.spec.ts',
      'tests/ui/trial.spec.ts',
      'tests/ui-csp/csp.spec.ts',
    ],
  },
  {
    sources: [
      'src/renderer/src/preview/mermaid.ts',
      'src/renderer/src/preview/mermaid-protocol.ts',
      'src/renderer/src/mermaid-frame.ts',
      'src/renderer/src/mermaid-frame.css',
      'src/renderer/mermaid.html',
    ],
    specs: [
      'tests/ui/preview.spec.ts',
      'tests/ui/export.spec.ts',
      'tests/ui/restore.spec.ts',
      'tests/ui/scroll-sync.spec.ts',
      'tests/ui/code-copy.spec.ts',
      'tests/ui/welcome.spec.ts',
      'tests/ui-csp/csp.spec.ts',
    ],
  },
]

export function planUi(changed: string[], available: string[], forceFull = false) {
  const specs = [...new Set(available)].sort()
  const selected = new Set<string>()
  let full = forceFull || !changed.some(Boolean)
  for (const file of changed) {
    if (!file) continue
    const project = projects.find(([, prefix]) => file.startsWith(prefix))
    if (project) {
      if (!file.endsWith('.spec.ts')) {
        full = true
      } else if (specs.includes(file)) {
        selected.add(file)
      } else {
        for (const spec of specs) if (spec.startsWith(project[1])) selected.add(spec)
      }
      continue
    }
    const feature = features.find(({ sources }) => sources.includes(file))
    if (feature) {
      if (feature.specs.some((spec) => !specs.includes(spec))) full = true
      for (const spec of feature.specs) selected.add(spec)
      continue
    }
    if (
      file.startsWith('tests/support/') ||
      file === 'src-tauri/tauri.conf.json' ||
      file.startsWith('src-tauri/plugin-frame/')
    ) {
      full = true
      continue
    }
    if (
      /\.(?:bench\.)?test\.[cm]?[jt]sx?$/.test(file) ||
      file.startsWith('docs/') ||
      (!file.startsWith('src/') && file.endsWith('.md')) ||
      file.startsWith('design/app-icon/') ||
      file.startsWith('relay/') ||
      file.startsWith('licence/') ||
      file.startsWith('src/mcp/') ||
      file.startsWith('src-tauri/') ||
      file.startsWith('tests/')
    )
      continue
    full = true
  }
  const files = full ? specs : [...selected].sort()
  const include: UiJob[] = []
  for (const [project, prefix] of projects) {
    const matching = files.filter((file) => file.startsWith(prefix))
    if (!matching.length) continue
    const shards = Math.min(4, Math.ceil(matching.length / 12))
    for (let shard = 1; shard <= shards; shard++) {
      include.push({ project, shard, shards, files: matching })
    }
  }
  const mode = full ? 'full' : files.length ? 'targeted' : 'none'
  // GitHub validates the matrix even when the job is skipped.
  if (!include.length) include.push({ project: 'webkit', shard: 1, shards: 1, files: [] })
  return { mode, files, matrix: { include } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean)
  const available = globSync(['tests/ui/**/*.spec.ts', 'tests/ui-csp/**/*.spec.ts'])
  const plan = planUi(changed, available, process.argv.includes('--full'))
  if (!available.length) throw new Error('E_UI_SPECS_MISSING')
  console.log(`ui=${plan.mode !== 'none'}`)
  console.log(`ui_matrix=${JSON.stringify(plan.matrix)}`)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) {
    appendFileSync(
      summary,
      [
        '### UI test selection',
        '',
        `Mode: **${plan.mode}**; selected **${plan.files.length}/${available.length}** spec files.`,
        '',
        ...plan.files.map((file) => `- \`${file}\``),
        '',
      ].join('\n'),
    )
  }
}
