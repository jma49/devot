/** The site an image from the web comes from (its host, lower case); null for an attachment, data or anything not http(s). */
export function remoteImageHost(src: string): string | null {
  if (!/^https?:\/\//i.test(src)) return null
  try {
    return new URL(src).hostname.toLowerCase() || null
  } catch {
    return null
  }
}
