// @vitest-environment happy-dom
import mermaid from 'mermaid'
import { describe, expect, it } from 'vitest'
import { light, sizes } from '../theme/tokens'
import { diagramPalette, frameSettings } from './mermaid-theme'

const request = {
  type: 'render',
  id: 1,
  source: '',
  appearance: 'light',
  fontFamily: sizes['font.family.ui'],
  fontSize: sizes['font.size.footnote'],
  palette: diagramPalette((token) => light[token]),
} as const

describe("the frame's Mermaid settings", () => {
  it("keep Mermaid's own secure keys and add the ones that carry CSS", () => {
    mermaid.mermaidAPI.reset()
    const defaults = mermaid.mermaidAPI.getSiteConfig().secure ?? []
    expect(defaults.length).toBeGreaterThan(0)
    expect(frameSettings(request).secure).toEqual(
      expect.arrayContaining([
        ...defaults,
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'altFontFamily',
      ]),
    )
  })

  it("keep Devot's theme when a diagram's directive or front matter sets its own", async () => {
    const settings = frameSettings(request)
    mermaid.initialize(settings)
    for (const source of [
      '%%{init: {"themeCSS": "#x{background:url(https://t.example/a)}", "themeVariables": {"primaryColor": "url(https://t.example/b)"}, "fontFamily": "url(https://t.example/c)"}}%%\ngraph LR\n  A --> B',
      '---\nconfig:\n  themeCSS: "#x{background:url(https://t.example/a)}"\n  fontFamily: x\n---\ngraph LR\n  A --> B',
    ]) {
      await mermaid.parse(source)
      const config = mermaid.mermaidAPI.getConfig()
      expect(config.themeCSS).toBe(settings.themeCSS)
      expect(config.fontFamily).toBe(settings.fontFamily)
      expect(JSON.stringify(config.themeVariables)).not.toContain('t.example')
    }
  })
})
