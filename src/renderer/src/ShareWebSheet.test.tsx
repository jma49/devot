import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShareWebBody } from './ShareWebSheet'
import type { SharePhase } from './shareWeb'

const noop = () => {}
const render = (phase: SharePhase) =>
  renderToStaticMarkup(
    <ShareWebBody phase={phase} onLifetime={noop} onRun={noop} onCopy={noop} onClose={noop} />,
  )
const shared = {
  url: 'https://share.devot.online/s/abc#key',
  expiresAt: 1_800_000_000_000,
}

describe('the Share on Web sheet body', () => {
  it('offers the lifetimes before a note is shared', () => {
    const html = render({ kind: 'unshared', lifetime: 7, error: null })
    expect(html).toContain('<option value="1">')
    expect(html).toContain('<option value="30">')
    expect(html).toContain('>Share</button>')
    expect(html).not.toContain(shared.url)
  })

  it('shows the link and its actions once shared', () => {
    const html = render({ kind: 'shared', shared, error: null, copied: true })
    expect(html).toContain(`value="${shared.url}"`)
    expect(html).toContain('readOnly=""')
    expect(html).toContain('Stop Sharing')
    expect(html).toContain('Copy Link')
    expect(html).not.toContain('<select')
  })

  it('disables the actions while Rust works, and shows an error as an alert', () => {
    const working = render({
      kind: 'working',
      request: 1,
      task: 'update',
      lifetime: 7,
      shared,
    })
    expect(working).toMatch(/disabled=""[^>]*>Update Page/)
    const failed = render({
      kind: 'unshared',
      lifetime: 7,
      error: 'shareWeb.error.offline',
    })
    expect(failed).toContain('role="alert"')
  })
})
