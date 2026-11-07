import contentCss from '../preview/content.css?raw'

/** The preview's own content rules, for Write mode's rendered blocks. */
const contentStyles = (() => {
  let sheet: CSSStyleSheet | undefined
  return () => {
    if (!sheet) {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(contentCss)
    }
    return sheet
  }
})()

/** The editor's own styles in its shadow root, where the window's stylesheet does not reach. */
const frameStyles = (() => {
  let sheet: CSSStyleSheet | undefined
  return () => {
    if (!sheet) {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(`
        /* Grid stretching, not percentages: the scroll box is as tall as
           the host when the window's layout gives it a height. */
        :host,
        .editor-frame { display: grid; min-height: 0; }
        .editor-frame { position: relative; }
        .editor-scroll { min-height: 0; }
        /* The lines slide inside it with the panes (paneMotion.ts) without
           ever making the box scroll sideways. */
        .editor-root { overflow-x: clip; }
        /* CodeMirror's popup layer covers the editor: only the popups in it
           take the pointer. */
        .editor-frame { pointer-events: none; }
        .editor-scroll,
        .editor-frame .cm-tooltip { pointer-events: auto; }
        .editor-scroll {
          box-sizing: border-box;
          overflow: auto;
          overflow-y: var(--editor-overflow-y, auto);
          padding: var(--editor-padding);
          /* Not on .editor or .panes: popups beside this box must stay unmasked (app.css). */
          mask-image: linear-gradient(transparent, var(--color-ink-text) var(--scroll-edge-depth, 0px));
        }
        .editor-scroll::-webkit-scrollbar {
          width: var(--size-scrollbar);
          height: var(--size-scrollbar);
          background: transparent;
        }
        .editor-scroll::-webkit-scrollbar-thumb {
          border-radius: var(--radius-capsule);
          background: var(--color-fill-scrollbar);
        }
      `)
    }
    return sheet
  }
})()

export function shadowContainer(host: HTMLElement): {
  root: ShadowRoot
  frame: HTMLElement
  scroller: HTMLElement
  parent: HTMLElement
} {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.replaceChildren()
  if (!root.adoptedStyleSheets.includes(frameStyles())) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, frameStyles(), contentStyles()]
  }
  const frame = document.createElement('div')
  frame.className = 'editor-frame'
  const scroller = document.createElement('div')
  scroller.className = 'editor-scroll'
  scroller.dataset['devotPart'] = 'editor-scroll'
  const parent = document.createElement('div')
  parent.className = 'editor-root'
  scroller.appendChild(parent)
  frame.appendChild(scroller)
  root.appendChild(frame)
  return { root, frame, scroller, parent }
}
