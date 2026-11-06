import { describe, expect, it } from 'vitest'
import { withoutRemoteCss } from './diagram-css'

describe('diagram CSS', () => {
  it('keeps ordinary rules and same-document references', () => {
    const css =
      '#d .node rect{fill:#fff;stroke:#000;marker-end:url(#arrow)}#d .edge{marker-start:url( "#start" )}@keyframes dash{to{stroke-dashoffset:0}}'
    expect(withoutRemoteCss(css)).toBe(css)
  })

  it('drops only the declarations that point elsewhere', () => {
    expect(
      withoutRemoteCss('#x{fill:red;background:url(https://tracker.example/id);stroke:blue}'),
    ).toBe('#x{fill:red;stroke:blue}')
    expect(withoutRemoteCss('fill: red; background-image: URL( "//t.example/a" )')).toBe(
      'fill: red;',
    )
    expect(withoutRemoteCss("cursor:url('a.png'),auto;fill:red")).toBe('fill:red')
  })

  it('reads escapes, other image functions and imports as the browser does', () => {
    expect(withoutRemoteCss('a{b:\\75 rl(https://t.example);fill:red}')).toBe('a{fill:red}')
    expect(withoutRemoteCss('a{b:\\75rl(/**/#x)}')).toBe('a{}')
    expect(withoutRemoteCss('a{b:-webkit-image-set("https://t.example/a" 1x)}')).toBe('a{}')
    expect(withoutRemoteCss('a{b:image("https://t.example/a")}')).toBe('a{}')
    expect(withoutRemoteCss('@import "https://t.example/a.css";a{fill:red}')).toBe('a{fill:red}')
    expect(withoutRemoteCss('@\\69mport url(x.css);a{fill:red}')).toBe('a{fill:red}')
  })

  it('does not split inside strings, parentheses or comments', () => {
    expect(withoutRemoteCss('a{content:";}";fill:red}')).toBe('a{content:";}";fill:red}')
    expect(withoutRemoteCss('a{b:url(x;y);fill:red}')).toBe('a{fill:red}')
    expect(withoutRemoteCss('a{/* ; } */fill:red}')).toBe('a{/* ; } */fill:red}')
  })

  it('drops a whole block whose prelude points elsewhere, nested rules and all', () => {
    expect(
      withoutRemoteCss(
        '@font-face{font-family:x;src:url(https://t.example/f.woff)}@media (min-width:1px){a{fill:red;b:url(http://t.example)}}',
      ),
    ).toBe('@font-face{font-family:x;}@media (min-width:1px){a{fill:red;}}')
    expect(
      withoutRemoteCss('@supports (background:url(https://t.example)){a{fill:red}}b{c:d}'),
    ).toBe('b{c:d}')
  })
})
