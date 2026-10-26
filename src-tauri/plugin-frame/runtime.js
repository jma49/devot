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
  // The plugin's script shares this realm and can change any prototype or global later, so the guard calls only what it keeps
  // here, never a method or getter read off a node or a prototype at the time of the call.
  const { apply, getOwnPropertyDescriptor: describe, defineProperty } = Reflect
  const getter = (proto, name) => describe(proto, name)?.get
  const valueOf = (proto, name) => describe(proto, name)?.value
  const doc = document
  const Refusal = DOMException
  const nodeType = getter(Node.prototype, 'nodeType')
  const parentNode = getter(Node.prototype, 'parentNode')
  const localName = getter(Element.prototype, 'localName')
  const matches = valueOf(Element.prototype, 'matches')
  const getAttribute = valueOf(Element.prototype, 'getAttribute')
  const remove = valueOf(Element.prototype, 'remove')
  const elementQuery = valueOf(Element.prototype, 'querySelectorAll')
  const documentQuery = valueOf(Document.prototype, 'querySelectorAll')
  const fragmentQuery = valueOf(DocumentFragment.prototype, 'querySelectorAll')
  const listLength = getter(NodeList.prototype, 'length')
  const exec = RegExp.prototype.exec
  const toText = String
  const templateContent = getter(HTMLTemplateElement.prototype, 'content')
  const recordType = getter(MutationRecord.prototype, 'type')
  const recordTarget = getter(MutationRecord.prototype, 'target')
  const recordAdded = getter(MutationRecord.prototype, 'addedNodes')
  const windowLength = getter(globalThis, 'length') ?? getter(Window.prototype, 'length')

  const FRAMES = 'iframe, frame, frameset, object, embed, portal, fencedframe'
  const CHECKED = `${FRAMES}, link`
  const HINT = /(?:^|\s)(?:dns-prefetch|preconnect|prefetch|prerender)(?:\s|$)/i
  const ELEMENT = 1
  const blocked = () => new Refusal('E_PLUGIN_FRAME_BLOCKED', 'NotSupportedError')
  // 0 for what is not a node: a string to append, or an object that only looks like a node.
  const typeOf = (value) => {
    try {
      return apply(nodeType, value, [])
    } catch {
      return 0
    }
  }
  const queryOf = (type) => {
    if (type === ELEMENT) return elementQuery
    if (type === 9) return documentQuery
    return type === 11 ? fragmentQuery : null
  }
  const query = (node, selector) => {
    const run = queryOf(typeOf(node))
    return run ? apply(run, node, [selector]) : null
  }
  const some = (list, test) => {
    if (!list) return false
    const length = apply(listLength, list, [])
    for (let i = 0; i < length; i += 1) if (test(list[i])) return true
    return false
  }
  const refused = (el) =>
    apply(matches, el, [FRAMES]) ||
    (apply(localName, el, []) === 'link' &&
      apply(exec, HINT, [apply(getAttribute, el, ['rel']) ?? '']) !== null)
  const refusedIn = (node) =>
    (typeOf(node) === ELEMENT && refused(node)) || some(query(node, CHECKED), refused)
  const removeRefused = (node) => {
    if (typeOf(node) !== ELEMENT) return
    if (refused(node)) apply(remove, node, [])
    else
      some(query(node, CHECKED), (el) => {
        if (refused(el)) apply(remove, el, [])
        return false
      })
  }
  const removeFrames = () =>
    some(query(doc, FRAMES), (el) => {
      apply(remove, el, [])
      return false
    })
  // Should a frame get in by a way no check here foresees, it is taken out before the plugin's next call returns.
  const noFrameIn = () => {
    if (!windowLength || apply(windowLength, globalThis, []) === 0) return
    removeFrames()
    throw blocked()
  }
  const guard = (proto, name, check) => {
    const original = proto && describe(proto, name)
    if (!original || typeof original.value !== 'function') return
    const run = original.value
    defineProperty(proto, name, {
      ...original,
      value: function (...args) {
        if (check(args)) throw blocked()
        const result = apply(run, this, args)
        noFrameIn()
        return result
      },
    })
  }
  const anyNode = (args) => {
    for (let i = 0; i < args.length; i += 1) if (refusedIn(args[i])) return true
    return false
  }
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

  const template = doc.createElement('template')
  const innerHTML = describe(Element.prototype, 'innerHTML')
  const parsesRefused = (html) => {
    apply(innerHTML.set, template, [html])
    const found = refusedIn(apply(templateContent, template, []))
    apply(innerHTML.set, template, [''])
    return found
  }
  // Parsing in place can differ from parsing in a template, so the result is checked too, before any script can see it. The
  // HTML is made text once, so a value that changes each time it is read parses the same in both.
  const checkedHtml = (proto, name, scope) => {
    const original = describe(proto, name)
    if (!original) return
    const run = function (call, html) {
      if (parsesRefused(html)) throw blocked()
      const area = scope(this)
      const result = call()
      if (area && refusedIn(area)) {
        removeRefused(area)
        throw blocked()
      }
      noFrameIn()
      return result
    }
    if (original.set) {
      const set = original.set
      defineProperty(proto, name, {
        ...original,
        set(html) {
          const text = toText(html)
          apply(run, this, [() => apply(set, this, [text]), text])
        },
      })
    } else if (typeof original.value === 'function') {
      const value = original.value
      defineProperty(proto, name, {
        ...original,
        value: function (...args) {
          if (args.length > 0) args[args.length - 1] = toText(args[args.length - 1])
          return apply(run, this, [() => apply(value, this, args), args[args.length - 1]])
        },
      })
    }
  }
  const parentOf = (el) => apply(parentNode, el, [])
  checkedHtml(Element.prototype, 'innerHTML', (el) => el)
  checkedHtml(Element.prototype, 'outerHTML', parentOf)
  checkedHtml(Element.prototype, 'insertAdjacentHTML', (el) => parentOf(el) ?? el)

  const refuse = (proto, name) => {
    if (proto && Object.hasOwn(proto, name)) {
      defineProperty(proto, name, {
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
        defineProperty(proto, name, { configurable: false, get: () => null })
      }
    }
    refuse(proto, 'getSVGDocument')
  }
  // A change no guard sees (a link's `rel` set later, a paste): removed before the next task, when a hint or frame would start.
  new MutationObserver((records) => {
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]
      if (apply(recordType, record, []) === 'attributes')
        removeRefused(apply(recordTarget, record, []))
      else
        some(apply(recordAdded, record, []), (node) => {
          removeRefused(node)
          return false
        })
    }
    if (windowLength && apply(windowLength, globalThis, []) > 0) removeFrames()
  }).observe(doc, {
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
