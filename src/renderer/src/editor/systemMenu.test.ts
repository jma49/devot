import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContextMenu, type MenuGroups } from '../contextMenu'
import { systemMenus } from './systemMenu'

const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
)
vi.mock('../ipc', () => ({ invoke }))

type Action = 'undo' | 'copy' | 'speech' | 'speak' | 'look'
interface Target {
  look: boolean
}

const GROUPS: MenuGroups<Action, Target> = [
  [{ action: 'look', label: 'editorMenu.lookUp', shown: (t) => t.look, text: () => 'Look Up' }],
  [
    { action: 'undo', label: 'editorMenu.undo', accelerator: 'CmdOrCtrl+Z' },
    { action: 'copy', label: 'editorMenu.copy', predefined: 'Copy' },
  ],
  [
    {
      action: 'speech',
      label: 'editorMenu.speech',
      submenu: [{ action: 'speak', label: 'editorMenu.startSpeaking' }],
    },
  ],
]

describe('the editor menu Rust shows', () => {
  beforeEach(() => invoke.mockReset())

  async function setup(word: string | null = null) {
    const picked: Action[] = []
    const replaced: string[] = []
    const api = systemMenus({ word: () => word, replace: (g) => replaced.push(g) })
    const menu = await createContextMenu('editor', GROUPS, (a) => picked.push(a), api, {
      look: false,
    })
    return { menu, picked, replaced }
  }

  it('sends the items shown for the target, the point and the word', async () => {
    invoke.mockResolvedValue(null)
    const { menu } = await setup('recieve')
    await menu.popup({ look: true }, { x: 10, y: -3 })
    expect(invoke).toHaveBeenCalledWith('editor_menu_popup', {
      items: [
        { kind: 'item', id: 'devot.editor.look', text: 'Look Up' },
        { kind: 'separator' },
        { kind: 'item', id: 'devot.editor.undo', text: 'Undo', accelerator: 'CmdOrCtrl+Z' },
        { kind: 'predefined', item: 'Copy' },
        { kind: 'separator' },
        {
          kind: 'submenu',
          id: 'devot.editor.speech',
          text: 'Speech',
          items: [{ kind: 'item', id: 'devot.editor.speak', text: 'Start Speaking' }],
        },
      ],
      x: 10,
      y: 0,
      word: 'recieve',
    })
    await menu.popup({ look: false })
    const items = invoke.mock.lastCall?.[1]?.['items'] as { id?: string }[]
    expect(items[0]?.id).toBe('devot.editor.undo')
  })

  it("runs the item Rust answers with, a submenu's too, and puts a guess in place", async () => {
    const { menu, picked, replaced } = await setup()
    invoke.mockResolvedValueOnce({ kind: 'item', id: 'devot.editor.undo' })
    await menu.popup({ look: false })
    invoke.mockResolvedValueOnce({ kind: 'item', id: 'devot.editor.speak' })
    await menu.popup({ look: false })
    invoke.mockResolvedValueOnce({ kind: 'guess', text: 'receive' })
    await menu.popup({ look: false })
    invoke.mockResolvedValueOnce({ kind: 'item', id: 'devot.editor.nothing' })
    await menu.popup({ look: false })
    expect(picked).toEqual(['undo', 'speak'])
    expect(replaced).toEqual(['receive'])
  })
})
