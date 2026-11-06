import { TEMPLATES_BOOK_ID } from '../books'
import type { StorageAdapter } from '../storage'

/** Whether notes can go in a notebook. */
export function createBooks(storage: StorageAdapter) {
  /** Templates' row may be missing (another device deleted it in a Devot from before templates). */
  const isLiveBook = async (bookId: string) =>
    bookId === TEMPLATES_BOOK_ID || (await storage.isLiveBook(bookId))

  const requireBook = async (bookId: string | null) => {
    if (bookId !== null && !(await isLiveBook(bookId))) throw new Error('E_BOOK_NOT_FOUND')
  }

  const liveBook = async (bookId: string | null) =>
    bookId !== null && (await isLiveBook(bookId)) ? bookId : null

  return { requireBook, liveBook }
}
