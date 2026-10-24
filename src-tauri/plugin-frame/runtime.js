// Devot's runtime in a plugin's page (ADR 0005): the `devot` global, which speaks the protocol (version 1) over the port the host
// hands in. It runs before the plugin's script. The host checks every call itself; this only makes the protocol easy to use.
'use strict'
;(() => {
  // No content security policy governs WebRTC.
  const rtc = Object.getOwnPropertyNames(globalThis).filter((name) => /^(?:webkit)?RTC/.test(name))
  for (const name of new Set([...rtc, 'RTCPeerConnection', 'webkitRTCPeerConnection'])) {
    try {
      delete globalThis[name]
    } catch {
      globalThis[name] = undefined
    }
  }

  // A frame of the plugin's own (src-less frames skip the policy) would bring a fresh global with WebRTC back, and a resource hint
  // reaches the network outside the policy. So no frame or hint ever enters the document, by any insertion or HTML-parsing API.
  const FRAMES = 'iframe, frame, frameset, object, embed, portal, fencedframe'
  const HINT = /(?:^|\s)(?:dns-prefetch|preconnect|prefetch|prerender)(?:\s|$)/i
  const blocked = () => new DOMException('E_PLUGIN_FRAME_BLOCKED', 'NotSupportedError')
  const refused = (el) =>
    el.matches(FRAMES) || (el.localName === 'link' && HINT.test(el.getAttribute('rel') ?? ''))
  const refusedIn = (node) =>
    node instanceof Node &&
    ((node.nodeType === Node.ELEMENT_NODE && refused(node)) ||
      (typeof node.querySelectorAll === 'function' &&
        Array.from(node.querySelectorAll(`${FRAMES}, link`)).some(refused)))
  const guard = (proto, name, check) => {
    const original = proto && Object.getOwnPropertyDescriptor(proto, name)
    if (!original || typeof original.value !== 'function') return
    Object.defineProperty(proto, name, {
      ...original,
      value: function (...args) {
        if (check(args)) throw blocked()
        return original.value.apply(this, args)
      },
    })
  }
  const anyNode = (args) => args.some(refusedIn)
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) {
    guard(Node.prototype, name, anyNode)
  }
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ['append', 'prepend', 'replaceChildren', 'moveBefore']) {
      guard(proto, name, anyNode)
    }
  }
  for (const proto of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
    for (const name of ['before', 'after', 'replaceWith']) guard(proto, name, anyNode)
  }
  guard(Element.prototype, 'insertAdjacentElement', anyNode)
  guard(Range.prototype, 'insertNode', anyNode)
  guard(Range.prototype, 'surroundContents', anyNode)

  const template = document.createElement('template')
  const innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
  const parsesRefused = (html) => {
    innerHTML.set.call(template, String(html))
    const found = refusedIn(template.content)
    innerHTML.set.call(template, '')
    return found
  }
  // Parsing in place can differ from parsing in a template, so the result is checked too, before any script can see it.
  const checkedHtml = (proto, name, scope) => {
    const original = Object.getOwnPropertyDescriptor(proto, name)
    if (!original) return
    const run = function (call, html) {
      if (parsesRefused(html)) throw blocked()
      const area = scope(this)
      const result = call()
      if (area && refusedIn(area)) {
        for (const el of area.querySelectorAll(`${FRAMES}, link`)) if (refused(el)) el.remove()
        throw blocked()
      }
      return result
    }
    if (original.set) {
      Object.defineProperty(proto, name, {
        ...original,
        set(html) {
          run.call(this, () => original.set.call(this, html), html)
        },
      })
    } else if (typeof original.value === 'function') {
      Object.defineProperty(proto, name, {
        ...original,
        value: function (...args) {
          return run.call(this, () => original.value.apply(this, args), args[args.length - 1])
        },
      })
    }
  }
  checkedHtml(Element.prototype, 'innerHTML', (el) => el)
  checkedHtml(Element.prototype, 'outerHTML', (el) => el.parentNode)
  checkedHtml(Element.prototype, 'insertAdjacentHTML', (el) => el.parentNode ?? el)

  const refuse = (proto, name) => {
    if (proto && Object.hasOwn(proto, name)) {
      Object.defineProperty(proto, name, {
        configurable: false,
        writable: false,
        value: () => {
          throw blocked()
        },
      })
    }
  }
  for (const name of ['write', 'writeln', 'open', 'execCommand']) refuse(Document.prototype, name)
  for (const name of ['setHTML', 'setHTMLUnsafe', 'attachShadow']) refuse(Element.prototype, name)
  for (const name of ['parseHTML', 'parseHTMLUnsafe']) refuse(Document, name)
  if (typeof ShadowRoot === 'function') {
    for (const name of ['setHTML', 'setHTMLUnsafe']) refuse(ShadowRoot.prototype, name)
  }
  for (const kind of [
    'HTMLIFrameElement',
    'HTMLFrameElement',
    'HTMLObjectElement',
    'HTMLEmbedElement',
  ]) {
    const proto = globalThis[kind]?.prototype
    if (!proto) continue
    for (const name of ['contentWindow', 'contentDocument']) {
      if (Object.hasOwn(proto, name)) {
        Object.defineProperty(proto, name, { configurable: false, get: () => null })
      }
    }
    refuse(proto, 'getSVGDocument')
  }
  // A change no guard sees (a link's `rel` set later, a paste): removed before the next task, when a hint or frame would start.
  new MutationObserver((records) => {
    for (const record of records) {
      const nodes = record.type === 'attributes' ? [record.target] : record.addedNodes
      for (const node of nodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        if (refused(node)) node.remove()
        else for (const el of node.querySelectorAll(`${FRAMES}, link`)) if (refused(el)) el.remove()
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['rel'],
  })

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
