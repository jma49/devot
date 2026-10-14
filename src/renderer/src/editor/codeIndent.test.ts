import { describe, expect, it } from 'vitest'
import { blockUnit, codeStyle, nextLine } from './codeIndent'

const next = (info: string, unit: string, before: string, after = '') =>
  nextLine(codeStyle(info), unit, before, after)

describe('codeStyle', () => {
  it('knows a language by its name or an alias, and treats the unknown as brace', () => {
    expect(codeStyle('py')).toEqual({ family: 'python', unit: '    ' })
    expect(codeStyle('Python title="x"')).toEqual({ family: 'python', unit: '    ' })
    expect(codeStyle('go').unit).toBe('\t')
    expect(codeStyle('ts').family).toBe('brace')
    expect(codeStyle('yml').family).toBe('yaml')
    expect(codeStyle('sh').family).toBe('shell')
    expect(codeStyle('Makefile').unit).toBe('\t')
    expect(codeStyle('').family).toBe('brace')
    expect(codeStyle('nosuchlang').family).toBe('brace')
  })
})

describe('blockUnit', () => {
  it('reads a tab or the smallest run of spaces from the indented lines', () => {
    expect(blockUnit(['a', '\tb'])).toBe('\t')
    expect(blockUnit(['a:', '    b', '        c'])).toBe('    ')
    expect(blockUnit(['a', '  b', '    c'])).toBe('  ')
    expect(blockUnit(['a', '', 'b'])).toBeUndefined()
    expect(blockUnit(['a', ' b'])).toBeUndefined()
  })
})

describe('nextLine', () => {
  it('keeps the indent of a plain line', () => {
    expect(next('js', '  ', '    foo()')).toEqual({ indent: '    ' })
    expect(next('py', '    ', '\tx = 1')).toEqual({ indent: '\t' })
    expect(next('js', '  ', '   ')).toEqual({ indent: '   ' })
  })

  it('opens a level after a bracket, and splits a bracket pair', () => {
    expect(next('js', '  ', 'if (a) {')).toEqual({ indent: '  ' })
    expect(next('go', '\t', '\tfunc() {', '}')).toEqual({ indent: '\t\t', closing: '}' })
    expect(next('rust', '    ', 'let v = vec![', '];')).toEqual({ indent: '    ', closing: ']' })
    expect(next('py', '    ', 'xs = [')).toEqual({ indent: '    ' })
  })

  it('opens a level after a colon in Python, not inside a comment or string', () => {
    expect(next('py', '    ', 'def f(x):')).toEqual({ indent: '    ' })
    expect(next('py', '    ', '    for x in xs:  # loop')).toEqual({ indent: '        ' })
    expect(next('py', '    ', 'x = 1  # note:')).toEqual({ indent: '' })
    expect(next('py', '    ', "s = 'a:'")).toEqual({ indent: '' })
    expect(next('js', '  ', 'case 1:')).toEqual({ indent: '' })
  })

  it('goes one level out after return, pass, break, continue or raise in Python', () => {
    expect(next('py', '    ', '        return x')).toEqual({ indent: '    ' })
    expect(next('py', '    ', '    pass')).toEqual({ indent: '' })
    expect(next('py', '    ', 'returned = 1')).toEqual({ indent: '' })
    expect(next('js', '  ', '  return x')).toEqual({ indent: '  ' })
  })

  it('opens a level after a YAML key or a bare list dash', () => {
    expect(next('yaml', '  ', 'jobs:')).toEqual({ indent: '  ' })
    expect(next('yaml', '  ', '  name: build')).toEqual({ indent: '  ' })
    expect(next('yaml', '  ', '  steps:  # all')).toEqual({ indent: '    ' })
  })

  it('opens a level after the keywords of Ruby, Lua and shell blocks', () => {
    expect(next('ruby', '  ', 'items.each do |i|')).toEqual({ indent: '  ' })
    expect(next('ruby', '  ', 'def greet(name)')).toEqual({ indent: '  ' })
    expect(next('ruby', '  ', 'def x; 1; end')).toEqual({ indent: '' })
    expect(next('lua', '  ', 'local function f(a)')).toEqual({ indent: '  ' })
    expect(next('lua', '  ', 'if a then')).toEqual({ indent: '  ' })
    expect(next('sh', '  ', 'for f in *; do')).toEqual({ indent: '  ' })
    expect(next('sh', '  ', 'if [ -f x ]; then')).toEqual({ indent: '  ' })
    expect(next('sh', '  ', 'echo done')).toEqual({ indent: '' })
  })

  it('opens a level after an open tag and splits a tag pair', () => {
    expect(next('html', '  ', '<div class="a">', '</div>')).toEqual({
      indent: '  ',
      closing: '</div>',
    })
    expect(next('html', '  ', '  <ul>')).toEqual({ indent: '    ' })
    expect(next('html', '  ', '<br>')).toEqual({ indent: '' })
    expect(next('html', '  ', '<img src="x" />')).toEqual({ indent: '' })
    expect(next('html', '  ', '<p>text</p>')).toEqual({ indent: '' })
  })
})
