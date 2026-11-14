import { expect, it } from 'vitest'
import { targetPaths } from '../../scripts/ci/xctestrun-targets'

it('finds the test target of a format 1 runner at the top level, beside the metadata', () => {
  expect(
    targetPaths({
      __xctestrun_metadata__: { FormatVersion: 1 },
      DevotUITests: { PreferredScreenCaptureFormat: 'screenRecording', IsUITestBundle: true },
    }),
  ).toEqual(['DevotUITests'])
})

it('finds every test target of a format 2 runner under its configurations', () => {
  expect(
    targetPaths({
      __xctestrun_metadata__: { FormatVersion: 2 },
      TestConfigurations: [{ TestTargets: [{}, {}] }, { TestTargets: [{}] }],
    }),
  ).toEqual([
    'TestConfigurations.0.TestTargets.0',
    'TestConfigurations.0.TestTargets.1',
    'TestConfigurations.1.TestTargets.0',
  ])
})
