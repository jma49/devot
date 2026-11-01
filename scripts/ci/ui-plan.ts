import { appendFileSync, existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Project = 'webkit' | 'webkit-prod-csp'
interface UiJob {
  project: Project
  shard: number
  shards: number
  files: string[]
  partitioned?: true
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

export function planUi(
  changed: string[],
  available: string[],
  forceFull = false,
  durations: Record<string, number> = {},
) {
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
    const shards = Math.min(8, Math.ceil(matching.length / 6))
    const measured = matching
      .map((file) => durations[file])
      .filter((ms): ms is number => ms !== undefined && ms > 0)
    const fallback = measured.length ? Math.max(...measured) : 1
    const cost = (file: string) => durations[file] || fallback
    const groups = Array.from({ length: shards }, () => ({ files: [] as string[], duration: 0 }))
    const ordered = [...matching].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))
    for (const file of ordered) {
      const group = groups.reduce((lightest, candidate) =>
        candidate.duration < lightest.duration ? candidate : lightest,
      )
      group.files.push(file)
      group.duration += cost(file)
    }
    for (const [index, group] of groups.entries()) {
      include.push({
        project,
        shard: index + 1,
        shards,
        files: group.files.sort(),
        ...(shards > 1 ? { partitioned: true as const } : {}),
      })
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
  const baseline = new URL('./ui-durations.json', import.meta.url)
  const durations = existsSync(baseline)
    ? (JSON.parse(readFileSync(baseline, 'utf8')) as Record<string, number>)
    : {}
  const plan = planUi(changed, available, process.argv.includes('--full'), durations)
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
        '| Project | Shard | Specs | Recorded work (s) | Unmeasured specs |',
        '| --- | --- | --- | --- | --- |',
        ...plan.matrix.include.map(
          (job) =>
            `| ${job.project} | ${job.shard}/${job.shards} | ${job.files.length} | ${(job.files.reduce((ms, file) => ms + (durations[file] ?? 0), 0) / 1000).toFixed(1)} | ${job.files.filter((file) => !durations[file]).length} |`,
        ),
        '',
        ...plan.files.map((file) => `- \`${file}\``),
        '',
      ].join('\n'),
    )
  }
}
