'use strict'
;(() => {
  const MAX_TITLE_CHARS = 1000
  const MAX_EVAL_STEPS = 5000
  const MAX_EVAL_DEPTH = 24
  const MDX_JSX = Symbol('mdx.jsx')

  const HTML_VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ])

  const BLOCKED_HTML_TAGS = new Set([
    'script',
    'style',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'portal',
    'fencedframe',
    'link',
    'base',
    'meta',
    'form',
  ])

  const ALLOWED_HTML_TAGS = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'dd',
    'del',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'samp',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
    'var',
  ])

  const BUILTIN_COMPONENTS = new Set([
    'Callout',
    'Alert',
    'Admonition',
    'Note',
    'Tip',
    'Info',
    'Important',
    'Warning',
    'Caution',
    'Danger',
    'Error',
    'Check',
    'Success',
    'Tabs',
    'Tab',
    'TabItem',
    'Accordion',
    'AccordionGroup',
    'Details',
    'Collapsible',
    'Expandable',
    'Steps',
    'Step',
    'Card',
    'LinkCard',
    'Cards',
    'CardGroup',
    'Columns',
    'Column',
    'Grid',
    'Frame',
    'Figure',
    'CodeGroup',
    'CodeBlock',
    'Pre',
    'FileTree',
    'FileTree.Folder',
    'FileTree.File',
    'Badge',
    'Pill',
    'Tag',
    'Kbd',
    'Highlight',
    'Mark',
    'Tooltip',
    'Stat',
    'Metric',
    'ParamField',
    'ResponseField',
    'Property',
    'Mermaid',
    'Math',
    'YouTube',
    'Vimeo',
    'Video',
    'Embed',
  ])

  const FORBIDDEN_PROPS = new Set([
    'constructor',
    '__proto__',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ])

  const FORBIDDEN_IDENTIFIERS = new Set([
    'window',
    'document',
    'globalThis',
    'self',
    'top',
    'parent',
    'frames',
    'Function',
    'eval',
    'XMLHttpRequest',
    'fetch',
    'WebSocket',
    'Worker',
    'SharedWorker',
    'importScripts',
  ])

  const ESM_KEYWORDS = new Set([
    'import',
    'export',
    'from',
    'as',
    'default',
    'const',
    'let',
    'var',
    'function',
    'return',
    'async',
    'type',
  ])

  const JS_KEYWORDS = new Set([
    'true',
    'false',
    'null',
    'undefined',
    'typeof',
    'new',
    'in',
    'of',
    'if',
    'else',
    'return',
    'const',
    'let',
    'var',
    'function',
  ])

  const SCRIPT_URL =
    typeof document === 'object' && document !== null && document.currentScript
      ? document.currentScript.src
      : ''

  function wellFormedText(value) {
    const str = String(value ?? '')
    if (typeof str.toWellFormed === 'function') return str.toWellFormed()
    let out = ''
    for (let i = 0; i < str.length; i += 1) {
      const code = str.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = str.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += str.slice(i, i + 2)
          i += 1
        } else {
          out += '\ufffd'
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        out += '\ufffd'
      } else {
        out += str[i]
      }
    }
    return out
  }

  function normalizeText(raw) {
    let text = wellFormedText(raw)
    if (text.startsWith('\ufeff')) text = text.slice(1)
    return text.replace(/\r\n?/g, '\n')
  }

  function clipTitle(raw) {
    const clean = wellFormedText(raw)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const chars = [...clean]
    return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join('') : clean
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function buildLineOffsets(text) {
    const starts = [0]
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') starts.push(i + 1)
    }
    return starts
  }

  function offsetToLoc(starts, offset) {
    let low = 0
    let high = starts.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[mid] <= offset) low = mid + 1
      else high = mid - 1
    }
    const lineIdx = Math.max(0, high)
    return { line: lineIdx + 1, column: offset - starts[lineIdx] + 1 }
  }

  function longestBacktickRun(text) {
    let max = 0
    let cur = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '`') {
        cur += 1
        if (cur > max) max = cur
      } else {
        cur = 0
      }
    }
    return max
  }

  function parseYamlScalar(raw) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    ) {
      const quote = trimmed[0]
      const inner = trimmed.slice(1, -1)
      if (quote === "'") return inner.replace(/''/g, "'")
      return inner.replace(/\\(["\\/nrt])/g, (_, ch) => {
        if (ch === 'n') return '\n'
        if (ch === 'r') return '\r'
        if (ch === 't') return '\t'
        return ch
      })
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim()
      if (!inner) return []
      return inner.split(',').map((item) => parseYamlScalar(item))
    }
    const commentAt = trimmed.indexOf(' #')
    return commentAt >= 0 ? trimmed.slice(0, commentAt).trim() : trimmed
  }

  function parseYamlMap(yaml) {
    const data = {}
    const lines = yaml.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line || /^\s*(?:#|$)/.test(line)) {
        i += 1
        continue
      }
      const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
      if (!match) {
        i += 1
        continue
      }
      const key = match[1]
      const rest = match[2].trim()
      if (rest === '|' || rest === '>') {
        const block = []
        i += 1
        while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i].trim() === '')) {
          block.push(lines[i].replace(/^\s{2}/, ''))
          i += 1
        }
        data[key] = block.join(rest === '|' ? '\n' : ' ').trim()
        continue
      }
      if (rest === '') {
        const list = []
        let j = i + 1
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
          list.push(parseYamlScalar(lines[j].replace(/^\s*-\s+/, '')))
          j += 1
        }
        if (list.length > 0) {
          data[key] = list
          i = j
          continue
        }
        data[key] = null
        i += 1
        continue
      }
      data[key] = parseYamlScalar(rest)
      i += 1
    }
    return data
  }

  function parseFrontMatter(rawSource) {
    const source = normalizeText(rawSource)
    if (!/^---[ \t]*\n/.test(source)) {
      return { yaml: null, data: {}, body: source, endLine: 0 }
    }
    const lines = source.split('\n')
    for (let i = 1; i < lines.length; i += 1) {
      if (/^---[ \t]*$/.test(lines[i])) {
        const yaml = lines.slice(1, i).join('\n')
        const body = lines.slice(i + 1).join('\n')
        return { yaml, data: parseYamlMap(yaml), body, endLine: i + 1 }
      }
    }
    return { yaml: null, data: {}, body: source, endLine: 0 }
  }

  function skipQuotedString(text, start) {
    const quote = text[start]
    let i = start + 1
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
        const close = scanBalancedBrace(text, i + 1)
        if (close < 0) return -1
        i = close + 1
        continue
      }
      if (text[i] === quote) return i + 1
      i += 1
    }
    return -1
  }

  function scanBalancedBrace(text, openAt) {
    if (text[openAt] !== '{') return -1
    let depth = 1
    let i = openAt + 1
    while (i < text.length) {
      const ch = text[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const after = skipQuotedString(text, i)
        if (after < 0) return -1
        i = after
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        if (end < 0) return -1
        i = end + 2
        continue
      }
      if (ch === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i + 2)
        i = nl < 0 ? text.length : nl + 1
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return i
      }
      i += 1
    }
    return -1
  }

  function scanBalancedParens(text, openAt) {
    if (text[openAt] !== '(') return -1
    let depth = 1
    let i = openAt + 1
    while (i < text.length) {
      const ch = text[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const after = skipQuotedString(text, i)
        if (after < 0) return -1
        i = after
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) return i
      }
      i += 1
    }
    return -1
  }

  function isAutolinkAt(text, ltAt) {
    const slice = text.slice(ltAt, ltAt + 120)
    return /^<(?:https?:\/\/|mailto:|devot:\/\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})[^>\s]*>/.test(
      slice,
    )
  }

  function scanJsxTag(text, ltAt) {
    if (text[ltAt] !== '<') return null
    if (isAutolinkAt(text, ltAt)) return null
    if (text.startsWith('<>', ltAt)) {
      return { kind: 'open', name: '', attrs: [], selfClosing: false, end: ltAt + 2 }
    }
    if (text.startsWith('</>', ltAt)) {
      return { kind: 'close', name: '', attrs: [], selfClosing: false, end: ltAt + 3 }
    }
    if (text.startsWith('<!--', ltAt)) return null

    let i = ltAt + 1
    let closing = false
    if (text[i] === '/') {
      closing = true
      i += 1
    }
    const nameMatch = /^[A-Za-z_$][A-Za-z0-9_$.-]*/.exec(text.slice(i))
    if (!nameMatch) return null
    const name = nameMatch[0]
    i += name.length

    if (closing) {
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text[i] !== '>') return null
      return { kind: 'close', name, attrs: [], selfClosing: false, end: i + 1 }
    }

    const attrs = []
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text.startsWith('/>', i)) {
        return { kind: 'open', name, attrs, selfClosing: true, end: i + 2 }
      }
      if (text[i] === '>') {
        return { kind: 'open', name, attrs, selfClosing: false, end: i + 1 }
      }
      if (text[i] === '{') {
        const close = scanBalancedBrace(text, i)
        if (close < 0) return null
        const inner = text.slice(i + 1, close).trim()
        if (inner.startsWith('...')) {
          attrs.push({ kind: 'spread', expr: inner.slice(3).trim() })
        }
        i = close + 1
        continue
      }
      const attrMatch = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(text.slice(i))
      if (!attrMatch) return null
      const attrName = attrMatch[0]
      i += attrName.length
      const wsStart = i
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text[i] !== '=') {
        attrs.push({ kind: 'boolean', name: attrName })
        i = wsStart === i ? i : i
        continue
      }
      i += 1
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text[i] === '"' || text[i] === "'") {
        const quote = text[i]
        const after = skipQuotedString(text, i)
        if (after < 0) return null
        const rawVal = text.slice(i + 1, after - 1)
        const val =
          quote === '"'
            ? rawVal.replace(/\\(["\\/nrt])/g, (_, c) =>
                c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c,
              )
            : rawVal
        attrs.push({ kind: 'string', name: attrName, value: val })
        i = after
        continue
      }
      if (text[i] === '{') {
        const close = scanBalancedBrace(text, i)
        if (close < 0) return null
        attrs.push({ kind: 'expr', name: attrName, expr: text.slice(i + 1, close) })
        i = close + 1
        continue
      }
      return null
    }
    return null
  }

  function parseInlineJsxElement(text, startAt) {
    const first = scanJsxTag(text, startAt)
    if (!first || first.kind !== 'open') return null
    const lower = first.name.toLowerCase()
    const isVoid = first.name !== '' && first.name === lower && HTML_VOID_TAGS.has(lower)
    if (first.selfClosing || isVoid) {
      return {
        element: {
          tag: first.name,
          attrs: first.attrs,
          children: [],
          selfClosing: true,
        },
        end: first.end,
      }
    }
    const children = []
    let cursor = first.end
    let textStart = cursor
    const flushText = (to) => {
      if (to > textStart) children.push({ type: 'text', value: text.slice(textStart, to) })
    }
    while (cursor < text.length) {
      if (text.startsWith('{/*', cursor)) {
        flushText(cursor)
        const endComment = text.indexOf('*/}', cursor + 3)
        if (endComment < 0) return null
        cursor = endComment + 3
        textStart = cursor
        continue
      }
      if (text[cursor] === '{') {
        flushText(cursor)
        const close = scanBalancedBrace(text, cursor)
        if (close < 0) return null
        children.push({ type: 'expr', expr: text.slice(cursor + 1, close) })
        cursor = close + 1
        textStart = cursor
        continue
      }
      if (text[cursor] === '<') {
        const tag = scanJsxTag(text, cursor)
        if (tag && tag.kind === 'close' && tag.name === first.name) {
          flushText(cursor)
          return {
            element: {
              tag: first.name,
              attrs: first.attrs,
              children,
              selfClosing: false,
            },
            end: tag.end,
          }
        }
        if (tag && tag.kind === 'open') {
          const nested = parseInlineJsxElement(text, cursor)
          if (nested) {
            flushText(cursor)
            children.push({ type: 'jsx', element: nested.element })
            cursor = nested.end
            textStart = cursor
            continue
          }
        }
      }
      cursor += 1
    }
    return null
  }

  function tokenizeJs(src) {
    const tokens = []
    let i = 0
    let canStartJsx = true

    while (i < src.length) {
      const ch = src[i]
      if (/\s/.test(ch)) {
        i += 1
        continue
      }
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i + 2)
        i = nl < 0 ? src.length : nl + 1
        continue
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        if (end < 0) throw new Error('Unclosed comment')
        i = end + 2
        continue
      }
      if (
        canStartJsx &&
        ch === '<' &&
        (src[i + 1] === '>' || /[A-Za-z_$]/.test(src[i + 1] ?? ''))
      ) {
        const parsed = parseInlineJsxElement(src, i)
        if (parsed) {
          tokens.push({ type: 'jsx', element: parsed.element })
          i = parsed.end
          canStartJsx = false
          continue
        }
      }
      if (ch === "'" || ch === '"') {
        const after = skipQuotedString(src, i)
        if (after < 0) throw new Error('Unclosed string')
        const raw = src.slice(i + 1, after - 1)
        const value = raw.replace(/\\(["'\\/nrt])/g, (_, c) =>
          c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c,
        )
        tokens.push({ type: 'string', value })
        i = after
        canStartJsx = false
        continue
      }
      if (ch === '`') {
        const parts = []
        let p = i + 1
        let chunk = ''
        while (p < src.length) {
          if (src[p] === '\\') {
            const esc = src[p + 1] ?? ''
            chunk += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc
            p += 2
            continue
          }
          if (src[p] === '$' && src[p + 1] === '{') {
            if (chunk) parts.push({ kind: 'str', value: chunk })
            chunk = ''
            const close = scanBalancedBrace(src, p + 1)
            if (close < 0) throw new Error('Unclosed template interpolation')
            parts.push({ kind: 'expr', expr: src.slice(p + 2, close) })
            p = close + 1
            continue
          }
          if (src[p] === '`') {
            if (chunk) parts.push({ kind: 'str', value: chunk })
            p += 1
            break
          }
          chunk += src[p]
          p += 1
        }
        tokens.push({ type: 'template', parts })
        i = p
        canStartJsx = false
        continue
      }
      const numMatch = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/.exec(src.slice(i))
      if (numMatch) {
        tokens.push({ type: 'number', value: Number(numMatch[0]) })
        i += numMatch[0].length
        canStartJsx = false
        continue
      }
      const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
      if (idMatch) {
        const word = idMatch[0]
        tokens.push({ type: 'ident', value: word })
        i += word.length
        canStartJsx = word === 'return' || word === 'typeof'
        continue
      }
      const three = src.slice(i, i + 3)
      if (['===', '!==', '...'].includes(three)) {
        tokens.push({ type: 'op', value: three })
        i += 3
        canStartJsx = true
        continue
      }
      const two = src.slice(i, i + 2)
      if (['==', '!=', '<=', '>=', '&&', '||', '??', '=>', '?.', '**'].includes(two)) {
        tokens.push({ type: 'op', value: two })
        i += 2
        canStartJsx = two !== '?.'
        continue
      }
      if ('+-*/%!<>&|^?:=,.;()[]{}'.includes(ch)) {
        tokens.push({ type: 'punc', value: ch })
        i += 1
        canStartJsx = !')]}'.includes(ch)
        continue
      }
      throw new Error(`Unexpected character: ${ch}`)
    }
    return tokens
  }

  function parseJsAst(src) {
    const tokens = tokenizeJs(src)
    let pos = 0

    const peek = (offset = 0) => tokens[pos + offset]
    const next = () => tokens[pos++]
    const matchVal = (val) => {
      const t = peek()
      if (t && t.value === val) {
        pos += 1
        return true
      }
      return false
    }
    const expectVal = (val) => {
      if (!matchVal(val)) throw new Error(`Expected ${val}`)
    }

    function parseParamPattern() {
      const t = peek()
      if (t && t.type === 'ident') {
        pos += 1
        let def = null
        if (matchVal('=')) def = parseAssignment()
        return { kind: 'id', name: t.value, def }
      }
      if (matchVal('{')) {
        const props = []
        while (pos < tokens.length && !matchVal('}')) {
          const keyTok = next()
          if (!keyTok || keyTok.type !== 'ident') throw new Error('Invalid destructured key')
          let local = keyTok.value
          if (matchVal(':')) {
            const aliasTok = next()
            if (!aliasTok || aliasTok.type !== 'ident') throw new Error('Invalid alias')
            local = aliasTok.value
          }
          let def = null
          if (matchVal('=')) def = parseAssignment()
          props.push({ key: keyTok.value, local, def })
          matchVal(',')
        }
        let def = null
        if (matchVal('=')) def = parseAssignment()
        return { kind: 'obj-pat', props, def }
      }
      throw new Error('Unsupported parameter pattern')
    }

    function isArrowAhead() {
      if (peek()?.type === 'ident' && peek(1)?.value === '=>') return true
      if (peek()?.value !== '(') return false
      let depth = 0
      for (let i = pos; i < tokens.length; i += 1) {
        const v = tokens[i].value
        if (v === '(') depth += 1
        else if (v === ')') {
          depth -= 1
          if (depth === 0) return tokens[i + 1]?.value === '=>'
        }
      }
      return false
    }

    function parseFunctionBody() {
      if (!matchVal('{')) return { kind: 'expr-body', expr: parseAssignment() }
      const stmts = []
      while (pos < tokens.length && !matchVal('}')) {
        if (matchVal(';')) continue
        const t = peek()
        if (
          t?.type === 'ident' &&
          (t.value === 'const' || t.value === 'let' || t.value === 'var')
        ) {
          pos += 1
          const pat = parseParamPattern()
          expectVal('=')
          const init = parseAssignment()
          matchVal(';')
          stmts.push({ kind: 'decl', pat, init })
          continue
        }
        if (t?.type === 'ident' && t.value === 'return') {
          pos += 1
          if (peek()?.value === ';' || peek()?.value === '}') {
            matchVal(';')
            stmts.push({ kind: 'return', expr: null })
          } else {
            const expr = parseAssignment()
            matchVal(';')
            stmts.push({ kind: 'return', expr })
          }
          continue
        }
        const expr = parseAssignment()
        matchVal(';')
        stmts.push({ kind: 'expr-stmt', expr })
      }
      return { kind: 'block-body', stmts }
    }

    function parseArrow() {
      const params = []
      if (peek()?.type === 'ident') {
        params.push({ kind: 'id', name: next().value, def: null })
      } else {
        expectVal('(')
        while (pos < tokens.length && !matchVal(')')) {
          params.push(parseParamPattern())
          matchVal(',')
        }
      }
      expectVal('=>')
      const body = parseFunctionBody()
      return { type: 'arrow', params, body }
    }

    function parseAssignment() {
      if (isArrowAhead()) return parseArrow()
      return parseConditional()
    }

    function parseConditional() {
      const test = parseNullish()
      if (matchVal('?')) {
        const consequent = parseAssignment()
        expectVal(':')
        const alternate = parseAssignment()
        return { type: 'cond', test, consequent, alternate }
      }
      return test
    }

    function parseBinaryLayer(nextLayer, ops) {
      let left = nextLayer()
      while (peek() && ops.includes(peek().value)) {
        const op = next().value
        const right = nextLayer()
        left = { type: 'bin', op, left, right }
      }
      return left
    }

    const parseNullish = () => parseBinaryLayer(parseOr, ['??'])
    const parseOr = () => parseBinaryLayer(parseAnd, ['||'])
    const parseAnd = () => parseBinaryLayer(parseEquality, ['&&'])
    const parseEquality = () => parseBinaryLayer(parseCompare, ['===', '!==', '==', '!='])
    const parseCompare = () => parseBinaryLayer(parseAdd, ['<', '<=', '>', '>='])
    const parseAdd = () => parseBinaryLayer(parseMul, ['+', '-'])
    const parseMul = () => parseBinaryLayer(parsePow, ['*', '/', '%'])
    const parsePow = () => parseBinaryLayer(parseUnary, ['**'])

    function parseUnary() {
      const t = peek()
      if (t && (t.value === '!' || t.value === '-' || t.value === '+' || t.value === 'typeof')) {
        pos += 1
        return { type: 'unary', op: t.value, arg: parseUnary() }
      }
      return parsePostfix()
    }

    function parsePostfix() {
      let node = parsePrimary()
      while (pos < tokens.length) {
        if (matchVal('.') || matchVal('?.')) {
          const optional = tokens[pos - 1].value === '?.'
          const prop = next()
          if (!prop || prop.type !== 'ident') throw new Error('Expected property name')
          node = { type: 'member', object: node, prop: prop.value, computed: false, optional }
          continue
        }
        if (peek()?.value === '?.') {
          pos += 1
          if (matchVal('[')) {
            const prop = parseAssignment()
            expectVal(']')
            node = { type: 'member', object: node, prop, computed: true, optional: true }
            continue
          }
        }
        if (matchVal('[')) {
          const prop = parseAssignment()
          expectVal(']')
          node = { type: 'member', object: node, prop, computed: true, optional: false }
          continue
        }
        if (matchVal('(')) {
          const args = []
          while (pos < tokens.length && !matchVal(')')) {
            if (matchVal('...')) args.push({ spread: true, expr: parseAssignment() })
            else args.push({ spread: false, expr: parseAssignment() })
            matchVal(',')
          }
          node = { type: 'call', callee: node, args }
          continue
        }
        break
      }
      return node
    }

    function parsePrimary() {
      const t = peek()
      if (!t) throw new Error('Unexpected end of expression')
      if (t.type === 'number' || t.type === 'string') {
        pos += 1
        return { type: 'lit', value: t.value }
      }
      if (t.type === 'jsx') {
        pos += 1
        return { type: 'jsx', element: t.element }
      }
      if (t.type === 'template') {
        pos += 1
        return {
          type: 'template',
          parts: t.parts.map((p) =>
            p.kind === 'str' ? p : { kind: 'expr', ast: parseJsAst(p.expr) },
          ),
        }
      }
      if (t.type === 'ident') {
        pos += 1
        if (t.value === 'true') return { type: 'lit', value: true }
        if (t.value === 'false') return { type: 'lit', value: false }
        if (t.value === 'null') return { type: 'lit', value: null }
        if (t.value === 'undefined') return { type: 'lit', value: undefined }
        return { type: 'ident', name: t.value }
      }
      if (matchVal('(')) {
        const inner = parseAssignment()
        expectVal(')')
        return inner
      }
      if (matchVal('[')) {
        const items = []
        while (pos < tokens.length && !matchVal(']')) {
          if (matchVal('...')) items.push({ spread: true, expr: parseAssignment() })
          else items.push({ spread: false, expr: parseAssignment() })
          matchVal(',')
        }
        return { type: 'array', items }
      }
      if (matchVal('{')) {
        const entries = []
        while (pos < tokens.length && !matchVal('}')) {
          if (matchVal('...')) {
            entries.push({ spread: true, expr: parseAssignment() })
            matchVal(',')
            continue
          }
          const keyTok = next()
          if (!keyTok) throw new Error('Expected object key')
          const key =
            keyTok.type === 'ident' || keyTok.type === 'string' || keyTok.type === 'number'
              ? String(keyTok.value)
              : null
          if (key === null) throw new Error('Unsupported object key')
          if (matchVal(':')) {
            entries.push({ spread: false, key, expr: parseAssignment() })
          } else if (keyTok.type === 'ident') {
            entries.push({ spread: false, key, expr: { type: 'ident', name: key } })
          } else {
            throw new Error('Expected colon in object literal')
          }
          matchVal(',')
        }
        return { type: 'object', entries }
      }
      throw new Error(`Unexpected token: ${t.value ?? t.type}`)
    }

    const root = parseAssignment()
    if (pos < tokens.length) throw new Error('Trailing tokens in expression')
    return root
  }

  const SAFE_ARRAY_METHODS = new Set([
    'map',
    'filter',
    'find',
    'findIndex',
    'some',
    'every',
    'includes',
    'join',
    'slice',
    'concat',
    'flat',
    'flatMap',
    'indexOf',
    'at',
    'reduce',
  ])

  const SAFE_STRING_METHODS = new Set([
    'toUpperCase',
    'toLowerCase',
    'trim',
    'trimStart',
    'trimEnd',
    'slice',
    'substring',
    'split',
    'replace',
    'replaceAll',
    'includes',
    'startsWith',
    'endsWith',
    'repeat',
    'padStart',
    'padEnd',
    'charAt',
  ])

  const SAFE_GLOBALS = Object.freeze({
    Math,
    JSON: Object.freeze({ stringify: JSON.stringify, parse: JSON.parse }),
    Number: Object.assign((v) => Number(v), {
      isFinite: Number.isFinite,
      isInteger: Number.isInteger,
      parseInt: Number.parseInt,
      parseFloat: Number.parseFloat,
    }),
    String: (v) => String(v),
    Boolean: (v) => Boolean(v),
    Array: Object.freeze({ isArray: Array.isArray, from: (v) => Array.from(v) }),
    Object: Object.freeze({
      keys: (v) => (v && typeof v === 'object' ? Object.keys(v) : []),
      values: (v) => (v && typeof v === 'object' ? Object.values(v) : []),
      entries: (v) => (v && typeof v === 'object' ? Object.entries(v) : []),
    }),
  })

  function evalAst(node, scope, budget) {
    budget.steps += 1
    if (budget.steps > MAX_EVAL_STEPS) throw new Error('Evaluation budget exceeded')
    if (budget.depth > MAX_EVAL_DEPTH) throw new Error('Evaluation depth exceeded')

    switch (node.type) {
      case 'lit':
        return node.value
      case 'ident': {
        if (FORBIDDEN_IDENTIFIERS.has(node.name) || FORBIDDEN_PROPS.has(node.name)) return undefined
        if (Object.hasOwn(scope, node.name)) return scope[node.name]
        if (Object.hasOwn(SAFE_GLOBALS, node.name)) return SAFE_GLOBALS[node.name]
        return undefined
      }
      case 'template':
        return node.parts
          .map((p) => (p.kind === 'str' ? p.value : String(evalAst(p.ast, scope, budget) ?? '')))
          .join('')
      case 'array': {
        const out = []
        for (const item of node.items) {
          const val = evalAst(item.expr, scope, budget)
          if (item.spread && Array.isArray(val)) out.push(...val)
          else out.push(val)
        }
        return out
      }
      case 'object': {
        const out = Object.create(null)
        for (const entry of node.entries) {
          if (entry.spread) {
            const src = evalAst(entry.expr, scope, budget)
            if (src && typeof src === 'object') {
              for (const k of Object.keys(src)) {
                if (!FORBIDDEN_PROPS.has(k)) out[k] = src[k]
              }
            }
          } else if (!FORBIDDEN_PROPS.has(entry.key)) {
            out[entry.key] = evalAst(entry.expr, scope, budget)
          }
        }
        return { ...out }
      }
      case 'jsx':
        return evaluateJsxDescriptor(node.element, scope, budget)
      case 'unary': {
        const v = evalAst(node.arg, scope, budget)
        if (node.op === '!') return !v
        if (node.op === '-') return -Number(v)
        if (node.op === '+') return +Number(v)
        if (node.op === 'typeof') return typeof v
        return undefined
      }
      case 'bin': {
        if (node.op === '&&') {
          const l = evalAst(node.left, scope, budget)
          return l ? evalAst(node.right, scope, budget) : l
        }
        if (node.op === '||') {
          const l = evalAst(node.left, scope, budget)
          return l ? l : evalAst(node.right, scope, budget)
        }
        if (node.op === '??') {
          const l = evalAst(node.left, scope, budget)
          return l !== null && l !== undefined ? l : evalAst(node.right, scope, budget)
        }
        const l = evalAst(node.left, scope, budget)
        const r = evalAst(node.right, scope, budget)
        switch (node.op) {
          case '+':
            return l + r
          case '-':
            return l - r
          case '*':
            return l * r
          case '/':
            return l / r
          case '%':
            return l % r
          case '**':
            return l ** r
          case '===':
            return l === r
          case '!==':
            return l !== r
          case '==':
            return l == r
          case '!=':
            return l != r
          case '<':
            return l < r
          case '<=':
            return l <= r
          case '>':
            return l > r
          case '>=':
            return l >= r
          default:
            return undefined
        }
      }
      case 'cond':
        return evalAst(node.test, scope, budget)
          ? evalAst(node.consequent, scope, budget)
          : evalAst(node.alternate, scope, budget)
      case 'member': {
        const obj = evalAst(node.object, scope, budget)
        if (obj === null || obj === undefined) {
          if (node.optional) return undefined
          throw new Error('Cannot read property of null/undefined')
        }
        const key = node.computed ? String(evalAst(node.prop, scope, budget)) : node.prop
        if (FORBIDDEN_PROPS.has(key)) return undefined
        if (Array.isArray(obj)) {
          if (key === 'length') return obj.length
          if (/^\d+$/.test(key)) return obj[Number(key)]
          if (SAFE_ARRAY_METHODS.has(key)) return obj[key].bind(obj)
          return undefined
        }
        if (typeof obj === 'string') {
          if (key === 'length') return obj.length
          if (/^\d+$/.test(key)) return obj[Number(key)]
          if (SAFE_STRING_METHODS.has(key)) return obj[key].bind(obj)
          return undefined
        }
        if (typeof obj === 'object') {
          return Object.hasOwn(obj, key) ? obj[key] : undefined
        }
        return undefined
      }
      case 'arrow':
        return makeSafeFunction(node.params, node.body, scope, budget)
      case 'call': {
        const fn = evalAst(node.callee, scope, budget)
        if (typeof fn !== 'function') throw new Error('Target is not callable')
        if (fn === Function) return undefined
        const args = []
        for (const a of node.args) {
          const val = evalAst(a.expr, scope, budget)
          if (a.spread && Array.isArray(val)) args.push(...val)
          else args.push(val)
        }
        budget.depth += 1
        try {
          return fn(...args)
        } finally {
          budget.depth -= 1
        }
      }
      default:
        return undefined
    }
  }

  function bindPattern(pat, value, targetScope, parentScope, budget) {
    const resolved =
      value === undefined && pat.def !== null ? evalAst(pat.def, parentScope, budget) : value
    if (pat.kind === 'id') {
      targetScope[pat.name] = resolved
      return
    }
    if (pat.kind === 'obj-pat') {
      const src = resolved && typeof resolved === 'object' ? resolved : {}
      for (const prop of pat.props) {
        const raw = Object.hasOwn(src, prop.key) ? src[prop.key] : undefined
        targetScope[prop.local] =
          raw === undefined && prop.def !== null ? evalAst(prop.def, targetScope, budget) : raw
      }
    }
  }

  function makeSafeFunction(params, body, closureScope, sharedBudget) {
    const fn = (...args) => {
      const budget = sharedBudget ?? { steps: 0, depth: 0 }
      budget.steps += 1
      if (budget.steps > MAX_EVAL_STEPS || budget.depth > MAX_EVAL_DEPTH) {
        throw new Error('Function budget exceeded')
      }
      const local = { ...closureScope }
      for (let i = 0; i < params.length; i += 1) {
        bindPattern(params[i], args[i], local, local, budget)
      }
      if (body.kind === 'expr-body') return evalAst(body.expr, local, budget)
      for (const stmt of body.stmts) {
        if (stmt.kind === 'decl') {
          const val = evalAst(stmt.init, local, budget)
          bindPattern(stmt.pat, val, local, local, budget)
        } else if (stmt.kind === 'return') {
          return stmt.expr ? evalAst(stmt.expr, local, budget) : undefined
        } else if (stmt.kind === 'expr-stmt') {
          evalAst(stmt.expr, local, budget)
        }
      }
      return undefined
    }
    return fn
  }

  function evaluateJsxDescriptor(element, scope, budget) {
    const props = {}
    for (const attr of element.attrs) {
      if (attr.kind === 'boolean') props[attr.name] = true
      else if (attr.kind === 'string') props[attr.name] = attr.value
      else if (attr.kind === 'expr')
        props[attr.name] = evalAst(parseJsAst(attr.expr), scope, budget)
      else if (attr.kind === 'spread') {
        const spreadVal = evalAst(parseJsAst(attr.expr), scope, budget)
        if (spreadVal && typeof spreadVal === 'object') {
          for (const k of Object.keys(spreadVal)) {
            if (!FORBIDDEN_PROPS.has(k)) props[k] = spreadVal[k]
          }
        }
      }
    }
    const children = []
    for (const child of element.children) {
      if (child.type === 'text') children.push(child.value)
      else if (child.type === 'jsx')
        children.push(evaluateJsxDescriptor(child.element, scope, budget))
      else if (child.type === 'expr') {
        const trimmed = child.expr.trim()
        if (trimmed && !/^\/\*[\s\S]*\*\/$/.test(trimmed)) {
          children.push(evalAst(parseJsAst(trimmed), scope, budget))
        }
      }
    }
    return { [MDX_JSX]: true, tag: element.tag, props, children }
  }

  function evaluateExpression(expr, scope = {}) {
    const trimmed = String(expr ?? '').trim()
    if (trimmed === '') return { ok: true, value: '' }
    try {
      const ast = parseJsAst(trimmed)
      const budget = { steps: 0, depth: 0 }
      const value = evalAst(ast, scope, budget)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Invalid expression' }
    }
  }

  function scanEsmStatement(text, startAt) {
    const slice = text.slice(startAt)
    if (
      slice.startsWith('import ') ||
      slice.startsWith('import{') ||
      slice.startsWith("import'") ||
      slice.startsWith('import"')
    ) {
      let i = startAt + 6
      while (i < text.length) {
        const ch = text[i]
        if (ch === '{') {
          const close = scanBalancedBrace(text, i)
          if (close < 0) break
          i = close + 1
          continue
        }
        if (ch === "'" || ch === '"') {
          const after = skipQuotedString(text, i)
          if (after < 0) break
          let end = after
          while (
            end < text.length &&
            (text[end] === ' ' || text[end] === '\t' || text[end] === ';')
          ) {
            end += 1
          }
          if (end < text.length && text[end] === '\n') end += 1
          return { kind: 'import', raw: text.slice(startAt, end).trim(), end }
        }
        if (ch === '\n') {
          const restLine = text.slice(i + 1).trimStart()
          if (!restLine.startsWith('from') && !restLine.startsWith('}')) {
            return { kind: 'import', raw: text.slice(startAt, i + 1).trim(), end: i + 1 }
          }
        }
        i += 1
      }
    }

    const varMatch = /^export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/.exec(slice)
    if (varMatch) {
      const declKind = varMatch[1]
      const name = varMatch[2]
      let i = startAt + varMatch[0].length
      const end = scanExpressionStatementEnd(text, i)
      const exprText = text.slice(i, end).replace(/;\s*$/, '').trim()
      const afterNl = text[end] === '\n' ? end + 1 : end
      return { kind: 'export-var', declKind, name, exprText, end: afterNl }
    }

    const fnMatch = /^export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*/.exec(slice)
    if (fnMatch) {
      const name = fnMatch[1]
      const parenAt = startAt + fnMatch[0].length
      if (text[parenAt] === '(') {
        const parenEnd = scanBalancedParens(text, parenAt)
        if (parenEnd > parenAt) {
          let braceAt = parenEnd + 1
          while (braceAt < text.length && /\s/.test(text[braceAt])) braceAt += 1
          if (text[braceAt] === '{') {
            const braceEnd = scanBalancedBrace(text, braceAt)
            if (braceEnd > braceAt) {
              const paramsSrc = text.slice(parenAt, parenEnd + 1)
              const bodySrc = text.slice(braceAt, braceEnd + 1)
              let end = braceEnd + 1
              while (
                end < text.length &&
                (text[end] === ' ' || text[end] === '\t' || text[end] === ';')
              ) {
                end += 1
              }
              if (text[end] === '\n') end += 1
              return {
                kind: 'export-fn',
                name,
                arrowSrc: `${paramsSrc} => ${bodySrc}`,
                end,
              }
            }
          }
        }
      }
    }

    const defaultMatch = /^export\s+default\s+/.exec(slice)
    if (defaultMatch) {
      const i = startAt + defaultMatch[0].length
      const end = scanExpressionStatementEnd(text, i)
      const afterNl = text[end] === '\n' ? end + 1 : end
      return {
        kind: 'export-default',
        exprText: text.slice(i, end).replace(/;\s*$/, '').trim(),
        end: afterNl,
      }
    }

    return null
  }

  function scanExpressionStatementEnd(text, startAt) {
    let i = startAt
    let paren = 0
    let bracket = 0
    let brace = 0
    let endedWithJsx = false
    while (i < text.length) {
      const ch = text[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        endedWithJsx = false
        const after = skipQuotedString(text, i)
        if (after < 0) return text.length
        i = after
        continue
      }
      if (ch === '<' && paren === 0 && bracket === 0 && brace === 0) {
        const jsx = parseInlineJsxElement(text, i)
        if (jsx) {
          endedWithJsx = true
          i = jsx.end
          continue
        }
      }
      if (ch === '(') {
        endedWithJsx = false
        paren += 1
      } else if (ch === ')') {
        endedWithJsx = false
        paren = Math.max(0, paren - 1)
      } else if (ch === '[') {
        endedWithJsx = false
        bracket += 1
      } else if (ch === ']') {
        endedWithJsx = false
        bracket = Math.max(0, bracket - 1)
      } else if (ch === '{') {
        endedWithJsx = false
        brace += 1
      } else if (ch === '}') {
        endedWithJsx = false
        brace = Math.max(0, brace - 1)
      } else if (ch === ';' && paren === 0 && bracket === 0 && brace === 0) {
        return i + 1
      } else if (ch === '\n' && paren === 0 && bracket === 0 && brace === 0) {
        if (endedWithJsx) return i
        const prev = text.slice(startAt, i).trimEnd()
        if (prev !== '' && !prev.endsWith('=>') && !/[=(,+\-*/?:&|.]$/.test(prev)) return i
      } else if (ch !== ' ' && ch !== '\t') {
        endedWithJsx = false
      }
      i += 1
    }
    return text.length
  }

  function parseImportDetails(raw, line) {
    const fromMatch = /from\s*['"]([^'"]+)['"]/.exec(raw) ?? /^import\s*['"]([^'"]+)['"]/.exec(raw)
    const source = fromMatch ? fromMatch[1] : ''
    const specifiers = []
    const braceMatch = /\{([\s\S]*?)\}/.exec(raw)
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const cleaned = part.trim()
        if (!cleaned) continue
        const asParts = cleaned.split(/\s+as\s+/)
        specifiers.push((asParts[1] ?? asParts[0]).trim())
      }
    }
    const defMatch = /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw)
    if (defMatch && defMatch[1] !== 'type') specifiers.push(defMatch[1])
    return { raw, source, specifiers, line }
  }

  function findCodeFenceEnd(text, fenceStart) {
    const lineEnd = text.indexOf('\n', fenceStart)
    const firstLine = lineEnd < 0 ? text.slice(fenceStart) : text.slice(fenceStart, lineEnd)
    const match = /^[ \t>]*(`{3,}|~{3,})/.exec(firstLine)
    if (!match) return -1
    const marker = match[1][0]
    const len = match[1].length
    if (lineEnd < 0) return text.length
    let i = lineEnd + 1
    while (i < text.length) {
      const nextNl = text.indexOf('\n', i)
      const line = nextNl < 0 ? text.slice(i) : text.slice(i, nextNl)
      const closeRe = new RegExp(`^[ \\t>]*${marker}{${len},}[ \\t]*$`)
      if (closeRe.test(line)) return nextNl < 0 ? text.length : nextNl + 1
      if (nextNl < 0) return text.length
      i = nextNl + 1
    }
    return text.length
  }

  function skipInlineCodeSpan(text, backtickAt) {
    let ticks = 0
    while (text[backtickAt + ticks] === '`') ticks += 1
    const delim = '`'.repeat(ticks)
    let search = backtickAt + ticks
    while (search < text.length) {
      const found = text.indexOf(delim, search)
      if (found < 0) return -1
      if (text[found + ticks] !== '`') return found + ticks
      while (text[search] === '`') search += 1
      search = found + ticks
    }
    return -1
  }

  function parseMdxDocument(rawSource) {
    const normalized = normalizeText(rawSource)
    const fm = parseFrontMatter(normalized)
    const fullStarts = buildLineOffsets(normalized)
    const bodyOffset = fm.yaml === null ? 0 : normalized.length - fm.body.length
    const text = fm.body

    const diagnostics = []
    const imports = []
    const exports = []
    const componentMap = new Map()
    const scope = {}
    const nodes = []

    const addDiag = (severity, code, message, localOffset) => {
      const loc = offsetToLoc(fullStarts, bodyOffset + localOffset)
      diagnostics.push({ severity, code, message, line: loc.line, column: loc.column })
    }

    const recordComponent = (name, localOffset) => {
      if (!name || (!/^[A-Z]/.test(name) && !name.includes('.'))) return
      const loc = offsetToLoc(fullStarts, bodyOffset + localOffset)
      const prev = componentMap.get(name)
      if (prev) {
        prev.count += 1
        if (!prev.lines.includes(loc.line)) prev.lines.push(loc.line)
      } else {
        componentMap.set(name, {
          name,
          count: 1,
          lines: [loc.line],
          builtin: BUILTIN_COMPONENTS.has(name),
        })
      }
    }

    function parseSegment(start, end, openStack) {
      const out = []
      let i = start
      let proseStart = start

      const flushProse = (to) => {
        if (to > proseStart) out.push({ type: 'prose', value: text.slice(proseStart, to) })
      }

      while (i < end) {
        const atLineStart = i === 0 || text[i - 1] === '\n'

        if (atLineStart) {
          const lineEnd = text.indexOf('\n', i)
          const line = lineEnd < 0 ? text.slice(i, end) : text.slice(i, Math.min(end, lineEnd))
          if (/^[ \t>]*(`{3,}|~{3,})/.test(line)) {
            flushProse(i)
            const fenceEnd = Math.min(end, findCodeFenceEnd(text, i))
            out.push({ type: 'code-fence', value: text.slice(i, fenceEnd) })
            i = fenceEnd
            proseStart = i
            continue
          }
          if (openStack.length === 0 && /^(?:import|export)\b/.test(line)) {
            const esm = scanEsmStatement(text, i)
            if (esm && esm.end <= end) {
              flushProse(i)
              const loc = offsetToLoc(fullStarts, bodyOffset + i)
              if (esm.kind === 'import') {
                imports.push(parseImportDetails(esm.raw, loc.line))
              } else if (esm.kind === 'export-var') {
                const evaluated = evaluateExpression(esm.exprText, scope)
                const val = evaluated.ok ? evaluated.value : undefined
                scope[esm.name] = val
                exports.push({
                  name: esm.name,
                  kind: esm.declKind,
                  line: loc.line,
                  valuePreview: previewValue(val),
                })
                if (!evaluated.ok) {
                  addDiag('error', 'MDX_INVALID_EXPRESSION', evaluated.error, i)
                }
              } else if (esm.kind === 'export-fn') {
                const evaluated = evaluateExpression(esm.arrowSrc, scope)
                if (evaluated.ok && typeof evaluated.value === 'function') {
                  scope[esm.name] = evaluated.value
                }
                exports.push({
                  name: esm.name,
                  kind: 'function',
                  line: loc.line,
                  valuePreview: 'component()',
                })
              } else if (esm.kind === 'export-default') {
                exports.push({
                  name: 'default',
                  kind: 'default',
                  line: loc.line,
                  valuePreview: esm.exprText.slice(0, 40),
                })
              }
              i = esm.end
              proseStart = i
              continue
            }
          }
        }

        const ch = text[i]

        if (ch === '`') {
          const spanEnd = skipInlineCodeSpan(text, i)
          if (spanEnd > i && spanEnd <= end) {
            i = spanEnd
            continue
          }
        }

        if (text.startsWith('<!--', i)) {
          flushProse(i)
          addDiag(
            'warning',
            'MDX_HTML_COMMENT',
            'HTML comments are invalid in MDX; use {/* ... */} instead.',
            i,
          )
          const closeHtml = text.indexOf('-->', i + 4)
          i = closeHtml < 0 ? end : Math.min(end, closeHtml + 3)
          proseStart = i
          continue
        }

        if (text.startsWith('{/*', i)) {
          flushProse(i)
          const closeComment = text.indexOf('*/}', i + 3)
          if (closeComment < 0 || closeComment + 3 > end) {
            addDiag('error', 'MDX_UNCLOSED_COMMENT', 'Unclosed MDX comment {/* ... */}.', i)
            i = end
            proseStart = i
            break
          }
          i = closeComment + 3
          proseStart = i
          continue
        }

        if (ch === '{') {
          flushProse(i)
          const closeBrace = scanBalancedBrace(text, i)
          if (closeBrace < 0 || closeBrace >= end) {
            addDiag('error', 'MDX_UNCLOSED_EXPRESSION', 'Unclosed { expression.', i)
            out.push({ type: 'prose', value: text.slice(i, end) })
            i = end
            proseStart = i
            break
          }
          const exprSrc = text.slice(i + 1, closeBrace)
          const evaluated = evaluateExpression(exprSrc, scope)
          if (!evaluated.ok) {
            addDiag('error', 'MDX_INVALID_EXPRESSION', evaluated.error, i)
            out.push({ type: 'prose', value: text.slice(i, closeBrace + 1) })
          } else {
            out.push({ type: 'expr-value', expr: exprSrc, value: evaluated.value })
          }
          i = closeBrace + 1
          proseStart = i
          continue
        }

        if (ch === '<') {
          const tag = scanJsxTag(text, i)
          if (!tag) {
            const nextChar = text[i + 1] ?? ''
            if (/[0-9=]/.test(nextChar)) {
              addDiag(
                'warning',
                'MDX_BARE_LESS_THAN',
                'Unescaped "<" before a number or "=" breaks MDX JSX parsing; escape as "&lt;".',
                i,
              )
            }
            i += 1
            continue
          }

          if (tag.kind === 'close') {
            const top = openStack[openStack.length - 1]
            if (top && top.name === tag.name) {
              flushProse(i)
              return { nodes: out, closedAt: tag.end, closedTag: tag }
            }
            const ancestorIdx = openStack.map((s) => s.name).lastIndexOf(tag.name)
            if (ancestorIdx >= 0) {
              const unclosed = openStack[openStack.length - 1]
              addDiag(
                'error',
                'MDX_MISMATCHED_TAG',
                `Expected closing </${unclosed.name}> before </${tag.name}>.`,
                i,
              )
              flushProse(i)
              return { nodes: out, closedAt: i, closedTag: null }
            }
            addDiag(
              'error',
              'MDX_MISMATCHED_TAG',
              `Unexpected closing tag </${tag.name || 'fragment'}>.`,
              i,
            )
            flushProse(i)
            i = tag.end
            proseStart = i
            continue
          }

          flushProse(i)
          recordComponent(tag.name, i)
          const lower = tag.name.toLowerCase()
          const isHtmlVoid = tag.name !== '' && tag.name === lower && HTML_VOID_TAGS.has(lower)
          if (isHtmlVoid && !tag.selfClosing) {
            addDiag(
              'warning',
              'MDX_UNCLOSED_VOID_TAG',
              `Void HTML tag <${tag.name}> must be self-closed as <${tag.name} /> in MDX.`,
              i,
            )
          }

          const evalProps = evaluateAttrs(tag.attrs, scope, (msg) =>
            addDiag('error', 'MDX_INVALID_EXPRESSION', msg, i),
          )

          if (tag.selfClosing || isHtmlVoid) {
            out.push({
              type: 'jsx',
              name: tag.name,
              props: evalProps,
              children: [],
            })
            i = tag.end
            proseStart = i
            continue
          }

          const frame = { name: tag.name, offset: i }
          openStack.push(frame)
          const inner = parseSegment(tag.end, end, openStack)
          openStack.pop()
          if (!inner.closedTag) {
            addDiag('error', 'MDX_UNCLOSED_TAG', `Unclosed JSX tag <${tag.name || 'fragment'}>.`, i)
          }
          out.push({
            type: 'jsx',
            name: tag.name,
            props: evalProps,
            children: inner.nodes,
          })
          i = inner.closedAt
          proseStart = i
          continue
        }

        i += 1
      }

      flushProse(end)
      return { nodes: out, closedAt: end, closedTag: null }
    }

    const parsed = parseSegment(0, text.length, [])
    nodes.push(...parsed.nodes)

    return {
      frontMatter: fm,
      scope,
      imports,
      exports,
      components: [...componentMap.values()],
      diagnostics,
      nodes,
    }
  }

  function evaluateAttrs(attrs, scope, onError) {
    const props = {}
    for (const attr of attrs) {
      if (attr.kind === 'boolean') {
        props[attr.name] = true
      } else if (attr.kind === 'string') {
        props[attr.name] = attr.value
      } else if (attr.kind === 'expr') {
        const res = evaluateExpression(attr.expr, scope)
        if (res.ok) props[attr.name] = res.value
        else onError(res.error)
      } else if (attr.kind === 'spread') {
        const res = evaluateExpression(attr.expr, scope)
        if (res.ok && res.value && typeof res.value === 'object') {
          for (const k of Object.keys(res.value)) {
            if (!FORBIDDEN_PROPS.has(k)) props[k] = res.value[k]
          }
        } else if (!res.ok) {
          onError(res.error)
        }
      }
    }
    return props
  }

  function previewValue(val) {
    if (val === null) return 'null'
    if (val === undefined) return 'undefined'
    if (typeof val === 'string')
      return JSON.stringify(val.length > 32 ? `${val.slice(0, 32)}...` : val)
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    if (Array.isArray(val)) return `Array(${val.length})`
    if (typeof val === 'function') return 'component()'
    if (typeof val === 'object') return `{ ${Object.keys(val).slice(0, 4).join(', ')} }`
    return String(val)
  }

  function stripInlineMarkdown(line, scope) {
    let text = line.replace(/\{([^{}]+)\}/g, (whole, expr) => {
      const res = evaluateExpression(expr, scope)
      return res.ok && res.value !== undefined && res.value !== null ? String(res.value) : whole
    })
    text = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/<[^>]+>/g, '')
    return text.trim()
  }

  function extractTitle(rawSource, fileName = '') {
    const doc = parseMdxDocument(rawSource)
    const fmTitle = doc.frontMatter.data.title
    if (typeof fmTitle === 'string' && fmTitle.trim() !== '') {
      return clipTitle(fmTitle)
    }
    for (const key of ['metadata', 'frontmatter', 'meta']) {
      const obj = doc.scope[key]
      if (
        obj &&
        typeof obj === 'object' &&
        typeof obj.title === 'string' &&
        obj.title.trim() !== ''
      ) {
        return clipTitle(obj.title)
      }
    }
    if (typeof doc.scope.title === 'string' && doc.scope.title.trim() !== '') {
      return clipTitle(doc.scope.title)
    }
    const renderedText = renderNodesToMarkdown(doc.nodes, doc.scope, 0)
    for (const line of renderedText.split('\n')) {
      const m = /^#[ \t]+(.+?)[ \t]*#*$/.exec(line.trim())
      if (m) {
        const heading = stripInlineMarkdown(m[1], doc.scope)
        if (heading) return clipTitle(heading)
      }
    }
    for (const node of doc.nodes) {
      if (node.type === 'jsx' && node.name === 'h1') {
        const h1Text = renderNodesToMarkdown(node.children, doc.scope, 0).trim()
        if (h1Text) return clipTitle(stripInlineMarkdown(h1Text, doc.scope))
      }
    }
    const base = String(fileName ?? '')
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.(?:mdx|markdown|md)$/i, '')
      ?.normalize('NFC')
      ?.trim()
    return clipTitle(base || 'Untitled')
  }

  function inspectMdx(rawSource) {
    const doc = parseMdxDocument(rawSource)
    return {
      title: extractTitle(rawSource),
      frontMatter: doc.frontMatter.yaml !== null ? doc.frontMatter.data : null,
      imports: doc.imports,
      exports: doc.exports,
      components: doc.components,
      diagnostics: doc.diagnostics,
    }
  }

  function normalizeAlertKind(raw) {
    const kind = String(raw ?? 'note').toLowerCase()
    if (kind === 'tip' || kind === 'success' || kind === 'check') return 'TIP'
    if (kind === 'important') return 'IMPORTANT'
    if (kind === 'warning' || kind === 'warn') return 'WARNING'
    if (kind === 'caution' || kind === 'danger' || kind === 'error') return 'CAUTION'
    return 'NOTE'
  }

  function dedentCommon(text) {
    const lines = text.replace(/^\n+|\n+$/g, '').split('\n')
    let min = Infinity
    for (const line of lines) {
      if (line.trim() === '') continue
      const indent = /^[ \t]*/.exec(line)[0].length
      if (indent < min) min = indent
    }
    if (!Number.isFinite(min) || min === 0) return lines.join('\n')
    return lines.map((l) => (l.length >= min ? l.slice(min) : l.trimStart())).join('\n')
  }

  function descriptorToAstNode(desc) {
    if (desc === null || desc === undefined || typeof desc === 'boolean') {
      return { type: 'prose', value: '' }
    }
    if (Array.isArray(desc)) {
      return { type: 'fragment', children: desc.map(descriptorToAstNode) }
    }
    if (typeof desc === 'object' && desc[MDX_JSX]) {
      return {
        type: 'jsx',
        name: desc.tag,
        props: desc.props ?? {},
        children: (desc.children ?? []).map(descriptorToAstNode),
      }
    }
    return { type: 'prose', value: String(desc) }
  }

  function expandDynamicChildren(children) {
    const out = []
    for (const child of children) {
      if (child.type === 'expr-value') {
        const node = descriptorToAstNode(child.value)
        if (node.type === 'fragment') out.push(...expandDynamicChildren(node.children))
        else out.push(node)
      } else if (child.type === 'fragment') {
        out.push(...expandDynamicChildren(child.children))
      } else {
        out.push(child)
      }
    }
    return out
  }

  function renderExprValueToMarkdown(val, scope, depth) {
    if (val === null || val === undefined || typeof val === 'boolean') return ''
    if (Array.isArray(val)) {
      return val.map((item) => renderExprValueToMarkdown(item, scope, depth)).join('')
    }
    if (typeof val === 'object' && val[MDX_JSX]) {
      return renderJsxNodeToMarkdown(descriptorToAstNode(val), scope, depth)
    }
    return String(val)
  }

  function prefixBlockquote(text) {
    return text
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n')
  }

  function renderJsxNodeToMarkdown(node, scope, depth) {
    if (depth > MAX_EVAL_DEPTH) return ''
    const name = node.name
    const props = node.props ?? {}

    if (name && typeof scope[name] === 'function') {
      const childMd = dedentCommon(renderNodesToMarkdown(node.children, scope, depth + 1))
      try {
        const result = scope[name]({ ...props, children: childMd })
        return renderExprValueToMarkdown(result, scope, depth + 1)
      } catch {
        return childMd
      }
    }

    const innerMd = () =>
      dedentCommon(renderNodesToMarkdown(node.children, scope, depth + 1)).trim()

    if (name === '') return innerMd()

    if (
      [
        'Callout',
        'Alert',
        'Admonition',
        'Note',
        'Tip',
        'Info',
        'Important',
        'Warning',
        'Caution',
        'Danger',
        'Error',
        'Check',
        'Success',
      ].includes(name)
    ) {
      const inferredType =
        name === 'Callout' || name === 'Alert' || name === 'Admonition'
          ? (props.type ?? props.variant ?? props.kind ?? 'note')
          : name.toLowerCase()
      const kind = normalizeAlertKind(inferredType)
      const title = props.title ? `${props.emoji ? `${props.emoji} ` : ''}**${props.title}**` : ''
      const content = innerMd()
      const bodyLines = [title, content].filter(Boolean).join('\n\n')
      return `\n\n> [!${kind}]\n${prefixBlockquote(bodyLines || kind)}\n\n`
    }

    if (name === 'Badge' || name === 'Pill' || name === 'Tag') {
      const label = innerMd() || String(props.label ?? props.text ?? '')
      return `<mark>${escapeHtml(label)}</mark>`
    }

    if (name === 'Highlight' || name === 'Mark') {
      return `<mark>${innerMd()}</mark>`
    }

    if (name === 'Kbd') {
      const keys = innerMd() || String(props.keys ?? props.shortcut ?? '')
      return `<kbd>${escapeHtml(keys)}</kbd>`
    }

    if (name === 'Tooltip') {
      const tip = String(props.tip ?? props.content ?? props.title ?? '')
      return `<span title="${escapeHtml(tip)}">${innerMd()}</span>`
    }

    if (
      name === 'Accordion' ||
      name === 'Details' ||
      name === 'Collapsible' ||
      name === 'Expandable'
    ) {
      const summary = String(props.title ?? props.summary ?? props.label ?? 'Details')
      const openAttr = props.defaultOpen || props.open ? ' open' : ''
      return `\n\n<details${openAttr}>\n<summary><strong>${escapeHtml(summary)}</strong></summary>\n\n${innerMd()}\n\n</details>\n\n`
    }

    if (name === 'AccordionGroup' || name === 'CodeGroup') {
      return `\n\n${innerMd()}\n\n`
    }

    if (name === 'Tabs') {
      const items = Array.isArray(props.items) ? props.items : []
      const defaultIdx = typeof props.defaultIndex === 'number' ? props.defaultIndex : 0
      const defaultVal = props.defaultValue
      const tabNodes = expandDynamicChildren(node.children).filter(
        (c) => c.type === 'jsx' && (c.name === 'Tab' || c.name === 'TabItem'),
      )
      if (tabNodes.length === 0) return `\n\n${innerMd()}\n\n`
      const blocks = tabNodes.map((tab, idx) => {
        const itemEntry = items[idx]
        const itemLabel =
          typeof itemEntry === 'object' && itemEntry !== null
            ? (itemEntry.label ?? itemEntry.value)
            : itemEntry
        const label = String(
          tab.props.label ?? tab.props.title ?? tab.props.value ?? itemLabel ?? `Tab ${idx + 1}`,
        )
        const isOpen =
          defaultVal !== undefined ? (tab.props.value ?? label) === defaultVal : idx === defaultIdx
        const body = dedentCommon(renderNodesToMarkdown(tab.children, scope, depth + 1)).trim()
        return `<details${isOpen ? ' open' : ''}>\n<summary><strong>${escapeHtml(label)}</strong></summary>\n\n${body}\n\n</details>`
      })
      return `\n\n${blocks.join('\n\n')}\n\n`
    }

    if (name === 'Tab' || name === 'TabItem') {
      const label = String(props.label ?? props.title ?? props.value ?? 'Tab')
      return `\n\n<details open>\n<summary><strong>${escapeHtml(label)}</strong></summary>\n\n${innerMd()}\n\n</details>\n\n`
    }

    if (name === 'Steps') {
      const steps = expandDynamicChildren(node.children).filter(
        (c) => c.type === 'jsx' && c.name === 'Step',
      )
      if (steps.length === 0) return `\n\n${innerMd()}\n\n`
      const rendered = steps.map((step, idx) => {
        const num = step.props.stepNumber ?? idx + 1
        const title = String(step.props.title ?? `Step ${num}`)
        const body = dedentCommon(renderNodesToMarkdown(step.children, scope, depth + 1)).trim()
        const indented = body
          .split('\n')
          .map((l) => (l ? `   ${l}` : ''))
          .join('\n')
        return `${num}. **${title}**\n\n${indented}`
      })
      return `\n\n${rendered.join('\n\n')}\n\n`
    }

    if (name === 'Step') {
      const title = String(props.title ?? 'Step')
      return `\n\n#### ${title}\n\n${innerMd()}\n\n`
    }

    if (name === 'Cards' || name === 'CardGroup' || name === 'Columns' || name === 'Grid') {
      const cards = expandDynamicChildren(node.children).filter(
        (c) =>
          c.type === 'jsx' && (c.name === 'Card' || c.name === 'LinkCard' || c.name === 'Column'),
      )
      if (cards.length === 0) return `\n\n${innerMd()}\n\n`
      return `\n\n${cards.map((c) => renderJsxNodeToMarkdown(c, scope, depth + 1)).join('\n\n')}\n\n`
    }

    if (name === 'Card' || name === 'LinkCard' || name === 'Column') {
      const title = String(props.title ?? 'Card')
      const href = typeof props.href === 'string' ? props.href : ''
      const badge = props.badge ? ` <mark>${escapeHtml(String(props.badge))}</mark>` : ''
      const heading = href.startsWith('devot://note/')
        ? `[**${title}**](${href})${badge}`
        : href
          ? `**${title}**${badge} (\`${href}\`)`
          : `**${title}**${badge}`
      const desc = props.description ? `${props.description}\n\n` : ''
      const body = `${desc}${innerMd()}`.trim()
      return `\n\n${prefixBlockquote(body ? `${heading}\n\n${body}` : heading)}\n\n`
    }

    if (name === 'FileTree') {
      const lines = renderFileTreeLines(node.children, '')
      return `\n\n\`\`\`text title="Files"\n${lines.join('\n')}\n\`\`\`\n\n`
    }

    if (name === 'CodeBlock') {
      const lang = String(props.language ?? props.lang ?? 'text')
      const title = props.title ? ` title="${String(props.title).replace(/"/g, '')}"` : ''
      const code = String(props.code ?? innerMd())
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1))
      return `\n\n${fence}${lang}${title}\n${code}\n${fence}\n\n`
    }

    if (name === 'Mermaid') {
      const chart = String(props.chart ?? innerMd())
      return `\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\n`
    }

    if (name === 'Math') {
      const formula = String(props.formula ?? innerMd())
      return props.block ? `\n\n$$\n${formula}\n$$\n\n` : `$${formula}$`
    }

    if (name === 'Stat' || name === 'Metric') {
      const label = String(props.label ?? props.title ?? 'Metric')
      const val = String(props.value ?? innerMd())
      const trend = props.trend ? ` (${props.trend})` : ''
      return `\n\n> **${label}:** \`${val}\`${trend}\n\n`
    }

    if (name === 'ParamField' || name === 'ResponseField' || name === 'Property') {
      const field = String(props.path ?? props.name ?? 'param')
      const type = props.type ? ` \`${props.type}\`` : ''
      const req = props.required ? ' *(required)*' : ''
      return `\n\n- **\`${field}\`**${type}${req} — ${innerMd()}\n\n`
    }

    if (name === 'YouTube' || name === 'Vimeo' || name === 'Video' || name === 'Embed') {
      const id = String(props.id ?? props.src ?? props.url ?? '')
      const title = String(props.title ?? name)
      return `\n\n> **${title}:** \`${id}\`\n\n`
    }

    if (name === 'Frame' || name === 'Figure') {
      const caption = props.caption || props.title ? `\n\n*${props.caption ?? props.title}*` : ''
      return `\n\n${innerMd()}${caption}\n\n`
    }

    const lower = name.toLowerCase()
    if (name === lower && ALLOWED_HTML_TAGS.has(lower)) {
      if (HTML_VOID_TAGS.has(lower)) {
        if (lower === 'img' && typeof props.src === 'string' && isSafeImageUrl(props.src)) {
          const alt = typeof props.alt === 'string' ? ` alt="${escapeHtml(props.alt)}"` : ''
          return `<img src="${escapeHtml(props.src)}"${alt} />`
        }
        if (lower === 'br' || lower === 'hr') return `<${lower} />`
        return ''
      }
      return `<${lower}>${innerMd()}</${lower}>`
    }

    if (name === lower && BLOCKED_HTML_TAGS.has(lower)) {
      return ''
    }

    const propSummary = Object.entries(props)
      .map(([k, v]) => `\`${k}=${previewValue(v)}\``)
      .join(' ')
    const header = propSummary ? `**\`<${name}>\`** ${propSummary}` : `**\`<${name}>\`**`
    const body = innerMd()
    return `\n\n${prefixBlockquote(body ? `${header}\n\n${body}` : header)}\n\n`
  }

  function renderFileTreeLines(children, indent) {
    const out = []
    for (const child of expandDynamicChildren(children)) {
      if (child.type !== 'jsx') continue
      if (child.name === 'FileTree.Folder') {
        const folderName = String(child.props.name ?? 'folder')
        out.push(`${indent}${folderName}/`)
        out.push(...renderFileTreeLines(child.children, `${indent}  `))
      } else if (child.name === 'FileTree.File') {
        const fileName = String(child.props.name ?? 'file')
        const marker = child.props.active ? ' *' : ''
        out.push(`${indent}${fileName}${marker}`)
      }
    }
    return out
  }

  function renderNodesToMarkdown(nodes, scope, depth) {
    let out = ''
    for (const node of nodes) {
      if (node.type === 'prose' || node.type === 'code-fence') {
        out += node.value
      } else if (node.type === 'text') {
        out += node.value
      } else if (node.type === 'expr-value') {
        out += renderExprValueToMarkdown(node.value, scope, depth)
      } else if (node.type === 'fragment') {
        out += renderNodesToMarkdown(node.children, scope, depth + 1)
      } else if (node.type === 'jsx') {
        out += renderJsxNodeToMarkdown(node, scope, depth)
      }
    }
    return out
  }

  function formatFrontMatterSummary(data) {
    const entries = Object.entries(data)
    if (entries.length === 0) return ''
    const rows = entries
      .map(([k, v]) => {
        const text = Array.isArray(v) ? v.join(', ') : v === null ? '' : String(v)
        return `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(text)}</dd>`
      })
      .join('')
    return `<dl>${rows}</dl>\n\n`
  }

  function compileMdxToMarkdown(rawSource, options = {}) {
    const doc = parseMdxDocument(rawSource)
    const rendered = renderNodesToMarkdown(doc.nodes, doc.scope, 0)
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (options.includeFrontMatterSummary && doc.frontMatter.yaml !== null) {
      const summary = formatFrontMatterSummary(doc.frontMatter.data)
      return `${summary}${rendered}`.trim()
    }
    if (doc.frontMatter.yaml !== null && options.preserveFrontMatter) {
      return `---\n${doc.frontMatter.yaml}\n---\n\n${rendered}\n`
    }
    return rendered
  }

  function wrapAsHighlightedFence(source, title = 'MDX') {
    const clean = normalizeText(source).replace(/\n+$/, '')
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(clean) + 1))
    return `${fence}tsx title="${title}" line=1\n${clean}\n${fence}`
  }

  function renderPreviewBlock(rawSource, mode = 'mdx') {
    const source = normalizeText(rawSource)
    if (mode === 'mdx-code' || mode === 'mdx-source') {
      return wrapAsHighlightedFence(source, 'MDX')
    }
    const firstNl = source.indexOf('\n')
    const firstLine = (firstNl < 0 ? source : source.slice(0, firstNl)).trim()
    const rest = firstNl < 0 ? '' : source.slice(firstNl + 1)

    if (
      /^(?:\/\/\s*@(?:highlight|source)|\{\/\*\s*@(?:highlight|source)\s*\*\/\})$/.test(firstLine)
    ) {
      return wrapAsHighlightedFence(rest, 'MDX')
    }
    if (
      /^(?:\/\/\s*@(?:both|playground)|\{\/\*\s*@(?:both|playground)\s*\*\/\})$/.test(firstLine)
    ) {
      const codeFence = wrapAsHighlightedFence(rest, 'MDX Source')
      const preview = compileMdxToMarkdown(rest, { includeFrontMatterSummary: true })
      return `${codeFence}\n\n---\n\n${preview}`
    }
    return compileMdxToMarkdown(source, { includeFrontMatterSummary: true })
  }

  function highlightMdx(rawSource) {
    const source = normalizeText(rawSource)
    const lines = source.split('\n')
    const tokens = []
    const htmlLines = []

    const hasFrontMatter = parseFrontMatter(source).yaml !== null
    let inFrontMatter = false
    let inFence = false
    let fenceChar = ''
    let fenceLen = 0
    let inMdxComment = false

    const emit = (lineArr, type, value, lineNo) => {
      if (!value) return
      tokens.push({ type, value, line: lineNo })
      if (type === 'text') lineArr.push(escapeHtml(value))
      else lineArr.push(`<span class="mdx-tok-${type}">${escapeHtml(value)}</span>`)
    }

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]
      const lineNo = idx + 1
      const lineHtml = []

      if (idx === 0 && hasFrontMatter && /^---[ \t]*$/.test(line)) {
        inFrontMatter = true
        emit(lineHtml, 'frontmatter-fence', line, lineNo)
        htmlLines.push(lineHtml.join(''))
        continue
      }

      if (inFrontMatter) {
        if (/^---[ \t]*$/.test(line)) {
          inFrontMatter = false
          emit(lineHtml, 'frontmatter-fence', line, lineNo)
        } else if (/^\s*#/.test(line)) {
          emit(lineHtml, 'comment', line, lineNo)
        } else {
          const kv = /^(\s*[A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/.exec(line)
          if (kv) {
            emit(lineHtml, 'frontmatter-key', kv[1], lineNo)
            emit(lineHtml, 'text', kv[2], lineNo)
            emit(lineHtml, 'frontmatter-value', kv[3], lineNo)
          } else {
            emit(lineHtml, 'frontmatter-value', line, lineNo)
          }
        }
        htmlLines.push(lineHtml.join(''))
        continue
      }

      if (inFence) {
        const closeRe = new RegExp(`^[ \\t>]*${fenceChar}{${fenceLen},}[ \\t]*$`)
        if (closeRe.test(line)) {
          inFence = false
          emit(lineHtml, 'fence', line, lineNo)
        } else {
          emit(lineHtml, 'code', line, lineNo)
        }
        htmlLines.push(lineHtml.join(''))
        continue
      }

      const openFence = /^([ \t>]*(`{3,}|~{3,}))(.*)$/.exec(line)
      if (!inMdxComment && openFence) {
        inFence = true
        fenceChar = openFence[2][0]
        fenceLen = openFence[2].length
        emit(lineHtml, 'fence', openFence[1], lineNo)
        if (openFence[3]) emit(lineHtml, 'fence-info', openFence[3], lineNo)
        htmlLines.push(lineHtml.join(''))
        continue
      }

      if (!inMdxComment && /^(?:import|export)\b/.test(line)) {
        tokenizeEsmLine(line, lineNo, lineHtml, emit)
        htmlLines.push(lineHtml.join(''))
        continue
      }

      inMdxComment = tokenizeMixedMdxLine(line, lineNo, inMdxComment, lineHtml, emit)
      htmlLines.push(lineHtml.join(''))
    }

    const wrapped = htmlLines
      .map(
        (content, idx) =>
          `<div class="mdx-code-line"><span class="mdx-line-num">${idx + 1}</span><span class="mdx-line-src">${content || ' '}</span></div>`,
      )
      .join('')

    return {
      html: `<div class="mdx-code-table">${wrapped}</div>`,
      lineCount: lines.length,
      tokens,
    }
  }

  function tokenizeEsmLine(line, lineNo, out, emit) {
    let i = 0
    while (i < line.length) {
      const ch = line[i]
      if (/\s/.test(ch)) {
        let j = i + 1
        while (j < line.length && /\s/.test(line[j])) j += 1
        emit(out, 'text', line.slice(i, j), lineNo)
        i = j
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const after = skipQuotedString(line, i)
        const end = after < 0 ? line.length : after
        emit(out, 'string', line.slice(i, end), lineNo)
        i = end
        continue
      }
      const num = /^\d+(?:\.\d+)?/.exec(line.slice(i))
      if (num) {
        emit(out, 'number', num[0], lineNo)
        i += num[0].length
        continue
      }
      const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i))
      if (id) {
        const word = id[0]
        if (ESM_KEYWORDS.has(word)) emit(out, 'esm-keyword', word, lineNo)
        else if (/^[A-Z]/.test(word)) emit(out, 'esm-ident', word, lineNo)
        else emit(out, 'text', word, lineNo)
        i += word.length
        continue
      }
      if ('{}()[].,;='.includes(ch)) {
        emit(out, 'expr-brace', ch, lineNo)
        i += 1
        continue
      }
      emit(out, 'text', ch, lineNo)
      i += 1
    }
  }

  function tokenizeJsExprInline(expr, lineNo, out, emit) {
    let i = 0
    while (i < expr.length) {
      const ch = expr[i]
      if (/\s/.test(ch)) {
        let j = i + 1
        while (j < expr.length && /\s/.test(expr[j])) j += 1
        emit(out, 'text', expr.slice(i, j), lineNo)
        i = j
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const after = skipQuotedString(expr, i)
        const end = after < 0 ? expr.length : after
        emit(out, 'string', expr.slice(i, end), lineNo)
        i = end
        continue
      }
      const num = /^\d+(?:\.\d+)?/.exec(expr.slice(i))
      if (num) {
        emit(out, 'number', num[0], lineNo)
        i += num[0].length
        continue
      }
      const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expr.slice(i))
      if (id) {
        const word = id[0]
        emit(out, JS_KEYWORDS.has(word) ? 'expr-keyword' : 'text', word, lineNo)
        i += word.length
        continue
      }
      emit(out, 'expr-operator', ch, lineNo)
      i += 1
    }
  }

  function tokenizeMixedMdxLine(line, lineNo, startInComment, out, emit) {
    let i = 0
    if (startInComment) {
      const close = line.indexOf('*/}')
      if (close < 0) {
        emit(out, 'comment', line, lineNo)
        return true
      }
      emit(out, 'comment', line.slice(0, close + 3), lineNo)
      i = close + 3
    } else {
      const heading = /^(#{1,6}[ \t]+)/.exec(line)
      if (heading) {
        emit(out, 'md-heading', heading[1], lineNo)
        i = heading[1].length
      } else {
        const quote = /^([ \t]*>[ \t]*(?:\[![A-Z]+\])?[ \t]*)/.exec(line)
        if (quote) {
          emit(out, 'md-quote', quote[1], lineNo)
          i = quote[1].length
        } else {
          const list = /^([ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(line)
          if (list) {
            emit(out, 'md-list', list[1], lineNo)
            i = list[1].length
          }
        }
      }
    }

    while (i < line.length) {
      if (line.startsWith('{/*', i)) {
        const close = line.indexOf('*/}', i + 3)
        if (close < 0) {
          emit(out, 'comment', line.slice(i), lineNo)
          return true
        }
        emit(out, 'comment', line.slice(i, close + 3), lineNo)
        i = close + 3
        continue
      }
      if (line.startsWith('<!--', i)) {
        const close = line.indexOf('-->', i + 4)
        const end = close < 0 ? line.length : close + 3
        emit(out, 'comment', line.slice(i, end), lineNo)
        i = end
        continue
      }
      if (line[i] === '`') {
        const end = skipInlineCodeSpan(line, i)
        if (end > i) {
          emit(out, 'md-inline-code', line.slice(i, end), lineNo)
          i = end
          continue
        }
      }
      if (line[i] === '<') {
        const tagMatch = /^(<\/?)([A-Za-z_$][A-Za-z0-9_$.-]*)?/.exec(line.slice(i))
        if (tagMatch && (tagMatch[2] || line.startsWith('<>', i) || line.startsWith('</>', i))) {
          emit(out, 'jsx-bracket', tagMatch[1], lineNo)
          i += tagMatch[1].length
          if (tagMatch[2]) {
            const isComp = /^[A-Z]/.test(tagMatch[2]) || tagMatch[2].includes('.')
            emit(out, isComp ? 'jsx-component' : 'jsx-html-tag', tagMatch[2], lineNo)
            i += tagMatch[2].length
          }
          while (i < line.length && line[i] !== '>' && !line.startsWith('/>', i)) {
            if (/\s/.test(line[i])) {
              let j = i + 1
              while (j < line.length && /\s/.test(line[j])) j += 1
              emit(out, 'text', line.slice(i, j), lineNo)
              i = j
              continue
            }
            const attr = /^[A-Za-z_:][A-Za-z0-9_:.-]*/.exec(line.slice(i))
            if (attr) {
              emit(out, 'jsx-attr', attr[0], lineNo)
              i += attr[0].length
              continue
            }
            if (line[i] === '=') {
              emit(out, 'jsx-bracket', '=', lineNo)
              i += 1
              continue
            }
            if (line[i] === '"' || line[i] === "'") {
              const after = skipQuotedString(line, i)
              const end = after < 0 ? line.length : after
              emit(out, 'string', line.slice(i, end), lineNo)
              i = end
              continue
            }
            if (line[i] === '{') {
              const close = scanBalancedBrace(line, i)
              if (close > i) {
                emit(out, 'expr-brace', '{', lineNo)
                tokenizeJsExprInline(line.slice(i + 1, close), lineNo, out, emit)
                emit(out, 'expr-brace', '}', lineNo)
                i = close + 1
                continue
              }
            }
            emit(out, 'text', line[i], lineNo)
            i += 1
          }
          if (line.startsWith('/>', i)) {
            emit(out, 'jsx-bracket', '/>', lineNo)
            i += 2
          } else if (line[i] === '>') {
            emit(out, 'jsx-bracket', '>', lineNo)
            i += 1
          }
          continue
        }
      }
      if (line[i] === '{') {
        const close = scanBalancedBrace(line, i)
        if (close > i) {
          emit(out, 'expr-brace', '{', lineNo)
          tokenizeJsExprInline(line.slice(i + 1, close), lineNo, out, emit)
          emit(out, 'expr-brace', '}', lineNo)
          i = close + 1
          continue
        }
        emit(out, 'expr-brace', '{', lineNo)
        i += 1
        continue
      }
      const strong = /^\*\*[^*]+\*\*/.exec(line.slice(i))
      if (strong) {
        emit(out, 'md-strong', strong[0], lineNo)
        i += strong[0].length
        continue
      }
      const em = /^\*[^*\s][^*]*\*/.exec(line.slice(i))
      if (em) {
        emit(out, 'md-emphasis', em[0], lineNo)
        i += em[0].length
        continue
      }
      const link = /^\[[^\]]+\]\([^)]+\)/.exec(line.slice(i))
      if (link) {
        emit(out, 'md-link', link[0], lineNo)
        i += link[0].length
        continue
      }
      let nextSpecial = i + 1
      while (
        nextSpecial < line.length &&
        !'`<{*['.includes(line[nextSpecial]) &&
        !line.startsWith('<!--', nextSpecial)
      ) {
        nextSpecial += 1
      }
      emit(out, 'text', line.slice(i, nextSpecial), lineNo)
      i = nextSpecial
    }
    return false
  }

  function isSafeHref(url) {
    return /^(?:https?:\/\/|mailto:|devot:\/\/note\/|#)/i.test(String(url ?? '').trim())
  }

  function isSafeImageUrl(url) {
    return /^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,|blob:|devot:\/\/file\/)/i.test(
      String(url ?? '').trim(),
    )
  }

  function renderInlineMarkdownHtml(raw) {
    let html = escapeHtml(raw)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    html = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const decoded = url.replace(/&amp;/g, '&')
      return isSafeHref(decoded)
        ? `<a href="${escapeHtml(decoded)}">${label}</a>`
        : `<span>${label}</span>`
    })
    return html
  }

  function renderProseBlockHtml(markdown) {
    const blocks = []
    const lines = markdown.split('\n')
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      const heading = /^\s*(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*$/.exec(line)
      if (heading && (/^\s*#{1,6}[ \t]+/.test(line) || /^\s*#{1,6}[ \t]*$/.test(line))) {
        const level = heading[1].length
        blocks.push(`<h${level}>${renderInlineMarkdownHtml(heading[2] ?? '')}</h${level}>`)
        i += 1
        continue
      }
      if (/^(?:---|\*\*\*|___)[ \t]*$/.test(line.trim())) {
        blocks.push('<hr />')
        i += 1
        continue
      }
      if (line.trimStart().startsWith('>')) {
        const quoteLines = []
        while (i < lines.length && lines[i].trimStart().startsWith('>')) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
          i += 1
        }
        const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(
          quoteLines[0] ?? '',
        )
        if (alertMatch) {
          const kind = alertMatch[1].toLowerCase()
          const body = renderProseBlockHtml(quoteLines.slice(1).join('\n'))
          blocks.push(
            `<div class="mdx-callout mdx-callout-${kind}"><div class="mdx-callout-title">${escapeHtml(alertMatch[1])}</div>${body}</div>`,
          )
        } else {
          blocks.push(`<blockquote>${renderProseBlockHtml(quoteLines.join('\n'))}</blockquote>`)
        }
        continue
      }
      if (
        line.includes('|') &&
        i + 1 < lines.length &&
        /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
      ) {
        const parseCells = (row) =>
          row
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim())
        const headers = parseCells(line)
        i += 2
        const rows = []
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(parseCells(lines[i]))
          i += 1
        }
        const thead = `<thead><tr>${headers.map((h) => `<th>${renderInlineMarkdownHtml(h)}</th>`).join('')}</tr></thead>`
        const tbody = `<tbody>${rows
          .map(
            (r) =>
              `<tr>${headers.map((_, c) => `<td>${renderInlineMarkdownHtml(r[c] ?? '')}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody>`
        blocks.push(`<table>${thead}${tbody}</table>`)
        continue
      }
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line)
        const tag = ordered ? 'ol' : 'ul'
        const items = []
        while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
          const content = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
          const task = /^\[([ xX])\]\s+(.*)$/.exec(content)
          if (task) {
            const checked = task[1].toLowerCase() === 'x' ? ' checked' : ''
            items.push(
              `<li><input type="checkbox" disabled${checked} /> ${renderInlineMarkdownHtml(task[2])}</li>`,
            )
          } else {
            items.push(`<li>${renderInlineMarkdownHtml(content)}</li>`)
          }
          i += 1
        }
        blocks.push(`<${tag}>${items.join('')}</${tag}>`)
        continue
      }
      const para = [renderInlineMarkdownHtml(lines[i])]
      i += 1
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(?:\s*#{1,6}(?:\s|$)|\s*>|\s*(?:[-*+]|\d+\.)\s|\s*(?:---|\*\*\*|___)\s*$)/.test(lines[i])
      ) {
        para.push(renderInlineMarkdownHtml(lines[i]))
        i += 1
      }
      blocks.push(`<p>${para.join('<br />')}</p>`)
    }
    return blocks.join('\n')
  }

  let tabGroupSeq = 0

  function renderStudioNodes(nodes, scope, depth, inline = false) {
    if (depth > MAX_EVAL_DEPTH) return ''
    let html = ''
    for (const node of nodes) {
      if (node.type === 'prose' || node.type === 'text') {
        html += inline ? renderInlineMarkdownHtml(node.value) : renderProseBlockHtml(node.value)
      } else if (node.type === 'code-fence') {
        const m = /^[ \t>]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n[ \t>]*\1[ \t]*)?$/.exec(
          node.value.trimEnd(),
        )
        const code = m ? m[3] : node.value
        html += `<pre><code>${escapeHtml(code)}</code></pre>`
      } else if (node.type === 'expr-value') {
        html += renderStudioExprValue(node.value, scope, depth, inline)
      } else if (node.type === 'fragment') {
        html += renderStudioNodes(node.children, scope, depth + 1, inline)
      } else if (node.type === 'jsx') {
        html += renderStudioJsx(node, scope, depth)
      }
    }
    return html
  }

  function renderStudioExprValue(val, scope, depth, inline) {
    if (val === null || val === undefined || typeof val === 'boolean') return ''
    if (Array.isArray(val)) {
      return val.map((v) => renderStudioExprValue(v, scope, depth, inline)).join('')
    }
    if (typeof val === 'object' && val[MDX_JSX]) {
      return renderStudioJsx(descriptorToAstNode(val), scope, depth)
    }
    return escapeHtml(String(val))
  }

  function renderStudioJsx(node, scope, depth) {
    const name = node.name
    const props = node.props ?? {}

    if (name && typeof scope[name] === 'function') {
      const childText = renderNodesToMarkdown(node.children, scope, depth + 1)
      try {
        const res = scope[name]({ ...props, children: childText })
        return renderStudioExprValue(res, scope, depth + 1, false)
      } catch {
        return escapeHtml(childText)
      }
    }

    if (name === '') return renderStudioNodes(node.children, scope, depth + 1)

    if (
      [
        'Callout',
        'Alert',
        'Admonition',
        'Note',
        'Tip',
        'Info',
        'Important',
        'Warning',
        'Caution',
        'Danger',
        'Error',
        'Check',
        'Success',
      ].includes(name)
    ) {
      const rawKind =
        name === 'Callout' || name === 'Alert' || name === 'Admonition'
          ? (props.type ?? props.variant ?? props.kind ?? 'note')
          : name
      const kind = normalizeAlertKind(rawKind).toLowerCase()
      const title = String(props.title ?? kind.charAt(0).toUpperCase() + kind.slice(1))
      const emoji = props.emoji ? `${escapeHtml(props.emoji)} ` : ''
      return `<div class="mdx-callout mdx-callout-${kind}" data-mdx-component="callout"><div class="mdx-callout-title">${emoji}${escapeHtml(title)}</div><div class="mdx-callout-body">${renderStudioNodes(node.children, scope, depth + 1)}</div></div>`
    }

    if (name === 'Tabs') {
      tabGroupSeq += 1
      const groupId = `mdx-tabs-${tabGroupSeq}`
      const items = Array.isArray(props.items) ? props.items : []
      const defaultIdx = typeof props.defaultIndex === 'number' ? props.defaultIndex : 0
      const defaultVal = props.defaultValue
      const tabs = expandDynamicChildren(node.children).filter(
        (c) => c.type === 'jsx' && (c.name === 'Tab' || c.name === 'TabItem'),
      )
      if (tabs.length === 0) return renderStudioNodes(node.children, scope, depth + 1)
      const buttons = []
      const panels = []
      tabs.forEach((tab, idx) => {
        const entry = items[idx]
        const fallback =
          typeof entry === 'object' && entry !== null ? (entry.label ?? entry.value) : entry
        const label = String(
          tab.props.label ?? tab.props.title ?? tab.props.value ?? fallback ?? `Tab ${idx + 1}`,
        )
        const active =
          defaultVal !== undefined ? (tab.props.value ?? label) === defaultVal : idx === defaultIdx
        buttons.push(
          `<button type="button" role="tab" class="mdx-tab-btn" data-tab-group="${groupId}" data-tab-index="${idx}" aria-selected="${active ? 'true' : 'false'}">${escapeHtml(label)}</button>`,
        )
        panels.push(
          `<div role="tabpanel" class="mdx-tab-panel" data-tab-group="${groupId}" data-tab-index="${idx}"${active ? '' : ' hidden'}>${renderStudioNodes(tab.children, scope, depth + 1)}</div>`,
        )
      })
      return `<div class="mdx-tabs" data-mdx-component="tabs"><div role="tablist" class="mdx-tab-list">${buttons.join('')}</div>${panels.join('')}</div>`
    }

    if (name === 'CodeGroup') {
      const fences = expandDynamicChildren(node.children).filter((c) => c.type === 'code-fence')
      if (fences.length === 0) return renderStudioNodes(node.children, scope, depth + 1)
      tabGroupSeq += 1
      const groupId = `mdx-codegroup-${tabGroupSeq}`
      const buttons = []
      const panels = []
      fences.forEach((fence, idx) => {
        const m = /^[ \t>]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n[ \t>]*\1[ \t]*)?$/.exec(
          fence.value.trimEnd(),
        )
        const info = (m ? m[2] : '').trim()
        const titleMatch = /(?:title|filename|file)=["']([^"']+)["']/.exec(info)
        const lang = info.split(/\s+/)[0] || `Code ${idx + 1}`
        const label = titleMatch ? titleMatch[1] : lang
        const code = m ? m[3] : fence.value
        const active = idx === 0
        buttons.push(
          `<button type="button" role="tab" class="mdx-tab-btn" data-tab-group="${groupId}" data-tab-index="${idx}" aria-selected="${active ? 'true' : 'false'}">${escapeHtml(label)}</button>`,
        )
        panels.push(
          `<div role="tabpanel" class="mdx-tab-panel" data-tab-group="${groupId}" data-tab-index="${idx}"${active ? '' : ' hidden'}><pre><code>${escapeHtml(code)}</code></pre></div>`,
        )
      })
      return `<div class="mdx-tabs" data-mdx-component="code-group"><div role="tablist" class="mdx-tab-list">${buttons.join('')}</div>${panels.join('')}</div>`
    }

    if (name === 'AccordionGroup') {
      return renderStudioNodes(node.children, scope, depth + 1)
    }

    if (
      name === 'Accordion' ||
      name === 'Details' ||
      name === 'Collapsible' ||
      name === 'Expandable'
    ) {
      const title = String(props.title ?? props.summary ?? props.label ?? 'Details')
      const openAttr = props.defaultOpen || props.open ? ' open' : ''
      return `<details class="mdx-accordion"${openAttr}><summary>${escapeHtml(title)}</summary><div class="mdx-accordion-body">${renderStudioNodes(node.children, scope, depth + 1)}</div></details>`
    }

    if (name === 'Steps') {
      const steps = expandDynamicChildren(node.children).filter(
        (c) => c.type === 'jsx' && c.name === 'Step',
      )
      const items = steps
        .map((step, idx) => {
          const num = step.props.stepNumber ?? idx + 1
          const title = String(step.props.title ?? `Step ${num}`)
          return `<div class="mdx-step"><span class="mdx-step-num">${escapeHtml(num)}</span><div class="mdx-step-title">${escapeHtml(title)}</div><div class="mdx-step-body">${renderStudioNodes(step.children, scope, depth + 1)}</div></div>`
        })
        .join('')
      return `<div class="mdx-steps" data-mdx-component="steps">${items}</div>`
    }

    if (name === 'Step') {
      const title = String(props.title ?? 'Step')
      return `<div class="mdx-step"><span class="mdx-step-num">•</span><div class="mdx-step-title">${escapeHtml(title)}</div><div class="mdx-step-body">${renderStudioNodes(node.children, scope, depth + 1)}</div></div>`
    }

    if (name === 'Cards' || name === 'CardGroup' || name === 'Columns' || name === 'Grid') {
      return `<div class="mdx-card-grid" data-mdx-component="cards">${renderStudioNodes(expandDynamicChildren(node.children), scope, depth + 1)}</div>`
    }

    if (name === 'Card' || name === 'LinkCard' || name === 'Column') {
      const title = String(props.title ?? 'Card')
      const badge = props.badge
        ? `<span class="mdx-badge">${escapeHtml(String(props.badge))}</span>`
        : ''
      const href =
        typeof props.href === 'string' && props.href
          ? `<div class="mdx-card-href">${escapeHtml(props.href)}</div>`
          : ''
      return `<div class="mdx-card"><div class="mdx-card-title"><span>${escapeHtml(title)}</span>${badge}</div><div class="mdx-card-body">${renderStudioNodes(node.children, scope, depth + 1)}</div>${href}</div>`
    }

    if (name === 'Badge' || name === 'Pill' || name === 'Tag') {
      const variant = normalizeAlertKind(props.variant ?? props.type ?? 'note').toLowerCase()
      const label =
        renderStudioNodes(node.children, scope, depth + 1, true) ||
        escapeHtml(String(props.label ?? ''))
      return `<span class="mdx-badge mdx-badge-${variant}">${label}</span>`
    }

    if (name === 'Kbd') {
      const keys =
        renderStudioNodes(node.children, scope, depth + 1, true) ||
        escapeHtml(String(props.keys ?? ''))
      return `<kbd>${keys}</kbd>`
    }

    if (name === 'FileTree') {
      return `<div class="mdx-file-tree">${renderStudioFileTree(node.children)}</div>`
    }

    if (name === 'Stat' || name === 'Metric') {
      const label = escapeHtml(String(props.label ?? props.title ?? 'Metric'))
      const value = escapeHtml(String(props.value ?? ''))
      return `<div class="mdx-stat"><span class="mdx-stat-label">${label}</span><span class="mdx-stat-value">${value}</span></div>`
    }

    if (name === 'Highlight' || name === 'Mark') {
      return `<mark>${renderStudioNodes(node.children, scope, depth + 1, true)}</mark>`
    }

    if (name === 'Tooltip') {
      const tip = String(props.tip ?? props.content ?? props.title ?? '')
      return `<span title="${escapeHtml(tip)}">${renderStudioNodes(node.children, scope, depth + 1, true)}</span>`
    }

    if (name === 'CodeBlock' || name === 'Pre') {
      const code = String(
        props.code ?? renderNodesToMarkdown(node.children, scope, depth + 1),
      ).trim()
      return `<pre><code>${escapeHtml(code)}</code></pre>`
    }

    if (name === 'Mermaid') {
      const chart = String(
        props.chart ?? renderNodesToMarkdown(node.children, scope, depth + 1),
      ).trim()
      return `<div class="mdx-card"><div class="mdx-card-title"><span>Mermaid Diagram</span></div><pre><code>${escapeHtml(chart)}</code></pre></div>`
    }

    if (name === 'Math') {
      const formula = String(
        props.formula ?? renderNodesToMarkdown(node.children, scope, depth + 1),
      ).trim()
      return props.block
        ? `<pre><code>${escapeHtml(formula)}</code></pre>`
        : `<code>${escapeHtml(formula)}</code>`
    }

    if (name === 'ParamField' || name === 'ResponseField' || name === 'Property') {
      const field = escapeHtml(String(props.path ?? props.name ?? 'param'))
      const type = props.type
        ? ` <span class="mdx-badge">${escapeHtml(String(props.type))}</span>`
        : ''
      const req = props.required ? ' <span class="mdx-badge mdx-badge-caution">required</span>' : ''
      return `<div class="mdx-card"><div class="mdx-card-title"><code>${field}</code><span>${type}${req}</span></div><div class="mdx-card-body">${renderStudioNodes(node.children, scope, depth + 1)}</div></div>`
    }

    if (name === 'YouTube' || name === 'Vimeo' || name === 'Video' || name === 'Embed') {
      const src = escapeHtml(String(props.id ?? props.src ?? props.url ?? ''))
      const title = escapeHtml(String(props.title ?? name))
      return `<div class="mdx-card"><div class="mdx-card-title"><span>${title}</span><span class="mdx-badge">Media</span></div><div class="mdx-card-href">${src}</div></div>`
    }

    if (name === 'Frame' || name === 'Figure') {
      const cap =
        props.caption || props.title
          ? `<div class="mdx-status">${escapeHtml(String(props.caption ?? props.title))}</div>`
          : ''
      return `<div class="mdx-card">${renderStudioNodes(node.children, scope, depth + 1)}${cap}</div>`
    }

    const lower = name.toLowerCase()
    if (name === lower && BLOCKED_HTML_TAGS.has(lower)) {
      return ''
    }
    if (name === lower && ALLOWED_HTML_TAGS.has(lower)) {
      if (HTML_VOID_TAGS.has(lower)) {
        if (lower === 'img' && typeof props.src === 'string' && isSafeImageUrl(props.src)) {
          const alt = typeof props.alt === 'string' ? ` alt="${escapeHtml(props.alt)}"` : ''
          return `<img src="${escapeHtml(props.src)}"${alt} />`
        }
        if (lower === 'br' || lower === 'hr') return `<${lower} />`
        return ''
      }
      const cls =
        typeof props.className === 'string' && /^[A-Za-z0-9_ -]+$/.test(props.className)
          ? ` class="${escapeHtml(props.className)}"`
          : ''
      const inlineTag = [
        'span',
        'strong',
        'em',
        'code',
        'b',
        'i',
        'small',
        'mark',
        'sub',
        'sup',
      ].includes(lower)
      return `<${lower}${cls}>${renderStudioNodes(node.children, scope, depth + 1, inlineTag)}</${lower}>`
    }

    const pills = Object.entries(props)
      .map(
        ([k, v]) =>
          `<span class="mdx-prop-pill">${escapeHtml(k)}=${escapeHtml(previewValue(v))}</span>`,
      )
      .join('')
    return `<div class="mdx-custom-component" data-mdx-custom="${escapeHtml(name)}"><div class="mdx-custom-header"><span class="mdx-custom-name">&lt;${escapeHtml(name)}&gt;</span>${pills}</div><div class="mdx-custom-body">${renderStudioNodes(node.children, scope, depth + 1)}</div></div>`
  }

  function renderStudioFileTree(children) {
    return expandDynamicChildren(children)
      .map((child) => {
        if (child.type !== 'jsx') return ''
        if (child.name === 'FileTree.Folder') {
          return `<div class="mdx-tree-folder"><strong>${escapeHtml(child.props.name ?? 'folder')}/</strong><div class="mdx-tree-children">${renderStudioFileTree(child.children)}</div></div>`
        }
        if (child.name === 'FileTree.File') {
          const cls = child.props.active ? 'mdx-tree-file mdx-tree-active' : 'mdx-tree-file'
          return `<div class="${cls}">${escapeHtml(child.props.name ?? 'file')}</div>`
        }
        return ''
      })
      .join('')
  }

  function renderStudioHtml(rawSource) {
    const doc = parseMdxDocument(rawSource)
    const fmEntries = Object.entries(doc.frontMatter.data)
    const fmHtml =
      doc.frontMatter.yaml !== null && fmEntries.length > 0
        ? `<dl class="mdx-frontmatter-card">${fmEntries
            .map(
              ([k, v]) =>
                `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v ?? ''))}</dd>`,
            )
            .join('')}</dl>`
        : ''
    const bodyHtml = renderStudioNodes(doc.nodes, doc.scope, 0)
    const highlighted = highlightMdx(rawSource)
    const compiledMarkdown = compileMdxToMarkdown(rawSource, { preserveFrontMatter: true })
    return {
      previewHtml: `<div class="mdx-preview-root">${fmHtml}${bodyHtml}</div>`,
      highlightedHtml: highlighted.html,
      compiledMarkdown,
      inspection: {
        title: extractTitle(rawSource),
        frontMatter: doc.frontMatter.yaml !== null ? doc.frontMatter.data : null,
        imports: doc.imports,
        exports: doc.exports,
        components: doc.components,
        diagnostics: doc.diagnostics,
      },
    }
  }

  function transformProseOutsideInlineCode(line, fn) {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (line[i] === '`') {
        const end = skipInlineCodeSpan(line, i)
        if (end > i) {
          out += line.slice(i, end)
          i = end
          continue
        }
      }
      let nextTick = line.indexOf('`', i)
      if (nextTick < 0) nextTick = line.length
      out += fn(line.slice(i, nextTick))
      i = nextTick
    }
    return out
  }

  function convertChunkToMdx(chunk) {
    let text = chunk.replace(/<!--([\s\S]*?)-->/g, (_, inner) => `{/*${inner}*/}`)
    text = text
      .split('\n')
      .map((line) =>
        transformProseOutsideInlineCode(line, (seg) => {
          let s = seg
          s = s.replace(
            /<(area|base|br|col|hr|img|input|meta|source|wbr)(\b[^>]*?)?(?<!\/)>/gi,
            (_, tag, attrs = '') => `<${tag.toLowerCase()}${attrs} />`,
          )
          s = s.replace(/(<[a-z][a-z0-9-]*\b[^>]*?)\bclass=/g, '$1className=')
          s = s.replace(/(<[a-z][a-z0-9-]*\b[^>]*?)\bfor=/g, '$1htmlFor=')
          s = s.replace(/<(?=[0-9=])/g, '&lt;')
          return s
        }),
      )
      .join('\n')
    return text
  }

  function convertMarkdownToMdx(rawSource) {
    const fm = parseFrontMatter(rawSource)
    const lines = fm.body.split('\n')
    const out = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      const fenceMatch = /^[ \t>]*(`{3,}|~{3,})/.exec(line)
      if (fenceMatch) {
        const marker = fenceMatch[1][0]
        const len = fenceMatch[1].length
        out.push(line)
        i += 1
        const closeRe = new RegExp(`^[ \\t>]*${marker}{${len},}[ \\t]*$`)
        while (i < lines.length) {
          out.push(lines[i])
          if (closeRe.test(lines[i])) {
            i += 1
            break
          }
          i += 1
        }
        continue
      }

      const alertHeader = /^>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i.exec(line)
      if (alertHeader) {
        const kind = alertHeader[1].toLowerCase()
        i += 1
        const alertLines = []
        while (i < lines.length && lines[i].startsWith('>')) {
          alertLines.push(lines[i].replace(/^>[ \t]?/, ''))
          i += 1
        }
        const convertedInner = convertChunkToMdx(alertLines.join('\n')).trim()
        const indented = convertedInner
          .split('\n')
          .map((l) => (l ? `  ${l}` : ''))
          .join('\n')
        out.push(`<Callout type="${kind}">\n${indented}\n</Callout>`)
        continue
      }

      out.push(convertChunkToMdx(line))
      i += 1
    }

    const body = out.join('\n')
    return fm.yaml !== null ? `---\n${fm.yaml}\n---\n${body}` : body
  }

  function unwrapPreviewFence(body) {
    const trimmed = body.trim()
    const match = /^(`{3,})mdx[ \t]*\n([\s\S]*?)\n\1[ \t]*$/.exec(trimmed)
    return match ? match[2] : null
  }

  function togglePreviewBlock(rawSource) {
    const fm = parseFrontMatter(rawSource)
    const unwrapped = unwrapPreviewFence(fm.body)
    if (unwrapped !== null) {
      const prefix = fm.yaml !== null ? `---\n${fm.yaml}\n---\n\n` : ''
      return { wrapped: false, markdown: `${prefix}${unwrapped}` }
    }
    const cleanBody = fm.body.replace(/^\n+/, '').replace(/\n+$/, '')
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(cleanBody) + 1))
    const prefix = fm.yaml !== null ? `---\n${fm.yaml}\n---\n\n` : ''
    return {
      wrapped: true,
      markdown: `${prefix}${fence}mdx\n${cleanBody}\n${fence}`,
    }
  }

  function convertImport(format, file) {
    const normalized = normalizeText(file?.text ?? '')
    const title = extractTitle(normalized, file?.name ?? '')
    if (format === 'mdx-markdown') {
      const fm = parseFrontMatter(normalized)
      const compiledBody = compileMdxToMarkdown(normalized, { includeFrontMatterSummary: false })
      const markdown =
        fm.yaml !== null ? `---\n${fm.yaml}\n---\n\n${compiledBody}\n` : `${compiledBody}\n`
      return { title, markdown }
    }
    return { title, markdown: normalized }
  }

  function formatYamlTitle(title) {
    if (/^[A-Za-z0-9 _.,()-]+$/.test(title) && title.trim() === title) return title
    return JSON.stringify(title)
  }

  function convertExport(_format, note) {
    const raw = normalizeText(note?.markdown ?? '')
    const noteTitle = clipTitle(note?.title ?? '')
    const fm = parseFrontMatter(raw)
    const unwrapped = unwrapPreviewFence(fm.body)
    const unwrappedBody = unwrapped ?? fm.body
    const sep = unwrapped !== null ? '\n\n' : '\n'
    const rebuilt = fm.yaml !== null ? `---\n${fm.yaml}\n---${sep}${unwrappedBody}` : unwrappedBody
    const inferred = extractTitle(rebuilt, '')
    let out = rebuilt
    if (noteTitle && inferred !== noteTitle && fm.yaml === null) {
      out = `---\ntitle: ${formatYamlTitle(noteTitle)}\n---\n\n${unwrappedBody.replace(/^\n+/, '')}`
    }
    return `${out.replace(/\n+$/, '')}\n`
  }

  const SNIPPETS = Object.freeze({
    callout: '\n<Callout type="tip" title="Tip">\n  Write your MDX note here.\n</Callout>\n',
    tabs: '\n<Tabs items={["Overview", "Details"]} defaultIndex={0}>\n  <Tab value="Overview">\n    First tab content.\n  </Tab>\n  <Tab value="Details">\n    Second tab content.\n  </Tab>\n</Tabs>\n',
    steps:
      '\n<Steps>\n  <Step title="First Step">\n    Describe the first action.\n  </Step>\n  <Step title="Second Step">\n    Describe the next action.\n  </Step>\n</Steps>\n',
  })

  const api = Object.freeze({
    parseFrontMatter,
    extractTitle,
    evaluateExpression,
    inspectMdx,
    highlightMdx,
    compileMdxToMarkdown,
    renderPreviewBlock,
    renderStudioHtml,
    convertImport,
    convertExport,
    convertMarkdownToMdx,
    togglePreviewBlock,
  })

  Object.defineProperty(globalThis, 'DevotMdx', {
    value: api,
    configurable: false,
    writable: false,
  })

  if (typeof globalThis.devot !== 'object' || globalThis.devot === null) return
  const devot = globalThis.devot

  function ensureStylesheet() {
    if (typeof document !== 'object' || document === null) return
    if (document.getElementById('mdx-studio-stylesheet')) return
    const link = document.createElement('link')
    link.id = 'mdx-studio-stylesheet'
    link.rel = 'stylesheet'
    link.href = SCRIPT_URL ? new URL('panel.css', SCRIPT_URL).href : '../panel.css'
    document.head.appendChild(link)
  }

  let activeView = 'preview'
  let studioNote = { title: '', markdown: '' }

  function renderInspectorHtml(inspection) {
    const importsList =
      inspection.imports.length === 0
        ? '<li><span>None</span></li>'
        : inspection.imports
            .map(
              (imp) =>
                `<li><code>${escapeHtml(imp.specifiers.join(', ') || imp.source)}</code><span>L${imp.line}</span></li>`,
            )
            .join('')

    const exportsList =
      inspection.exports.length === 0
        ? '<li><span>None</span></li>'
        : inspection.exports
            .map(
              (exp) =>
                `<li><code>${escapeHtml(exp.name)}</code><span>${escapeHtml(exp.valuePreview)} · L${exp.line}</span></li>`,
            )
            .join('')

    const componentsList =
      inspection.components.length === 0
        ? '<li><span>None</span></li>'
        : inspection.components
            .map(
              (comp) =>
                `<li><code>&lt;${escapeHtml(comp.name)}&gt;</code><span>${comp.count}x · L${comp.lines.join(',')}</span></li>`,
            )
            .join('')

    const diagHtml =
      inspection.diagnostics.length === 0
        ? '<p class="mdx-status">No MDX syntax issues found.</p>'
        : `<ul class="mdx-diag-list">${inspection.diagnostics
            .map(
              (d) =>
                `<li class="mdx-diag-item mdx-diag-${d.severity}"><span class="mdx-diag-loc">L${d.line}:${d.column} [${escapeHtml(d.code)}]</span>${escapeHtml(d.message)}</li>`,
            )
            .join('')}</ul>`

    return `<div class="mdx-inspector-grid"><div class="mdx-inspector-box"><h3>Components (${inspection.components.length})</h3><ul class="mdx-inspector-list">${componentsList}</ul></div><div class="mdx-inspector-box"><h3>Imports (${inspection.imports.length})</h3><ul class="mdx-inspector-list">${importsList}</ul></div><div class="mdx-inspector-box"><h3>Exports (${inspection.exports.length})</h3><ul class="mdx-inspector-list">${exportsList}</ul></div></div><div class="mdx-inspector-box"><h3>Diagnostics (${inspection.diagnostics.length})</h3>${diagHtml}</div>`
  }

  function mountStudio(note, statusMessage = '') {
    if (typeof document !== 'object' || document === null) return
    ensureStylesheet()
    studioNote = note ?? { title: '', markdown: '' }
    const rendered = renderStudioHtml(studioNote.markdown)
    const diagCount = rendered.inspection.diagnostics.length

    const views = [
      { id: 'preview', label: 'Preview' },
      { id: 'highlight', label: 'Highlighted MDX' },
      { id: 'markdown', label: 'Compiled Markdown' },
      { id: 'inspector', label: `Inspector (${diagCount})` },
    ]

    const buttonsHtml = views
      .map(
        (v) =>
          `<button type="button" role="tab" class="mdx-seg-btn" data-studio-view="${v.id}" aria-selected="${activeView === v.id ? 'true' : 'false'}">${escapeHtml(v.label)}</button>`,
      )
      .join('')

    document.body.innerHTML = `<div class="mdx-studio"><div class="mdx-toolbar"><div role="tablist" aria-label="MDX Studio views" class="mdx-segmented">${buttonsHtml}</div><div class="mdx-actions"><span class="mdx-status" id="mdx-studio-status">${escapeHtml(statusMessage)}</span><button type="button" class="mdx-btn" data-studio-action="refresh">Refresh</button><button type="button" class="mdx-btn" data-studio-action="fix-mdx">Convert to MDX</button><button type="button" class="mdx-btn mdx-btn-primary" data-studio-action="apply-markdown">Compile to Markdown</button></div></div><div class="mdx-stage" data-stage="preview"${activeView === 'preview' ? '' : ' hidden'}>${studioNote.markdown.trim() ? rendered.previewHtml : '<div class="mdx-empty">This note is empty.</div>'}</div><div class="mdx-stage" data-stage="highlight"${activeView === 'highlight' ? '' : ' hidden'}>${rendered.highlightedHtml}</div><div class="mdx-stage" data-stage="markdown"${activeView === 'markdown' ? '' : ' hidden'}><pre><code>${escapeHtml(rendered.compiledMarkdown)}</code></pre></div><div class="mdx-stage" data-stage="inspector"${activeView === 'inspector' ? '' : ' hidden'}>${renderInspectorHtml(rendered.inspection)}</div></div>`
  }

  if (typeof document === 'object' && document !== null) {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target) return

      const viewBtn = target.closest('[data-studio-view]')
      if (viewBtn) {
        activeView = viewBtn.getAttribute('data-studio-view') || 'preview'
        for (const btn of document.querySelectorAll('[data-studio-view]')) {
          btn.setAttribute('aria-selected', btn === viewBtn ? 'true' : 'false')
        }
        for (const stage of document.querySelectorAll('[data-stage]')) {
          if (stage.getAttribute('data-stage') === activeView) stage.removeAttribute('hidden')
          else stage.setAttribute('hidden', '')
        }
        return
      }

      const tabBtn = target.closest('.mdx-tab-btn')
      if (tabBtn) {
        const group = tabBtn.getAttribute('data-tab-group')
        const idx = tabBtn.getAttribute('data-tab-index')
        for (const btn of document.querySelectorAll(`.mdx-tab-btn[data-tab-group="${group}"]`)) {
          btn.setAttribute('aria-selected', btn === tabBtn ? 'true' : 'false')
        }
        for (const panel of document.querySelectorAll(
          `.mdx-tab-panel[data-tab-group="${group}"]`,
        )) {
          if (panel.getAttribute('data-tab-index') === idx) panel.removeAttribute('hidden')
          else panel.setAttribute('hidden', '')
        }
        return
      }

      const actionBtn = target.closest('[data-studio-action]')
      if (actionBtn) {
        const action = actionBtn.getAttribute('data-studio-action')
        void handleStudioAction(action)
      }
    })
  }

  async function handleStudioAction(action) {
    try {
      const current = await devot.note.read()
      if (!current) {
        mountStudio({ title: '', markdown: '' }, 'No open note')
        return
      }
      if (action === 'refresh') {
        mountStudio(current, 'Refreshed')
        return
      }
      if (action === 'fix-mdx') {
        const next = convertMarkdownToMdx(current.markdown)
        if (next !== current.markdown) {
          await devot.note.replace({ base: current.markdown, markdown: next })
        }
        mountStudio({ title: current.title, markdown: next }, 'Converted to MDX')
        return
      }
      if (action === 'apply-markdown') {
        const fm = parseFrontMatter(current.markdown)
        const compiled = compileMdxToMarkdown(current.markdown, {
          includeFrontMatterSummary: false,
        })
        const next = fm.yaml !== null ? `---\n${fm.yaml}\n---\n\n${compiled}\n` : `${compiled}\n`
        if (next !== current.markdown) {
          await devot.note.replace({ base: current.markdown, markdown: next })
        }
        mountStudio({ title: current.title, markdown: next }, 'Compiled to Markdown')
      }
    } catch {
      const statusEl = document.getElementById('mdx-studio-status')
      if (statusEl) statusEl.textContent = 'Update failed'
    }
  }

  async function transformOpenNote(transform) {
    const note = await devot.note.read()
    if (!note) return
    const next = transform(note.markdown)
    if (next !== note.markdown) {
      await devot.note.replace({ base: note.markdown, markdown: next })
    }
  }

  devot.commands.handle('studio', async () => {
    const note = await devot.note.read()
    activeView = 'preview'
    mountStudio(note ?? { title: '', markdown: '' })
    await devot.ui.show({ height: 520 })
  })

  devot.commands.handle('toggle-preview', async () => {
    await transformOpenNote((md) => togglePreviewBlock(md).markdown)
  })

  devot.commands.handle('compile-markdown', async () => {
    await transformOpenNote((md) => {
      const fm = parseFrontMatter(md)
      const compiled = compileMdxToMarkdown(md, { includeFrontMatterSummary: false })
      return fm.yaml !== null ? `---\n${fm.yaml}\n---\n\n${compiled}\n` : `${compiled}\n`
    })
  })

  devot.commands.handle('convert-to-mdx', async () => {
    await transformOpenNote((md) => convertMarkdownToMdx(md))
  })

  async function insertSnippet(snippet, wrapSelection) {
    if (typeof devot.note.selection === 'function' && typeof devot.note.insert === 'function') {
      try {
        const sel = await devot.note.selection()
        if (sel && typeof sel.text === 'string') {
          if (sel.text.trim() !== '' && wrapSelection) {
            await devot.note.insert(wrapSelection(sel.text), { replacing: sel.text })
          } else {
            await devot.note.insert(snippet.trim(), { replacing: sel.text })
          }
          return
        }
      } catch {
        // Falls back to appending when the editor has no active selection.
      }
    }
    await transformOpenNote((md) => `${md.replace(/\n*$/, '\n')}${snippet}`)
  }

  devot.commands.handle('insert-callout', async () => {
    await insertSnippet(
      SNIPPETS.callout,
      (selected) => `<Callout type="tip" title="Tip">\n  ${selected}\n</Callout>`,
    )
  })

  devot.commands.handle('insert-tabs', async () => {
    await insertSnippet(SNIPPETS.tabs)
  })

  devot.commands.handle('insert-steps', async () => {
    await insertSnippet(SNIPPETS.steps)
  })

  devot.preview.handle('mdx', (source) => renderPreviewBlock(source, 'mdx'))
  devot.preview.handle('mdx-code', (source) => renderPreviewBlock(source, 'mdx-code'))
  devot.preview.handle('mdx-source', (source) => renderPreviewBlock(source, 'mdx-source'))

  devot.importer.handle('mdx', (file) => convertImport('mdx', file))
  devot.importer.handle('mdx-markdown', (file) => convertImport('mdx-markdown', file))

  devot.exporter.handle('mdx', (note) => convertExport('mdx', note))
})()
