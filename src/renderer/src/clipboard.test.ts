import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CLIPBOARD_LIMIT, writeClipboardText } from './clipboard'

afterEach(() => vi.unstubAllGlobals())

/** Records what reaches Rust's `clipboard_write_text` and the page's clipboard API. */
function clipboards(page: (text: string) => Promise<void> = async () => {}) {
  const native: string[] = []
  const written: number[] = []
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: { text: string }) => {
        if (cmd === 'clipboard_write_text') native.push(args.text)
      },
    },
  })
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: (text: string) => {
        written.push(text.length)
        return page(text)
      },
    },
  })
  return { native, written }
}

describe('writing the clipboard', () => {
  it('goes through Rust, and through the page beyond what Rust takes', async () => {
    const { native, written } = clipboards()
    await writeClipboardText('[Plan](devot://note/x)')
    const long = 'x'.repeat(NATIVE_CLIPBOARD_LIMIT + 1)
    await writeClipboardText(long)
    expect(native).toEqual(['[Plan](devot://note/x)'])
    expect(written).toEqual([long.length])
  })

  it('says why the page could not take a long text', async () => {
    clipboards(() => Promise.reject(new Error('NotAllowedError')))
    await expect(writeClipboardText('x'.repeat(NATIVE_CLIPBOARD_LIMIT + 1))).rejects.toThrow(
      'E_CLIPBOARD_TEXT_TOO_LONG',
    )
  })
})
