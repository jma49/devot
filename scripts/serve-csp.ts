// Serves a built UI with the production CSP from tauri.conf.json, so UI
// tests can check what `pnpm dev` (with its relaxed dev CSP) cannot.
// Usage: node scripts/serve-csp.ts <dir> <port>
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const [root = 'dist-test', port = '5175'] = process.argv.slice(2)
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
  app: { security: { csp: Record<string, string> } }
}
const csp = Object.entries(config.app.security.csp)
  .map(([name, value]) => `${name} ${value}`)
  .join('; ')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'))
  let file = join(root, path)
  if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html')
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-security-policy': csp,
  })
  res.end(readFileSync(file))
}).listen(Number(port), () => console.log(`serving ${root} with the production CSP on ${port}`))
