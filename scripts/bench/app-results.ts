// Summarizes the samples of scripts/bench/app.sh into docs/benchmarks/app-results.json.
// usage: node scripts/bench/app-results.ts <samples.tsv> <Devot.app> <out.json>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { summarize } from './stats.ts'

const [samples, app, out] = process.argv.slice(2)
if (!samples || !app || !out)
  throw new Error('usage: app-results.ts <samples.tsv> <Devot.app> <out.json>')

const read = (command: string, argv: string[]) =>
  execFileSync(command, argv, { encoding: 'utf8' }).trim()

const groups: Record<string, number[]> = {}
for (const line of readFileSync(samples, 'utf8').split('\n')) {
  const [metric, value] = line.split('\t')
  if (metric && value !== undefined) (groups[metric] ??= []).push(Number(value))
}

const results = {
  generatedAt: new Date().toISOString(),
  app: {
    version: read('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleShortVersionString']),
    path: app,
  },
  machine: {
    model: read('sysctl', ['-n', 'hw.model']),
    cpu: read('sysctl', ['-n', 'machdep.cpu.brand_string']),
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    os: `macOS ${read('sw_vers', ['-productVersion'])} (Darwin ${release()}, ${arch()})`,
  },
  samples: Object.fromEntries(
    Object.entries(groups).map(([key, values]) => [key, summarize(values)]),
  ),
}
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`)
console.log(`wrote ${out}`)
