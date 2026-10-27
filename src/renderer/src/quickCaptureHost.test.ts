import { describe, expect, it, vi } from 'vitest'
import { answerCapture, readCaptureRequest, type CaptureRequest } from './quickCaptureHost'

const REQUEST = { id: 4, title: 'Groceries', body: '- milk', bookId: 'b1' }

describe('readCaptureRequest', () => {
  it('reads what Rust sends', () => {
    expect(readCaptureRequest(REQUEST)).toEqual(REQUEST)
    expect(readCaptureRequest({ ...REQUEST, bookId: null })).toEqual({ ...REQUEST, bookId: null })
  })

  it('refuses anything else', () => {
    for (const payload of [
      null,
      'capture',
      { ...REQUEST, id: '4' },
      { ...REQUEST, id: -1 },
      { ...REQUEST, id: 1.5 },
      { ...REQUEST, title: 3 },
      { ...REQUEST, body: undefined },
      { ...REQUEST, bookId: 7 },
    ])
      expect(readCaptureRequest(payload)).toBeNull()
  })
})

describe('answerCapture', () => {
  const claimed = async () => {}

  it('claims the capture, saves it and answers its ID without an error', async () => {
    const order: string[] = []
    const claim = vi.fn<(id: number) => Promise<void>>(async () => void order.push('claim'))
    const save = vi.fn<(r: CaptureRequest) => Promise<void>>(async () => void order.push('save'))
    const reply = vi.fn<(id: number, error: string | null) => Promise<void>>(async () => {})
    expect(await answerCapture(REQUEST, claim, save, reply)).toBe(true)
    expect(claim).toHaveBeenCalledWith(4)
    expect(save).toHaveBeenCalledWith(REQUEST)
    expect(reply).toHaveBeenCalledWith(4, null)
    expect(order).toEqual(['claim', 'save'])
  })

  it('writes nothing for a capture Rust no longer waits for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const save = vi.fn<(r: CaptureRequest) => Promise<void>>(async () => {})
    const reply = vi.fn<(id: number, error: string | null) => Promise<void>>(async () => {})
    const saved = await answerCapture(
      REQUEST,
      () => Promise.reject(new Error('E_QUICK_CAPTURE_UNKNOWN')),
      save,
      reply,
    )
    expect(saved).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('W_QUICK_CAPTURE_CLAIM_FAILED', 'E_QUICK_CAPTURE_UNKNOWN')
    warn.mockRestore()
  })

  it("answers with the save's code when it fails", async () => {
    const reply = vi.fn<(id: number, error: string | null) => Promise<void>>(async () => {})
    const failed = await answerCapture(
      REQUEST,
      claimed,
      () => Promise.reject(new Error('E_BOOK_NOT_FOUND')),
      reply,
    )
    expect(failed).toBe(false)
    expect(reply).toHaveBeenCalledWith(4, 'E_BOOK_NOT_FOUND')
  })

  it('answers with a code of its own for a failure without one', async () => {
    const reply = vi.fn<(id: number, error: string | null) => Promise<void>>(async () => {})
    await answerCapture(REQUEST, claimed, () => Promise.reject(new Error('disk is full')), reply)
    expect(reply).toHaveBeenCalledWith(4, 'E_QUICK_CAPTURE_FAILED')
  })

  it('still counts a saved capture when its answer is lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = await answerCapture(
      REQUEST,
      claimed,
      async () => {},
      () => Promise.reject(new Error('E_QUICK_CAPTURE_UNKNOWN')),
    )
    expect(saved).toBe(true)
    expect(warn).toHaveBeenCalledWith('W_QUICK_CAPTURE_ANSWER_FAILED', 'E_QUICK_CAPTURE_UNKNOWN')
    warn.mockRestore()
  })
})
