import * as Y from 'yjs'
import { sha256Hex } from '../sha256'
import { lineFeeds } from '../text'

export const BODY = 'body'

/** The Yjs client a seeded body is written as: the same for the same note and text, so their states are equal; another text gets another client, so two seeds never give two changes one ID. */
export const seedClient = (id: string, markdown: string) =>
  Number.parseInt(sha256Hex(`${id}\n${lineFeeds(markdown)}`).slice(0, 8), 16)

/** The Markdown a note's Yjs state holds. */
export const bodyText = (state: Uint8Array): string => {
  const doc = new Y.Doc()
  if (state.length > 0) Y.applyUpdate(doc, state)
  return doc.getText(BODY).toString()
}
