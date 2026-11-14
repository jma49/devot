import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper for scripts/ci/iphone-ui-tests.sh: reads an .xctestrun converted to JSON on stdin and
// prints the plutil key path of each test target, one a line.
// Format 1, which xcodebuild writes for this runner, keeps each target at the top level beside the
// metadata; format 2 keeps them under TestConfigurations.

type XctestRun = {
  readonly TestConfigurations?: readonly { readonly TestTargets: readonly unknown[] }[]
  readonly [target: string]: unknown
}

export function targetPaths(run: XctestRun): string[] {
  if (run.TestConfigurations) {
    return run.TestConfigurations.flatMap((config, i) =>
      config.TestTargets.map((_, j) => `TestConfigurations.${i}.TestTargets.${j}`),
    )
  }
  return Object.keys(run).filter((key) => key !== '__xctestrun_metadata__')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = targetPaths(JSON.parse(readFileSync(0, 'utf8')) as XctestRun)
  if (paths.length === 0) throw new Error('E_XCTESTRUN_NO_TARGETS')
  console.log(paths.join('\n'))
}
