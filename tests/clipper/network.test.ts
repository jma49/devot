import { expect, it } from 'vitest'
import { isLocalHost, mayDownload } from '../../clipper/network'

it.each([
  'http://localhost:3000/a.png',
  'http://app.localhost/a.png',
  'http://127.0.0.1/a.png',
  'http://2130706433/a.png',
  'http://10.1.2.3/a.png',
  'http://172.20.0.1/a.png',
  'http://192.168.1.1/a.png',
  'http://169.254.169.254/latest',
  'http://100.100.1.1/a.png',
  'http://0.0.0.0/a.png',
  'http://[::1]/a.png',
  'http://[fd00::1]/a.png',
  'http://[fe80::1]/a.png',
  'http://[::ffff:192.168.0.1]/a.png',
  'http://nas/a.png',
  'http://printer.local/a.png',
  'http://wiki.corp/a.png',
  'http://router.home.arpa/a.png',
])('treats %s as the local network', (url) => {
  expect(isLocalHost(url)).toBe(true)
})

it.each([
  'https://upload.wikimedia.org/a.png',
  'http://172.32.0.1/a.png',
  'http://192.169.0.1/a.png',
  'http://8.8.8.8/a.png',
  'http://[2001:db8::1]/a.png',
  'http://[::ffff:8.8.8.8]/a.png',
  'not a url',
])('treats %s as the open web', (url) => {
  expect(isLocalHost(url)).toBe(false)
})

it('downloads local images only for a page that is itself local', () => {
  expect(mayDownload('http://192.168.1.1/a.png', 'https://example.org/post')).toBe(false)
  expect(mayDownload('http://127.0.0.1:27484/v1/notes', 'https://example.org/post')).toBe(false)
  expect(mayDownload('http://wiki.corp/a.png', 'http://wiki.corp/page')).toBe(true)
  expect(mayDownload('https://cdn.example.org/a.png', 'http://10.0.0.5/page')).toBe(true)
  expect(mayDownload('https://cdn.example.org/a.png', 'https://example.org/post')).toBe(true)
})
