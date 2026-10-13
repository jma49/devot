import { describe, expect, it } from 'vitest'
import { previewTexts } from '../../../../tests/support/preview-html'
import {
  cellAt,
  deleteColumn,
  deleteRow,
  displayWidth,
  escapedAt,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseAlign,
  parseTable,
  printTable,
  setAlign,
  splitRow,
  type Table,
} from './table'

// Wide characters are built from code points, so this file stays ASCII.
const ch = (...points: number[]) => String.fromCodePoint(...points)
const ZHONG = ch(0x4e2d) // a CJK ideograph
const WEN = ch(0x6587)
const HANGUL = ch(0xd55c)
const FULLWIDTH_A = ch(0xff21)
const SMILE = ch(0x1f600) // an emoji
const FAMILY = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) // one emoji grapheme
const FLAG = ch(0x1f1fa, 0x1f1f8) // a flag: two regional indicators
const HEART = ch(0x2764, 0xfe0f) // a text symbol shown as an emoji
const E_ACUTE = `e${ch(0x301)}` // e and a combining accent
const ZERO_WIDTH_SPACE = ch(0x200b)

const texts = (line: string) => splitRow(line).map((c) => c.text)

describe('splitRow', () => {
  it('reads cells with or without the outer pipes', () => {
    expect(texts('| a | b |')).toEqual(['a', 'b'])
    expect(texts('a | b')).toEqual(['a', 'b'])
    expect(texts('| a | b')).toEqual(['a', 'b'])
    expect(texts('a | b |')).toEqual(['a', 'b'])
    expect(texts('  |a|b|  ')).toEqual(['a', 'b'])
  })

  it('keeps empty cells', () => {
    expect(texts('| | b |')).toEqual(['', 'b'])
    expect(texts('|| b')).toEqual(['', 'b'])
    expect(texts('| a | |')).toEqual(['a', ''])
    expect(texts('|   |')).toEqual([''])
    expect(texts('|')).toEqual([])
  })

  it('keeps escaped pipes in their cell', () => {
    expect(texts('| a \\| b | c |')).toEqual(['a \\| b', 'c'])
    expect(texts('a \\|')).toEqual(['a \\|'])
    // An escaped backslash does not escape the pipe after it.
    expect(texts('| a \\\\| b |')).toEqual(['a \\\\', 'b'])
  })

  it('splits inline code at a pipe unless it is escaped, as GFM does', () => {
    // A code span does not protect a pipe: GFM (and the preview) split the
    // row first, so `x|y` is two cells. Escaping keeps it whole.
    expect(texts('| `x|y` | z |')).toEqual(['`x', 'y`', 'z'])
    expect(texts('| `x\\|y` | z |')).toEqual(['`x\\|y`', 'z'])
  })

  it('trims spaces and tabs only, as GFM does', () => {
    const IDEOGRAPHIC = ch(0x3000)
    const NBSP = ch(0xa0)
    expect(texts(`| ${IDEOGRAPHIC}a${IDEOGRAPHIC} | ${NBSP}b${NBSP} |`)).toEqual([
      `${IDEOGRAPHIC}a${IDEOGRAPHIC}`,
      `${NBSP}b${NBSP}`,
    ])
    expect(texts(`|\t ${IDEOGRAPHIC}a ${IDEOGRAPHIC}\t|`)).toEqual([
      `${IDEOGRAPHIC}a ${IDEOGRAPHIC}`,
    ])
    // A cell of padding alone is not empty.
    expect(texts(`| ${IDEOGRAPHIC} |`)).toEqual([IDEOGRAPHIC])
    expect(splitRow(`| ${NBSP}x |`)).toEqual([{ text: `${NBSP}x`, from: 1, to: 5, textFrom: 2 }])
  })

  it('says where each cell and its text lie in the line', () => {
    expect(splitRow('| ab |  c|')).toEqual([
      { text: 'ab', from: 1, to: 5, textFrom: 2 },
      { text: 'c', from: 6, to: 9, textFrom: 8 },
    ])
    expect(splitRow('a|b')).toEqual([
      { text: 'a', from: 0, to: 1, textFrom: 0 },
      { text: 'b', from: 2, to: 3, textFrom: 2 },
    ])
  })
})

describe('cellAt', () => {
  it('finds the cell a cursor is in, and its place in the text', () => {
    const line = '| ab | cd |'
    expect(cellAt(line, 0)).toEqual({ column: 0, offset: 0, past: false })
    expect(cellAt(line, 2)).toEqual({ column: 0, offset: 0, past: false })
    expect(cellAt(line, 3)).toEqual({ column: 0, offset: 1, past: false })
    // Just before a pipe is the cell on its left, just after it the one on its right.
    expect(cellAt(line, 5)).toEqual({ column: 0, offset: 2, past: false })
    expect(cellAt(line, 6)).toEqual({ column: 1, offset: 0, past: false })
    expect(cellAt(line, 9)).toEqual({ column: 1, offset: 2, past: false })
    // After the closing pipe: the last cell, past the row.
    expect(cellAt(line, 11)).toEqual({ column: 1, offset: 2, past: true })
    expect(cellAt('a | b', 5)).toEqual({ column: 1, offset: 1, past: false })
    expect(cellAt('|', 1)).toEqual({ column: 0, offset: 0, past: false })
  })
})

