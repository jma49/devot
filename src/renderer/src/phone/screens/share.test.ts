import { describe, expect, it, vi } from 'vitest'
import { type NativeShare, SHARE_LEDGER_KEY, shareHandlers } from './share'

const ITEM = '01890a5d-ac96-774b-bcce-b302099a8057'
const PNG = 'iVBORw0KGgoAAAANSUhEUg=='

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

function setUp(allowed = true) {
  const capture = vi.fn<NativeShare['capture']>(async () => ({ id: 'note-1', refused: [] }))
  const native: NativeShare = { allowed: () => allowed, capture, ledger: memoryStorage() }
  const handler = shareHandlers(() => native)['share.capture']!
  return { native, capture, handler }
}

const args = {
  id: ITEM,
  title: 'An article',
  text: 'Worth reading.',
  url: 'https://example.com/a',
  images: [{ name: 'IMG_0001.png', data: PNG }],
}

describe('share.capture', () => {
  it('hands the core the share with its images as bytes and answers the note', async () => {
    const { capture, handler } = setUp()
    await expect(handler(args)).resolves.toEqual({ id: 'note-1', refused: [] })
    const share = capture.mock.calls[0]![0]
    expect(share).toMatchObject({ title: 'An article', text: 'Worth reading.' })
    expect(share.url).toBe('https://example.com/a')
    expect(share.images[0]!.name).toBe('IMG_0001.png')
    expect([...share.images[0]!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('takes a share with no link', async () => {
    const { capture, handler } = setUp()
    await handler({ id: ITEM, title: '', text: 'a thought', images: [] })
    expect(capture.mock.calls[0]![0].url).toBeNull()
  })

  it('makes a share sent again once, answering the note it made', async () => {
    const { native, capture, handler } = setUp()
    await handler(args)
    await expect(handler(args)).resolves.toEqual({ id: 'note-1', refused: [] })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(native.ledger?.getItem(SHARE_LEDGER_KEY)).toContain(ITEM)
  })

  it('refuses while editing is locked and makes nothing, so the share stays in the inbox', async () => {
    const { capture, handler } = setUp(false)
    await expect(handler(args)).rejects.toThrow('E_LICENCE_REQUIRED')
    expect(capture).not.toHaveBeenCalled()
  })

  it('refuses arguments of the wrong shape', async () => {
    const { handler } = setUp()
    await expect(handler({ ...args, images: 'none' })).rejects.toThrow('E_SCREENS_ARGS_INVALID')
    await expect(handler({ ...args, title: 3 })).rejects.toThrow('E_SCREENS_ARGS_INVALID')
  })

  it('is unavailable before the page can make notes', async () => {
    await expect(shareHandlers(() => null)['share.capture']!(args)).rejects.toThrow(
      'E_SCREENS_UNAVAILABLE',
    )
  })
})
