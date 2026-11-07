// Video links and frames the preview plays inline; Write mode reads the same rule, so it lives apart from the preview's renderers.
export const DIRECT_HOSTS = new Set([
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'player.bilibili.com',
])
const YT_ID = /^[A-Za-z0-9_-]{11}$/

export function parseHttps(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname ? url : null
  } catch {
    return null
  }
}

export function videoEmbedUrl(value: string): string | null {
  const url = parseHttps(value)
  if (!url) return null
  const host = url.hostname.replace(/^(?:www\.|m\.)/, '')
  const path = url.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (host === 'youtube.com' && path[0] === 'watch') id = url.searchParams.get('v') ?? undefined
  if (host === 'youtube.com' && (path[0] === 'shorts' || path[0] === 'embed')) id = path[1]
  if (host === 'youtu.be') id = path[0]
  if (id !== undefined) {
    return YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  }
  if (host === 'vimeo.com' && path.length === 1 && /^\d{1,12}$/.test(path[0] ?? '')) {
    return `https://player.vimeo.com/video/${path[0]}`
  }
  if (host === 'bilibili.com' && path[0] === 'video' && /^BV[0-9A-Za-z]{10}$/.test(path[1] ?? '')) {
    return `https://player.bilibili.com/player.html?bvid=${path[1]}&autoplay=0`
  }
  return null
}