describe('escapedAt', () => {
  it('tells a pipe after an odd run of backslashes', () => {
    expect(escapedAt('| a', 3)).toBe(false)
    expect(escapedAt('| a\\', 4)).toBe(true)
    expect(escapedAt('| a\\\\', 5)).toBe(false)
    expect(escapedAt('\\\\\\', 3)).toBe(true)
    expect(escapedAt('', 0)).toBe(false)
  })
})

describe('parseAlign', () => {
  it('reads the alignment of a delimiter cell', () => {
    expect(parseAlign('---')).toBe('none')
    expect(parseAlign('-')).toBe('none')
    expect(parseAlign(':--')).toBe('left')
    expect(parseAlign('--:')).toBe('right')
    expect(parseAlign(':-:')).toBe('center')
    expect(parseAlign(' :---: ')).toBe('center')
    expect(parseAlign('abc')).toBeNull()
    expect(parseAlign('')).toBeNull()
    expect(parseAlign(':')).toBeNull()
    expect(parseAlign('-:-')).toBeNull()
    // Only spaces and tabs may surround a delimiter.
    expect(parseAlign(`${ch(0x3000)}---`)).toBeNull()
    expect(parseAlign('\t---\t')).toBe('none')
  })
})

describe('parseTable', () => {
  it('reads the header, the alignments and the rows', () => {
    expect(parseTable(['| a | b | c | d |', '|---|:--|--:|:-:|', '| 1 | 2 | 3 | 4 |'])).toEqual({
      header: ['a', 'b', 'c', 'd'],
      align: ['none', 'left', 'right', 'center'],
      rows: [['1', '2', '3', '4']],
    })
  })

  it('pads ragged rows to the widest row, losing no cell', () => {
    expect(parseTable(['a | b', '- | -', '1', '1 | 2 | 3', '|'])).toEqual({
      header: ['a', 'b', ''],
      align: ['none', 'none', 'none'],
      rows: [
        ['1', '', ''],
        ['1', '2', '3'],
        ['', '', ''],
      ],
    })
  })

  it('keeps escaped pipes as written', () => {
    expect(parseTable(['| a \\| b |', '| --- |', '| `c\\|d` |'])).toEqual({
      header: ['a \\| b'],
      align: ['none'],
      rows: [['`c\\|d`']],
    })
  })

  it('is null without a delimiter row', () => {
    expect(parseTable(['| a |'])).toBeNull()
    expect(parseTable(['| a |', '| b |'])).toBeNull()
    expect(parseTable(['|', '|'])).toBeNull()
  })
})

describe('displayWidth', () => {
  it('counts wide characters twice', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('')).toBe(0)
    expect(displayWidth(ZHONG + WEN)).toBe(4)
    expect(displayWidth(`a${ZHONG}b`)).toBe(4)
    expect(displayWidth(HANGUL)).toBe(2)
    expect(displayWidth(FULLWIDTH_A)).toBe(2)
  })

  it('counts an emoji twice, however many code points it takes', () => {
    expect(displayWidth(SMILE)).toBe(2)
    expect(displayWidth(FAMILY)).toBe(2)
    expect(displayWidth(FLAG)).toBe(2)
    expect(displayWidth(HEART)).toBe(2)
  })

  it('counts combining marks and zero-width characters as nothing', () => {
    expect(displayWidth(E_ACUTE)).toBe(1)
    expect(displayWidth(`a${ZERO_WIDTH_SPACE}b`)).toBe(2)
  })
})

describe('a table with padding that is text', () => {
  it('prints the cells as read, padding kept', () => {
    const IDEOGRAPHIC = ch(0x3000)
    const NBSP = ch(0xa0)
    const read = parseTable([
      `| ${IDEOGRAPHIC}a | b${NBSP} |`,
      '|---|---|',
      `| ${IDEOGRAPHIC} | ${NBSP} |`,
    ])
    expect(read).toEqual({
      header: [`${IDEOGRAPHIC}a`, `b${NBSP}`],
      align: ['none', 'none'],
      rows: [[IDEOGRAPHIC, NBSP]],
    })
    const printed = printTable(read!).lines
    expect(printed[0]).toContain(`${IDEOGRAPHIC}a`)
    expect(printed[0]).toContain(`b${NBSP}`)
    expect(printed[2]).toContain(IDEOGRAPHIC)
    // Reading what was printed gives the same cells.
    expect(parseTable(printed)).toEqual(read)
  })

  it('reads as the preview reads it', async () => {
    const IDEOGRAPHIC = ch(0x3000)
    const NBSP = ch(0xa0)
    const md = `| h |\n|---|\n| ${IDEOGRAPHIC}x${NBSP} |`
    expect(await previewTexts(md, 'td')).toEqual([`${IDEOGRAPHIC}x${NBSP}`])
    expect(parseTable(md.split('\n'))?.rows).toEqual([[`${IDEOGRAPHIC}x${NBSP}`]])
  })
})

