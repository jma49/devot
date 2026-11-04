import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { inlineUiStrings } from '../support/inline-strings'

// UI text comes from the i18n catalog by key (CLAUDE.md), never written into a component.
const components = () =>
  listFiles('.', 'src/renderer/src').filter(
    (file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file),
  )

it('no component writes user-facing words inline', () => {
  const files = components()
  expect(files.length).toBeGreaterThan(50)
  const offenders = files.flatMap((file) =>
    inlineUiStrings(file, readFileSync(file, 'utf8')).map(
      ({ line, text }) => `${file}:${line}: ${text}`,
    ),
  )
  expect(offenders).toEqual([])
})

it('the check catches words between tags and in spoken attributes', () => {
  const inline = [
    '<p>Saved</p>',
    '<p>{count} notes</p>',
    '<button aria-label="Close" />',
    "<input placeholder={'Search'} />",
    '<img alt={`A picture`} />',
    '<span title="Pinned">*</span>',
    '<Section title="usage.nothere" />',
  ]
  const fromCatalog = [
    "<p>{t('saved')}</p>",
    "<button aria-label={t('close')} />",
    '<img alt="" />',
    '<span>{count} · {total}</span>',
    '<span>/</span>',
    '<span>42%</span>',
    '<div className="note-list" data-testid="list" role="list" />',
    '<input placeholder={hint} title={`${a}`} />',
    '<Section title="usage.list" />',
  ]
  const found = (jsx: string) => inlineUiStrings('sample.tsx', `const x = ${jsx}`)
  expect(inline.filter((jsx) => found(jsx).length === 0)).toEqual([])
  expect(fromCatalog.filter((jsx) => found(jsx).length > 0)).toEqual([])
})
