// The page between the main window and a plugin's page (ADR 0005). Its policy lets its one frame load the plugin's page only, so
// the plugin can never navigate. It passes on the port the main window hands it, once, and does nothing else.
'use strict'
;(() => {
  const frame = document.querySelector('iframe')
  let taken = false
  addEventListener('message', (event) => {
    const message = event.data
    if (taken || event.source !== parent || event.ports.length !== 1) return
    if (!message || message.devot !== 1 || message.kind !== 'connect') return
    taken = true
    frame.contentWindow.postMessage({ devot: 1, kind: 'connect' }, '*', [event.ports[0]])
  })
})()