describe('printTable', () => {
  const table = (header: string[], align: Table['align'], rows: string[][]): Table => ({
    header,
    align,
    rows,
  })

  it('pads every column to its widest cell, three at least', () => {
    expect(printTable(table(['a', 'bb'], ['none', 'none'], [['long cell', 'x']])).lines).toEqual([
      '| a         | bb  |',
      '| --------- | --- |',
      '| long cell | x   |',
    ])
  })

  it('keeps the alignment markers and aligns the cells by them', () => {
    expect(
      printTable(
        table(
          ['left', 'right', 'center', 'none'],
          ['left', 'right', 'center', 'none'],
          [['a', 'b', 'c', 'd']],
        ),
      ).lines,
    ).toEqual([
      '| left | right | center | none |',
      '| :--- | ----: | :----: | ---- |',
      '| a    |     b |   c    | d    |',
    ])
  })

  it('pads by display width', () => {
    const lines = printTable(
      table(
        ['name', 'x'],
        ['none', 'right'],
        [
          [ZHONG + WEN, SMILE],
          ['ab', 'abc'],
        ],
      ),
    ).lines
    expect(lines).toEqual([
      '| name |   x |',
      '| ---- | --: |',
      `| ${ZHONG}${WEN} |  ${SMILE} |`,
      '| ab   | abc |',
    ])
    expect(lines.map(displayWidth)).toEqual([14, 14, 14, 14])
  })

  it('prints escaped pipes as written', () => {
    expect(printTable(table(['a \\| b'], ['none'], [['`x\\|y`']])).lines).toEqual([
      '| a \\| b |',
      '| ------ |',
      '| `x\\|y` |',
    ])
  })

  it('says where each cell text lies in the printed lines', () => {
    const printed = printTable(table(['a', 'b'], ['none', 'right'], [['xyz', 'c']]))
    expect(printed.lines).toEqual(['| a   |   b |', '| --- | --: |', '| xyz |   c |'])
    expect(printed.cells).toEqual([
      [
        { from: 2, to: 3 },
        { from: 10, to: 11 },
      ],
      [
        { from: 2, to: 5 },
        { from: 8, to: 11 },
      ],
      [
        { from: 2, to: 5 },
        { from: 10, to: 11 },
      ],
    ])
  })

  it('formats a parsed ragged table and reads back the same', () => {
    const parsed = parseTable(['a|b', ':-|-:', '1', '1|2|3'])!
    const lines = printTable(parsed).lines
    expect(lines).toEqual([
      '| a   |   b |     |',
      '| :-- | --: | --- |',
      '| 1   |     |     |',
      '| 1   |   2 | 3   |',
    ])
    expect(parseTable(lines)).toEqual(parsed)
  })
})

describe('table edits', () => {
  const base: Table = {
    header: ['h1', 'h2'],
    align: ['left', 'right'],
    rows: [
      ['a', 'b'],
      ['c', 'd'],
    ],
  }

  it('inserts and deletes rows', () => {
    expect(insertRow(base, 0).rows).toEqual([
      ['', ''],
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(insertRow(base, 2).rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['', ''],
    ])
    expect(deleteRow(base, 0).rows).toEqual([['c', 'd']])
    expect(deleteRow(base, 1).rows).toEqual([['a', 'b']])
  })

  it('moves rows', () => {
    expect(moveRow(base, 1, 0).rows).toEqual([
      ['c', 'd'],
      ['a', 'b'],
    ])
    expect(moveRow(base, 0, 1).rows).toEqual([
      ['c', 'd'],
      ['a', 'b'],
    ])
    expect(moveRow(base, 0, 0)).toEqual(base)
  })

  it('inserts and deletes columns with their alignment', () => {
    expect(insertColumn(base, 1)).toEqual({
      header: ['h1', '', 'h2'],
      align: ['left', 'none', 'right'],
      rows: [
        ['a', '', 'b'],
        ['c', '', 'd'],
      ],
    })
    expect(insertColumn(base, 2).header).toEqual(['h1', 'h2', ''])
    expect(deleteColumn(base, 0)).toEqual({
      header: ['h2'],
      align: ['right'],
      rows: [['b'], ['d']],
    })
  })

  it('moves columns with their alignment', () => {
    expect(moveColumn(base, 0, 1)).toEqual({
      header: ['h2', 'h1'],
      align: ['right', 'left'],
      rows: [
        ['b', 'a'],
        ['d', 'c'],
      ],
    })
  })

  it('sets a column alignment', () => {
    expect(setAlign(base, 1, 'center').align).toEqual(['left', 'center'])
    expect(setAlign(base, 0, 'none').align).toEqual(['none', 'right'])
  })

  it('never changes the table it is given', () => {
    const before = JSON.stringify(base)
    insertRow(base, 1)
    deleteRow(base, 0)
    moveRow(base, 0, 1)
    insertColumn(base, 0)
    deleteColumn(base, 1)
    moveColumn(base, 1, 0)
    setAlign(base, 0, 'center')
    expect(JSON.stringify(base)).toBe(before)
  })
})
