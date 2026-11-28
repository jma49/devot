type Token = { kind: 'word' | 'string' | 'punct'; text: string }

function tokenizeModule(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      let text = ''
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          text += source[i + 1]!
          i += 2
        } else {
          text += source[i]!
          i += 1
        }
      }
      i += 1
      if (quote !== '`') tokens.push({ kind: 'string', text })
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end += 1
      tokens.push({ kind: 'word', text: source.slice(i, end) })
      i = end
      continue
    }
    tokens.push({ kind: 'punct', text: ch })
    i += 1
  }
  return tokens
}

const isPunct = (tok: Token | undefined, text: string) =>
  tok !== undefined && tok.kind === 'punct' && tok.text === text
const isWord = (tok: Token | undefined, text: string) =>
  tok !== undefined && tok.kind === 'word' && tok.text === text

function braceHasValueSpecifier(tokens: readonly Token[], openIndex: number): [boolean, number] {
  let cursor = openIndex + 1
  let hasValue = false
  while (cursor < tokens.length) {
    const tok = tokens[cursor]!
    if (isPunct(tok, '}')) return [hasValue, cursor + 1]
    if (isPunct(tok, ',')) {
      cursor += 1
      continue
    }
    const next = tokens[cursor + 1]
    const isTypeItem =
      isWord(tok, 'type') && next !== undefined && next.kind === 'word' && next.text !== 'as'
    if (!isTypeItem) hasValue = true
    while (
      cursor < tokens.length &&
      !isPunct(tokens[cursor], ',') &&
      !isPunct(tokens[cursor], '}')
    ) {
      cursor += 1
    }
  }
  return [hasValue, cursor]
}

/**
 * Extracts module specifiers of static runtime `import` and `export ... from` declarations,
 * parsing one declaration at a time and skipping declaration-level and specifier-level `type`
 * imports/exports while preserving side-effect imports (`import './x'`).
 */
export function runtimeModuleSpecifiers(source: string): string[] {
  const tokens = tokenizeModule(source)
  const out: string[] = []
  let i = 0
  let braceDepth = 0
  let parenDepth = 0

  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok.kind === 'punct') {
      if (tok.text === '{') braceDepth += 1
      else if (tok.text === '}') braceDepth = Math.max(0, braceDepth - 1)
      else if (tok.text === '(') parenDepth += 1
      else if (tok.text === ')') parenDepth = Math.max(0, parenDepth - 1)
      i += 1
      continue
    }
    if (braceDepth > 0 || parenDepth > 0) {
      i += 1
      continue
    }

    if (isWord(tok, 'import')) {
      const second = tokens[i + 1]
      if (!second || isPunct(second, '(') || isPunct(second, '.')) {
        i += 1
        continue
      }
      if (second.kind === 'string') {
        out.push(second.text)
        i += 2
        continue
      }
      const third = tokens[i + 2]
      if (
        isWord(second, 'type') &&
        third !== undefined &&
        !isWord(third, 'from') &&
        !isWord(third, 'as') &&
        !isPunct(third, ',')
      ) {
        i += 2
        while (i < tokens.length && tokens[i]!.kind !== 'string') i += 1
        i += 1
        continue
      }
      let cursor = i + 1
      let hasRuntime = false
      while (cursor < tokens.length) {
        const cur = tokens[cursor]!
        const after = tokens[cursor + 1]
        if (isWord(cur, 'from') && after?.kind === 'string') {
          if (hasRuntime) out.push(after.text)
          cursor += 2
          break
        }
        if (isPunct(cur, '{')) {
          const [braceRuntime, nextCursor] = braceHasValueSpecifier(tokens, cursor)
          if (braceRuntime) hasRuntime = true
          cursor = nextCursor
          continue
        }
        if (isPunct(cur, '*') || (cur.kind === 'word' && cur.text !== 'as')) {
          hasRuntime = true
        }
        cursor += 1
      }
      i = cursor
      continue
    }

    if (isWord(tok, 'export')) {
      const second = tokens[i + 1]
      if (!second) break
      if (isWord(second, 'type')) {
        let cursor = i + 2
        if (isPunct(tokens[cursor], '{')) {
          const [, nextCursor] = braceHasValueSpecifier(tokens, cursor)
          cursor = nextCursor
        } else if (isPunct(tokens[cursor], '*')) {
          cursor += 1
          if (isWord(tokens[cursor], 'as')) cursor += 2
        } else {
          i += 2
          continue
        }
        if (isWord(tokens[cursor], 'from')) cursor += 2
        i = cursor
        continue
      }
      if (isPunct(second, '*')) {
        let cursor = i + 2
        if (isWord(tokens[cursor], 'as')) cursor += 2
        const after = tokens[cursor + 1]
        if (isWord(tokens[cursor], 'from') && after?.kind === 'string') {
          out.push(after.text)
          i = cursor + 2
          continue
        }
      } else if (isPunct(second, '{')) {
        const [braceRuntime, nextCursor] = braceHasValueSpecifier(tokens, i + 1)
        const after = tokens[nextCursor + 1]
        if (isWord(tokens[nextCursor], 'from') && after?.kind === 'string') {
          if (braceRuntime) out.push(after.text)
          i = nextCursor + 2
          continue
        }
      }
    }

    i += 1
  }
  return out
}
