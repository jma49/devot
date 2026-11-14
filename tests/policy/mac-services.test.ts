import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PLIST = readFileSync('src-tauri/Info.plist', 'utf8')
const PROVIDER = readFileSync('src-tauri/src/native/macos/services.rs', 'utf8')

function strings(xml: string): string[] {
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? '')
}

function value(key: string): string {
  const after = PLIST.split(`<key>${key}</key>`)
  expect({ key, found: after.length - 1 }).toEqual({ key, found: 1 })
  return after[1] ?? ''
}

describe('the Services menu', () => {
  it('offers one service that sends text and URLs and takes nothing back', () => {
    expect(PLIST.match(/<key>NSMessage<\/key>/g)).toHaveLength(1)
    expect(strings(value('NSMenuItem')).at(0)).toBe('New Devot Note')
    const sent = value('NSSendTypes').split('</array>')[0] ?? ''
    expect(strings(sent)).toEqual(['public.utf8-plain-text', 'public.url'])
    expect(PLIST).not.toContain('<key>NSReturnTypes</key>')
  })

  it('names the app and a message the provider answers', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      productName: string
    }
    expect(strings(value('NSPortName')).at(0)).toBe(config.productName)
    const message = strings(value('NSMessage')).at(0)
    expect(PROVIDER).toContain(`#[unsafe(method(${message}:userData:error:))]`)
  })
})
