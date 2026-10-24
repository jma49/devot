// Devot's runtime in a plugin's page (ADR 0005): the `devot` global, which speaks the protocol (version 1) over the port the host
// hands in. It runs before the plugin's script. The host checks every call itself; this only makes the protocol easy to use.
'use strict'
;(() => {
  // No content security policy governs WebRTC.
  for (const name of [
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'RTCDataChannel',
    'RTCSessionDescription',
    'RTCIceCandidate',
  ]) {
    try {
      delete globalThis[name]
    } catch {
      globalThis[name] = undefined
    }
  }

  const VERSION = 1
  const queued = []
  const waiting = new Map()
  const handlers = {
    'command.run': new Map(),
    'preview.render': new Map(),
    'import.convert': new Map(),
    'export.convert': new Map(),
  }
  const target = {
    'command.run': 'command',
    'preview.render': 'renderer',
    'import.convert': 'format',
    'export.convert': 'format',
  }
  const onHidden = []
  let port = null
  let seq = 0

  const send = (message) => (port ? port.postMessage(message) : queued.push(message))

  const failure = (code) => Object.assign(new Error(code), { code })

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      seq += 1
      waiting.set(seq, { resolve, reject })
      send({ devot: VERSION, kind: 'call', seq, method, params })
    })

  const answer = async ({ seq: at, method, params }) => {
    const reply = (result) =>
      port.postMessage({ devot: VERSION, kind: 'result', seq: at, ...result })
    const handler =
      Object.hasOwn(handlers, method) && params && handlers[method].get(params[target[method]])
    if (!handler) return reply({ ok: false, code: 'E_PLUGIN_HANDLER_MISSING' })
    try {
      const value = await handler(params)
      reply({ ok: true, value: value === undefined ? null : value })
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : 'E_PLUGIN_FAILED'
      reply({ ok: false, code })
    }
  }

  const receive = (event) => {
    const message = event.data
    if (!message || message.devot !== VERSION) return
    if (message.kind === 'result') {
      const pending = waiting.get(message.seq)
      if (!pending) return
      waiting.delete(message.seq)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(failure(message.code))
    } else if (message.kind === 'call') {
      void answer(message)
    } else if (message.kind === 'event' && message.name === 'ui.hidden') {
      for (const listener of onHidden) {
        try {
          listener()
        } catch {
          // One listener's failure never stops the others.
        }
      }
    }
  }

  addEventListener('message', (event) => {
    const message = event.data
    if (port || event.source !== parent || event.ports.length !== 1) return
    if (!message || message.devot !== VERSION || message.kind !== 'connect') return
    port = event.ports[0]
    port.onmessage = receive
    for (const early of queued.splice(0)) port.postMessage(early)
  })

  const register = (method, wrap) => (id, fn) => {
    if (typeof id !== 'string' || typeof fn !== 'function') {
      throw new TypeError('devot: a handler needs an id and a function')
    }
    handlers[method].set(id, (params) => wrap(fn, params))
  }

  Object.defineProperty(globalThis, 'devot', {
    value: Object.freeze({
      apiVersion: 1,
      commands: Object.freeze({ handle: register('command.run', (fn) => fn()) }),
      preview: Object.freeze({
        handle: register('preview.render', (fn, { source }) => fn(source)),
      }),
      importer: Object.freeze({
        handle: register('import.convert', (fn, { name, text }) => fn({ name, text })),
      }),
      exporter: Object.freeze({
        handle: register('export.convert', (fn, { title, markdown }) => fn({ title, markdown })),
      }),
      note: Object.freeze({
        read: () => call('note.read'),
        replace: ({ base, markdown }) =>
          call('note.replace', { base, markdown }).then(() => undefined),
      }),
      ui: Object.freeze({
        show: (options = {}) => call('ui.show', { height: options.height }).then(() => undefined),
        hide: () => call('ui.hide').then(() => undefined),
        onHidden: (fn) => {
          if (typeof fn === 'function') onHidden.push(fn)
        },
      }),
    }),
  })
})()
