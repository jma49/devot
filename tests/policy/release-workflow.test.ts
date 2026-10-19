import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The release workflow runs once per tag, unattended: what went wrong on the
// first signed release (v0.8.0-beta.1) must not come back.
const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`)
  if (start < 0) throw new Error(`E_TEST_NO_STEP ${name}`)
  const next = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, next < 0 ? undefined : next)
}

describe('the release workflow', () => {
  it('uploads only feeds it wrote, never an empty placeholder (GitHub refuses one)', () => {
    const feeds = step('Update the feeds')
    expect(feeds).not.toMatch(/(^|\s): >|touch /m)
    const uploads = [...feeds.matchAll(/gh release upload updater (\S+)/g)].map((m) => m[1])
    expect(uploads.length).toBeGreaterThan(0)
    for (const file of uploads) expect(file).toMatch(/^"feed\//)
  })

  it('can run again after a failure: the release and the feed release may exist', () => {
    const publish = step('Publish the release')
    expect(publish).toMatch(
      /if gh release view "\$TAG"[^\n]*; then\s+gh release upload "\$TAG" out\/\* --clobber/,
    )
    expect(step('Update the feeds')).toMatch(
      /gh release create updater [^|]*\|\| gh release view updater/,
    )
  })

  it('checks the signature against the public key before it publishes anything', () => {
    const verify = workflow.indexOf('release.ts verify-signature')
    expect(verify).toBeGreaterThan(0)
    expect(verify).toBeLessThan(workflow.indexOf('- name: Publish the release'))
  })

  it('keeps the token out of the checkout', () => {
    expect(workflow).toMatch(
      /uses: actions\/checkout@v\d+\n\s+with:\n(\s+#.*\n)*\s+persist-credentials: false/,
    )
  })
})
