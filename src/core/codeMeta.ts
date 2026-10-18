// Fenced code blocks carry metadata in their info string:
//   ```ts line=10-20 commit=a1b2c3d url="https://github.com/o/r/blob/main/a.ts#L10-L20"
// The preview reads it to number lines and name the source; the paste
// chooser writes it. Both use the tokenizer and the GitHub parser here.

/** A fence info string split into its first word and its `key=value` pairs. */
export interface FenceInfo {
  /** The first word: the language, with an optional `:title` suffix. */
  head: string
  /** The pairs, keys lower-cased; the first of a repeated key wins. */
  meta: ReadonlyMap<string, string>
}

const PAIR = /([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/y
const WORD = /\S+/y

/**
 * Splits a fence info string: `ts line=5 title="a b.ts"`. Values may be bare,
 * "double" or 'single' quoted. Words that are not pairs (`{1,3}`) are skipped.
 * A first word that is a pair (no language) belongs to the pairs.
 */
export function tokenizeFenceInfo(info: string): FenceInfo {
  const text = info.trim()
  // A fence with no language starts straight with a pair: ``` line=5
  const bare = /^[A-Za-z][\w-]*=/.test(text)
  const space = bare ? 0 : text.search(/\s/)
  const head = bare ? '' : space < 0 ? text : text.slice(0, space)
  const meta = new Map<string, string>()
  let at = space < 0 ? text.length : space
  while (at < text.length) {
    if (/\s/.test(text.charAt(at))) {
      at += 1
      continue
    }
    PAIR.lastIndex = at
    const pair = PAIR.exec(text)
    if (pair) {
      const key = (pair[1] ?? '').toLowerCase()
      if (!meta.has(key)) meta.set(key, pair[2] ?? pair[3] ?? pair[4] ?? '')
      at = PAIR.lastIndex
      continue
    }
    WORD.lastIndex = at
    at = WORD.exec(text) ? WORD.lastIndex : text.length
  }
  return { head, meta }
}

/** The lines a snippet shows: from `start`, up to `end` when it is a range. */
export interface LineRange {
  start: number
  end: number | null
}

const MAX_LINE = 10_000_000

/** `5` or `5-9` (the `line=` value); null for anything else. */
export function parseLineRange(value: string): LineRange | null {
  const match = /^(\d{1,8})(?:-(\d{1,8}))?$/.exec(value.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? null : Number(match[2])
  if (start < 1 || start > MAX_LINE) return null
  if (end !== null && (end < start || end > MAX_LINE)) return null
  return { start, end: end === start ? null : end }
}

const MAX_URL = 2048

/** `value` when it is a plain https URL of reasonable length, else null. */
export function httpsUrl(value: string): string | null {
  if (value.length > MAX_URL || !/^https:\/\/[^\s<>"]+$/i.test(value)) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** A parsed `https://github.com/{owner}/{repo}/blob/{ref}/{path}` link. */
export interface GithubBlob {
  owner: string
  repo: string
  /** The first path segment after `blob`: a branch, tag or commit. */
  ref: string
  path: string
  /** From a `#L10` or `#L10-L20` fragment. */
  lines: LineRange | null
  /** The ref is a full 40-character commit hash. */
  isCommit: boolean
}

const BLOB =
  /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/blob\/([^/?#]+)\/([^?#]+)(?:\?[^#]*)?(?:#(.*))?$/i
const FRAGMENT = /^L(\d{1,8})(?:C\d+)?(?:-L(\d{1,8})(?:C\d+)?)?$/

export function parseGithubBlobUrl(url: string): GithubBlob | null {
  if (!httpsUrl(url)) return null
  const match = BLOB.exec(url)
  if (!match) return null
  const [, owner, repo, ref, path, hash] = match
  if (!owner || !repo || !ref || !path) return null
  let lines: LineRange | null = null
  const frag = hash === undefined ? null : FRAGMENT.exec(hash)
  if (frag) lines = parseLineRange(frag[2] ? `${frag[1]}-${frag[2]}` : (frag[1] ?? ''))
  return { owner, repo, ref, path, lines, isCommit: /^[0-9a-f]{40}$/i.test(ref) }
}

/** `url` without its `#fragment`. */
export function withoutHash(url: string): string {
  const at = url.indexOf('#')
  return at < 0 ? url : url.slice(0, at)
}
