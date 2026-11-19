export async function copySelection(pending: Promise<Selection | null>): Promise<void> {
  const content = pending.then((selection) => {
    if (!selection || selection.rangeCount === 0) throw new Error('E_PREVIEW_COPY_CANCELLED')
    const fragment = document.createElement('div')
    for (let i = 0; i < selection.rangeCount; i++)
      fragment.append(selection.getRangeAt(i).cloneContents())
    return { text: selection.toString(), html: fragment.innerHTML }
  })
  const text = content.then((value) => new Blob([value.text], { type: 'text/plain' }))
  const html = content.then((value) => new Blob([value.html], { type: 'text/html' }))
  void text.catch(() => undefined)
  void html.catch(() => undefined)
  // WebKit requires the write during the gesture; its promised data may arrive later.
  await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })])
}
