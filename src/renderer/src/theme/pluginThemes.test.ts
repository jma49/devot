import { describe, expect, it } from 'vitest'
import { light } from './tokens'
import {
  applyPluginTheme,
  isIconColor,
  NO_PLUGIN_THEMES,
  readPluginThemes,
  themeInEffect,
  THEME_COLORS,
  type ThemeTarget,
} from './pluginThemes'

const nord = {
  plugin: 'com.example.nord',
  pluginName: 'Nord',
  id: 'nord-light',
  title: 'Nord Light',
  appearance: 'light',
  colors: { 'surface-editor': '#eceff4', 'not-a-token': '#000000', 'ink-text': 'red' },
}

function target(): ThemeTarget & { props: Map<string, string> } {
  const props = new Map<string, string>()
  return {
    props,
    dataset: {},
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
  }
}

describe('readPluginThemes', () => {
  it('keeps the colors of tokens this build knows, as hex', () => {
    expect(THEME_COLORS.has('surface-editor')).toBe(true)
    const read = readPluginThemes({
      themes: [nord],
      chosen: { light: { plugin: nord.plugin, theme: nord.id }, dark: null },
    })
    expect(read.themes[0]?.colors).toEqual({ 'surface-editor': '#eceff4' })
    expect(read.chosen).toEqual({ light: { plugin: nord.plugin, theme: nord.id }, dark: null })
  })

  it("leaves every icon in Devot's colors: status marks, settings tiles and tag icons", () => {
    const read = readPluginThemes({
      themes: [
        {
          ...nord,
          colors: {
            'surface-editor': '#eceff4',
            'status-active': '#88c0d0',
            'status-active-mark': '#88c0d0',
            'status-dropped-mark': '#bf616a',
            'icon-tile-general': '#81a1c1',
            'icon-tile-foreground': '#2e3440',
            'tag-icon-blue': '#5e81ac',
            'phone-status-tile-done': '#a3be8c',
          },
        },
      ],
      chosen: {},
    })
    expect(read.themes[0]?.colors).toEqual({
      'surface-editor': '#eceff4',
      'status-active': '#88c0d0',
    })
  })

  it('names as icon colors exactly the tokens icons are drawn in', () => {
    const icons = Object.keys(light)
      .map((k) => k.slice('color.'.length).replaceAll('.', '-'))
      .filter(isIconColor)
      .sort()
    expect(icons.filter((t) => t.startsWith('status-'))).toEqual([
      'status-active-mark',
      'status-done-mark',
      'status-dropped-mark',
      'status-hold-mark',
    ])
    expect(icons.filter((t) => t.startsWith('icon-tile-'))).toHaveLength(14)
    expect(icons.filter((t) => t.startsWith('tag-icon-'))).toHaveLength(8)
    expect(icons.filter((t) => t.startsWith('phone-status-tile-'))).toHaveLength(5)
    for (const token of icons) expect(THEME_COLORS.has(token)).toBe(false)
    expect(THEME_COLORS.has('accent-fill')).toBe(true)
  })

  it('drops a choice of a theme it does not list, or of the other appearance', () => {
    expect(
      readPluginThemes({
        themes: [nord],
        chosen: {
          light: { plugin: nord.plugin, theme: 'gone' },
          dark: { plugin: nord.plugin, theme: nord.id },
        },
      }).chosen,
    ).toEqual({ light: null, dark: null })
  })

  it('reads nothing from an answer of another shape', () => {
    for (const value of [null, [], { themes: 'x', chosen: {} }, { themes: [] }]) {
      expect(readPluginThemes(value)).toEqual(NO_PLUGIN_THEMES)
    }
    expect(
      readPluginThemes({ themes: [{ ...nord, appearance: 'sepia' }], chosen: {} }).themes,
    ).toEqual([])
  })
})

describe('applyPluginTheme', () => {
  it('sets the chosen theme on the root and takes it off again', () => {
    const themes = readPluginThemes({
      themes: [nord],
      chosen: { light: { plugin: nord.plugin, theme: nord.id }, dark: null },
    })
    const root = target()
    let applied = applyPluginTheme(themeInEffect(themes, 'light'), root, new Set())
    expect([...root.props]).toEqual([['--color-surface-editor', '#eceff4']])
    expect(root.dataset['pluginTheme']).toBe('com.example.nord/nord-light')
    applied = applyPluginTheme(themeInEffect(themes, 'dark'), root, applied)
    expect(root.props.size).toBe(0)
    expect(applied.size).toBe(0)
    expect(root.dataset['pluginTheme']).toBeUndefined()
  })
})
