import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('the viewport stops the page from zooming', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')
  const content = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? ''
  expect(content).toContain('maximum-scale=1')
  expect(content).toContain('user-scalable=no')
  expect(content).toContain('viewport-fit=cover')
})

it('the phone root takes pinch and sideways pans away from the page', () => {
  const css = readFileSync('src/renderer/src/phone/phone.css', 'utf8')
  const root = /^\.phone-app \{([^}]*)\}/m.exec(css)?.[1] ?? ''
  expect(root).toContain('touch-action: pan-x pan-y')
  expect(root).toContain('overscroll-behavior-x: none')
  expect(root).toContain('overflow-x: clip')
  expect(css).toMatch(/html:has\(\.phone-app\),\s*body:has\(\.phone-app\) \{[^}]*overflow-x: clip/)
})

it('the phone root blocks the Safari pinch gesture', () => {
  const app = readFileSync('src/renderer/src/phone/PhoneApp.tsx', 'utf8')
  expect(app).toContain("'gesturestart'")
})
