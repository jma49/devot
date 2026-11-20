const LOCAL_SUFFIXES = /\.(localhost|local|lan|internal|intranet|corp|home|home\.arpa)$/

function ipv4(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined
  return parts.map(Number)
}

/** Whether a URL's host is loopback, a private or link-local address, or a name only a local network resolves. */
export function isLocalHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    if (address === '::1' || address === '::') return true
    if (/^f[cd]|^fe[89ab]/.test(address)) return true
    const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(address)
    if (!mapped) return false
    const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)]
    host = [high >> 8, high & 255, low >> 8, low & 255].join('.')
  }
  const octets = ipv4(host)
  if (octets) {
    const [a = 0, b = 0] = octets
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  return host === 'localhost' || !host.includes('.') || LOCAL_SUFFIXES.test(host)
}

/** A page on the open web never makes the clipper reach into the local network; a local page may use local images. */
export function mayDownload(image: string, page: string): boolean {
  return !isLocalHost(image) || isLocalHost(page)
}
