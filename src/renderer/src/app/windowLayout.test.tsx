// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import { SYNC_OFF } from '../sync'
import type { useAppCommands } from './useAppCommands'
import type { usePalette } from './usePalette'
import { LibraryDialogs } from './LibraryDialogs'
import type { useSheets } from '../sheets'
import { WindowNotices } from './WindowNotices'
import { WindowSheets } from './WindowSheets'

vi.mock('../TrialNotices', () => ({
  ActivationBar: () => null,
  TrialEndedBar: () => null,
  TrialReminder: () => null,
}))

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
})

function mount<P extends object>(type: (props: P) => React.ReactNode, props: P) {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(createElement(type, props)))
  unmounts.push(() => act(() => root.unmount()))
  return host
}

const marker = (name: string) => <i data-marker={name} />
const markers = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[data-marker]')].map((el) => el.dataset['marker'])

const none = { code: undefined, dismiss: () => {} }

function notices(
  overrides: Partial<ComponentProps<typeof WindowNotices>> = {},
): ComponentProps<typeof WindowNotices> {
  return {
    save: marker('save'),
    backup: { ...none, backupsOpen: false, show: () => {} },
    syncSnapshot: SYNC_OFF,
    exported: marker('exported'),
    searchIndex: marker('searchIndex'),
    mirror: [marker('mirror')],
    updates: marker('updates'),
    change: none,
    undoDropped: marker('undoDropped'),
    batch: marker('batch'),
    aiAccess: marker('aiAccess'),
    coreFailure: none,
    ai: marker('ai'),
    images: none,
    link: marker('link'),
    licence: marker('licence'),
    plugins: marker('plugins'),
    ...overrides,
  }
}

describe('WindowNotices', () => {
  it('stacks the notices in one notices element, in their order', () => {
    const host = mount(WindowNotices, notices())
    expect(host.children).toHaveLength(1)
    expect(host.firstElementChild?.className).toBe('notices')
    expect(markers(host)).toEqual([
      'save',
      'exported',
      'searchIndex',
      'mirror',
      'updates',
      'undoDropped',
      'batch',
      'aiAccess',
      'ai',
      'link',
      'licence',
      'plugins',
    ])
  })

  it('shows the held notices between the others, each dismissed on its own', () => {
    const dismiss = { change: vi.fn<() => void>(), core: vi.fn<() => void>() }
    const host = mount(
      WindowNotices,
      notices({
        change: { code: 'E_NOTE_GONE', dismiss: dismiss.change },
        coreFailure: { code: 'E_CORE', dismiss: dismiss.core },
        images: { code: ['E_IMAGE_TOO_LARGE'], dismiss: () => {} },
      }),
    )
    const stack = [...host.firstElementChild!.children].map(
      (el) => (el as HTMLElement).dataset['marker'] ?? 'held',
    )
    expect(stack).toEqual([
      'save',
      'exported',
      'searchIndex',
      'mirror',
      'updates',
      'held',
      'undoDropped',
      'batch',
      'aiAccess',
      'held',
      'ai',
      'held',
      'link',
      'licence',
      'plugins',
    ])
    const alerts = host.querySelectorAll('[role="alert"]')
    act(() => alerts[1]!.querySelector('button')!.click())
    expect(dismiss.core).toHaveBeenCalledOnce()
    expect(dismiss.change).not.toHaveBeenCalled()
  })

  it('hides a failed backup while Backups is open, and opens Backups from the notice', () => {
    const show = vi.fn<() => void>()
    const dismiss = vi.fn<() => void>()
    const backup = { code: 'E_BACKUP', dismiss, show }
    expect(
      mount(WindowNotices, notices({ backup: { ...backup, backupsOpen: true } })).querySelector(
        '[role="alert"]',
      ),
    ).toBeNull()
    const host = mount(WindowNotices, notices({ backup: { ...backup, backupsOpen: false } }))
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === t('backups.show'),
    )
    act(() => button!.click())
    expect(dismiss).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
  })
})

function sheets(
  overrides: Partial<ComponentProps<typeof WindowSheets>> = {},
): ComponentProps<typeof WindowSheets> {
  return {
    mirror: marker('mirror'),
    licence: marker('licence'),
    plugins: marker('plugins'),
    noteActions: marker('noteActions'),
    templatePicker: marker('templatePicker'),
    palette: { paletteOpen: false } as ReturnType<typeof usePalette>,
    paletteLibrary: undefined,
    commands: { commands: {}, actionsOfEntry: () => ({}) } as unknown as ReturnType<
      typeof useAppCommands
    >,
    pluginEntries: () => [],
    noteOpen: false,
    history: marker('history'),
    ai: marker('ai'),
    viewing: null,
    closeViewer: () => {},
    aiAccess: marker('aiAccess'),
    clearAuthorship: marker('clearAuthorship'),
    shareWeb: marker('shareWeb'),
    activity: { core: undefined, open: true, close: () => {} },
    graph: { core: undefined, open: true, focus: undefined, openNote: () => {}, close: () => {} },
    exported: marker('exported'),
    headerMenus: marker('headerMenus'),
    savedSearch: marker('savedSearch'),
    confirm: marker('confirm'),
    ...overrides,
  }
}

describe('WindowSheets', () => {
  it('puts the sheets straight into the window, in their order', () => {
    const host = mount(WindowSheets, sheets())
    expect([...host.children].every((el) => el.hasAttribute('data-marker'))).toBe(true)
    expect(markers(host)).toEqual([
      'mirror',
      'licence',
      'plugins',
      'noteActions',
      'templatePicker',
      'history',
      'ai',
      'aiAccess',
      'clearAuthorship',
      'shareWeb',
      'exported',
      'headerMenus',
      'savedSearch',
      'confirm',
    ])
  })
})

describe('LibraryDialogs', () => {
  it('shows nothing while no library sheet is open', () => {
    const host = mount(LibraryDialogs, {
      sheets: { importJob: undefined, backupsOpen: false } as unknown as ReturnType<
        typeof useSheets
      >,
      tree: [],
      library: { kind: 'all' },
      editing: true,
      syncCore: undefined,
      syncSnapshot: SYNC_OFF,
    })
    expect(host.children).toHaveLength(0)
  })
})
