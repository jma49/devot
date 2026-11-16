import { describe, expect, it } from 'vitest'
import {
  applyPluginTheme,
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
