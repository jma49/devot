/* oxlint-disable -- Generated dependency bundle; lint source.ts instead. */
;(() => {
  var pe = Object.create
  var Tt = Object.defineProperty
  var ge = Object.getOwnPropertyDescriptor
  var me = Object.getOwnPropertyNames
  var xe = Object.getPrototypeOf,
    be = Object.prototype.hasOwnProperty
  var $ = (e, t) => () => {
    try {
      return (t || e((t = { exports: {} }).exports, t), t.exports)
    } catch (s) {
      throw ((t = 0), s)
    }
  }
  var Ee = (e, t, s, r) => {
    if ((t && typeof t == 'object') || typeof t == 'function')
      for (let i of me(t))
        !be.call(e, i) &&
          i !== s &&
          Tt(e, i, { get: () => t[i], enumerable: !(r = ge(t, i)) || r.enumerable })
    return e
  }
  var we = (e, t, s) => (
    (s = e != null ? pe(xe(e)) : {}),
    Ee(t || !e || !e.__esModule ? Tt(s, 'default', { value: e, enumerable: !0 }) : s, e)
  )
  var _t = $((c) => {
    'use strict'
    /**
     * Character classes and associated utilities for the 5th edition of XML 1.0.
     *
     * @author Louis-Dominique Dubeau
     * @license MIT
     * @copyright Louis-Dominique Dubeau
     */ Object.defineProperty(c, '__esModule', { value: !0 })
    c.CHAR = `	
\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}`
    c.S = ` 	\r
`
    c.NAME_START_CHAR =
      ':A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}'
    c.NAME_CHAR = '-' + c.NAME_START_CHAR + '.0-9\xB7\u0300-\u036F\u203F-\u2040'
    c.CHAR_RE = new RegExp('^[' + c.CHAR + ']$', 'u')
    c.S_RE = new RegExp('^[' + c.S + ']+$', 'u')
    c.NAME_START_CHAR_RE = new RegExp('^[' + c.NAME_START_CHAR + ']$', 'u')
    c.NAME_CHAR_RE = new RegExp('^[' + c.NAME_CHAR + ']$', 'u')
    c.NAME_RE = new RegExp('^[' + c.NAME_START_CHAR + '][' + c.NAME_CHAR + ']*$', 'u')
    c.NMTOKEN_RE = new RegExp('^[' + c.NAME_CHAR + ']+$', 'u')
    var tt = 9,
      et = 10,
      st = 13,
      rt = 32
    c.S_LIST = [rt, et, st, tt]
    function Ae(e) {
      return (
        (e >= rt && e <= 55295) ||
        e === et ||
        e === st ||
        e === tt ||
        (e >= 57344 && e <= 65533) ||
        (e >= 65536 && e <= 1114111)
      )
    }
    c.isChar = Ae
    function De(e) {
      return e === rt || e === et || e === st || e === tt
    }
    c.isS = De
    function Nt(e) {
      return (
        (e >= 65 && e <= 90) ||
        (e >= 97 && e <= 122) ||
        e === 58 ||
        e === 95 ||
        e === 8204 ||
        e === 8205 ||
        (e >= 192 && e <= 214) ||
        (e >= 216 && e <= 246) ||
        (e >= 248 && e <= 767) ||
        (e >= 880 && e <= 893) ||
        (e >= 895 && e <= 8191) ||
        (e >= 8304 && e <= 8591) ||
        (e >= 11264 && e <= 12271) ||
        (e >= 12289 && e <= 55295) ||
        (e >= 63744 && e <= 64975) ||
        (e >= 65008 && e <= 65533) ||
        (e >= 65536 && e <= 983039)
      )
    }
    c.isNameStartChar = Nt
    function Ce(e) {
      return (
        Nt(e) ||
        (e >= 48 && e <= 57) ||
        e === 45 ||
        e === 46 ||
        e === 183 ||
        (e >= 768 && e <= 879) ||
        (e >= 8255 && e <= 8256)
      )
    }
    c.isNameChar = Ce
  })
  var qt = $((l) => {
    'use strict'
    /**
     * Character classes and associated utilities for the 2nd edition of XML 1.1.
     *
     * @author Louis-Dominique Dubeau
     * @license MIT
     * @copyright Louis-Dominique Dubeau
     */ Object.defineProperty(l, '__esModule', { value: !0 })
    l.CHAR = '-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}'
    l.RESTRICTED_CHAR = '-\b\v\f-\x7F-\x84\x86-\x9F'
    l.S = ` 	\r
`
    l.NAME_START_CHAR =
      ':A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}'
    l.NAME_CHAR = '-' + l.NAME_START_CHAR + '.0-9\xB7\u0300-\u036F\u203F-\u2040'
    l.CHAR_RE = new RegExp('^[' + l.CHAR + ']$', 'u')
    l.RESTRICTED_CHAR_RE = new RegExp('^[' + l.RESTRICTED_CHAR + ']$', 'u')
    l.S_RE = new RegExp('^[' + l.S + ']+$', 'u')
    l.NAME_START_CHAR_RE = new RegExp('^[' + l.NAME_START_CHAR + ']$', 'u')
    l.NAME_CHAR_RE = new RegExp('^[' + l.NAME_CHAR + ']$', 'u')
    l.NAME_RE = new RegExp('^[' + l.NAME_START_CHAR + '][' + l.NAME_CHAR + ']*$', 'u')
    l.NMTOKEN_RE = new RegExp('^[' + l.NAME_CHAR + ']+$', 'u')
    var St = 9,
      vt = 10,
      Ft = 13,
      yt = 32
    l.S_LIST = [yt, vt, Ft, St]
    function Te(e) {
      return (e >= 1 && e <= 55295) || (e >= 57344 && e <= 65533) || (e >= 65536 && e <= 1114111)
    }
    l.isChar = Te
    function Ne(e) {
      return (
        (e >= 1 && e <= 8) ||
        e === 11 ||
        e === 12 ||
        (e >= 14 && e <= 31) ||
        (e >= 127 && e <= 132) ||
        (e >= 134 && e <= 159)
      )
    }
    l.isRestrictedChar = Ne
    function _e(e) {
      return (
        e === 9 ||
        e === 10 ||
        e === 13 ||
        (e > 31 && e < 127) ||
        e === 133 ||
        (e > 159 && e <= 55295) ||
        (e >= 57344 && e <= 65533) ||
        (e >= 65536 && e <= 1114111)
      )
    }
    l.isCharAndNotRestricted = _e
    function Se(e) {
      return e === yt || e === vt || e === Ft || e === St
    }
    l.isS = Se
    function Rt(e) {
      return (
        (e >= 65 && e <= 90) ||
        (e >= 97 && e <= 122) ||
        e === 58 ||
        e === 95 ||
        e === 8204 ||
        e === 8205 ||
        (e >= 192 && e <= 214) ||
        (e >= 216 && e <= 246) ||
        (e >= 248 && e <= 767) ||
        (e >= 880 && e <= 893) ||
        (e >= 895 && e <= 8191) ||
        (e >= 8304 && e <= 8591) ||
        (e >= 11264 && e <= 12271) ||
        (e >= 12289 && e <= 55295) ||
        (e >= 63744 && e <= 64975) ||
        (e >= 65008 && e <= 65533) ||
        (e >= 65536 && e <= 983039)
      )
    }
    l.isNameStartChar = Rt
    function ve(e) {
      return (
        Rt(e) ||
        (e >= 48 && e <= 57) ||
        e === 45 ||
        e === 46 ||
        e === 183 ||
        (e >= 768 && e <= 879) ||
        (e >= 8255 && e <= 8256)
      )
    }
    l.isNameChar = ve
  })
  var kt = $((E) => {
    'use strict'
    /**
     * Character class utilities for XML NS 1.0 edition 3.
     *
     * @author Louis-Dominique Dubeau
     * @license MIT
     * @copyright Louis-Dominique Dubeau
     */ Object.defineProperty(E, '__esModule', { value: !0 })
    E.NC_NAME_START_CHAR =
      'A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}'
    E.NC_NAME_CHAR = '-' + E.NC_NAME_START_CHAR + '.0-9\xB7\u0300-\u036F\u203F-\u2040'
    E.NC_NAME_START_CHAR_RE = new RegExp('^[' + E.NC_NAME_START_CHAR + ']$', 'u')
    E.NC_NAME_CHAR_RE = new RegExp('^[' + E.NC_NAME_CHAR + ']$', 'u')
    E.NC_NAME_RE = new RegExp('^[' + E.NC_NAME_START_CHAR + '][' + E.NC_NAME_CHAR + ']*$', 'u')
    function Lt(e) {
      return (
        (e >= 65 && e <= 90) ||
        e === 95 ||
        (e >= 97 && e <= 122) ||
        (e >= 192 && e <= 214) ||
        (e >= 216 && e <= 246) ||
        (e >= 248 && e <= 767) ||
        (e >= 880 && e <= 893) ||
        (e >= 895 && e <= 8191) ||
        (e >= 8204 && e <= 8205) ||
        (e >= 8304 && e <= 8591) ||
        (e >= 11264 && e <= 12271) ||
        (e >= 12289 && e <= 55295) ||
        (e >= 63744 && e <= 64975) ||
        (e >= 65008 && e <= 65533) ||
        (e >= 65536 && e <= 983039)
      )
    }
    E.isNCNameStartChar = Lt
    function Fe(e) {
      return (
        Lt(e) ||
        e === 45 ||
        e === 46 ||
        (e >= 48 && e <= 57) ||
        e === 183 ||
        (e >= 768 && e <= 879) ||
        (e >= 8255 && e <= 8256)
      )
    }
    E.isNCNameChar = Fe
  })
  var te = $((L) => {
    'use strict'
    Object.defineProperty(L, '__esModule', { value: !0 })
    L.SaxesParser = L.EVENTS = void 0
    var k = _t(),
      ye = qt(),
      xt = kt(),
      w = k.isS,
      Re = k.isChar,
      B = k.isNameStartChar,
      It = k.isNameChar,
      Qt = k.S_LIST,
      qe = k.NAME_RE,
      Le = ye.isChar,
      ke = xt.isNCNameStartChar,
      Ie = xt.isNCNameChar,
      Be = xt.NC_NAME_RE,
      Q = 'http://www.w3.org/XML/1998/namespace',
      q = 'http://www.w3.org/2000/xmlns/',
      Me = { __proto__: null, xml: Q, xmlns: q },
      He = { __proto__: null, amp: '&', gt: '>', lt: '<', quot: '"', apos: "'" },
      u = -1,
      C = -2,
      Bt = 0,
      Oe = 1,
      it = 2,
      Pe = 3,
      F = 4,
      Ue = 5,
      Ve = 6,
      $e = 7,
      at = 8,
      Xe = 9,
      Ge = 10,
      We = 11,
      je = 12,
      b = 13,
      X = 14,
      ot = 15,
      ze = 16,
      nt = 17,
      Qe = 18,
      Ke = 19,
      lt = 20,
      Ze = 21,
      Ye = 22,
      Je = 23,
      Mt = 24,
      ct = 25,
      G = 26,
      Ht = 27,
      ts = 28,
      es = 29,
      Ot = 30,
      ss = 31,
      rs = 32,
      _ = 33,
      is = 34,
      ht = 35,
      M = 36,
      ut = 37,
      as = 38,
      Pt = 39,
      Ut = 40,
      os = 41,
      Vt = 42,
      ns = 43,
      ls = 44,
      ft = 9,
      D = 10,
      dt = 13,
      $t = 32,
      Xt = 33,
      Kt = 34,
      H = 38,
      Zt = 39,
      W = 45,
      j = 47,
      cs = 59,
      T = 60,
      y = 61,
      d = 62,
      g = 63,
      Yt = 91,
      R = 93,
      Gt = 133,
      Wt = 8232,
      z = (e) => e === Kt || e === Zt,
      Jt = [Kt, Zt],
      hs = [...Jt, Yt, d],
      us = [...Jt, T, R],
      fs = [y, g, ...Qt],
      ds = [...Qt, d, H, T]
    function gt(e, t, s) {
      switch (t) {
        case 'xml':
          s !== Q && e.fail(`xml prefix must be bound to ${Q}.`)
          break
        case 'xmlns':
          s !== q && e.fail(`xmlns prefix must be bound to ${q}.`)
          break
        default:
      }
      switch (s) {
        case q:
          e.fail(
            t === ''
              ? `the default namespace may not be set to ${s}.`
              : `may not assign a prefix (even "xmlns") to the URI ${q}.`,
          )
          break
        case Q:
          switch (t) {
            case 'xml':
              break
            case '':
              e.fail(`the default namespace may not be set to ${s}.`)
              break
            default:
              e.fail('may not assign the xml namespace to another prefix.')
          }
          break
        default:
      }
    }
    function ps(e, t) {
      for (let s of Object.keys(t)) gt(e, s, t[s])
    }
    var gs = (e) => Be.test(e),
      ms = (e) => qe.test(e),
      S = 0,
      jt = 1,
      pt = 2
    L.EVENTS = [
      'xmldecl',
      'text',
      'processinginstruction',
      'doctype',
      'comment',
      'opentagstart',
      'attribute',
      'opentag',
      'closetag',
      'cdata',
      'error',
      'end',
      'ready',
    ]
    var zt = {
        xmldecl: 'xmldeclHandler',
        text: 'textHandler',
        processinginstruction: 'piHandler',
        doctype: 'doctypeHandler',
        comment: 'commentHandler',
        opentagstart: 'openTagStartHandler',
        attribute: 'attributeHandler',
        opentag: 'openTagHandler',
        closetag: 'closeTagHandler',
        cdata: 'cdataHandler',
        error: 'errorHandler',
        end: 'endHandler',
        ready: 'readyHandler',
      },
      mt = class {
        constructor(t) {
          ;((this.opt = t ?? {}), (this.fragmentOpt = !!this.opt.fragment))
          let s = (this.xmlnsOpt = !!this.opt.xmlns)
          if (
            ((this.trackPosition = this.opt.position !== !1),
            (this.fileName = this.opt.fileName),
            s)
          ) {
            ;((this.nameStartCheck = ke),
              (this.nameCheck = Ie),
              (this.isName = gs),
              (this.processAttribs = this.processAttribsNS),
              (this.pushAttrib = this.pushAttribNS),
              (this.ns = Object.assign({ __proto__: null }, Me)))
            let r = this.opt.additionalNamespaces
            r != null && (ps(this, r), Object.assign(this.ns, r))
          } else
            ((this.nameStartCheck = B),
              (this.nameCheck = It),
              (this.isName = ms),
              (this.processAttribs = this.processAttribsPlain),
              (this.pushAttrib = this.pushAttribPlain))
          ;((this.stateTable = [
            this.sBegin,
            this.sBeginWhitespace,
            this.sDoctype,
            this.sDoctypeQuote,
            this.sDTD,
            this.sDTDQuoted,
            this.sDTDOpenWaka,
            this.sDTDOpenWakaBang,
            this.sDTDComment,
            this.sDTDCommentEnding,
            this.sDTDCommentEnded,
            this.sDTDPI,
            this.sDTDPIEnding,
            this.sText,
            this.sEntity,
            this.sOpenWaka,
            this.sOpenWakaBang,
            this.sComment,
            this.sCommentEnding,
            this.sCommentEnded,
            this.sCData,
            this.sCDataEnding,
            this.sCDataEnding2,
            this.sPIFirstChar,
            this.sPIRest,
            this.sPIBody,
            this.sPIEnding,
            this.sXMLDeclNameStart,
            this.sXMLDeclName,
            this.sXMLDeclEq,
            this.sXMLDeclValueStart,
            this.sXMLDeclValue,
            this.sXMLDeclSeparator,
            this.sXMLDeclEnding,
            this.sOpenTag,
            this.sOpenTagSlash,
            this.sAttrib,
            this.sAttribName,
            this.sAttribNameSawWhite,
            this.sAttribValue,
            this.sAttribValueQuoted,
            this.sAttribValueClosed,
            this.sAttribValueUnquoted,
            this.sCloseTag,
            this.sCloseTagSawWhite,
          ]),
            this._init())
        }
        get closed() {
          return this._closed
        }
        _init() {
          var t
          ;((this.openWakaBang = ''),
            (this.text = ''),
            (this.name = ''),
            (this.piTarget = ''),
            (this.entity = ''),
            (this.q = null),
            (this.tags = []),
            (this.tag = null),
            (this.topNS = null),
            (this.chunk = ''),
            (this.chunkPosition = 0),
            (this.i = 0),
            (this.prevI = 0),
            (this.carriedFromPrevious = void 0),
            (this.forbiddenState = S),
            (this.attribList = []))
          let { fragmentOpt: s } = this
          ;((this.state = s ? b : Bt),
            (this.reportedTextBeforeRoot =
              this.reportedTextAfterRoot =
              this.closedRoot =
              this.sawRoot =
                s),
            (this.xmlDeclPossible = !s),
            (this.xmlDeclExpects = ['version']),
            (this.entityReturnState = void 0))
          let { defaultXMLVersion: r } = this.opt
          if (r === void 0) {
            if (this.opt.forceXMLVersion === !0)
              throw new Error('forceXMLVersion set but defaultXMLVersion is not set')
            r = '1.0'
          }
          ;(this.setXMLVersion(r),
            (this.positionAtNewLine = 0),
            (this.doctype = !1),
            (this._closed = !1),
            (this.xmlDecl = { version: void 0, encoding: void 0, standalone: void 0 }),
            (this.line = 1),
            (this.column = 0),
            (this.ENTITIES = Object.create(He)),
            (t = this.readyHandler) === null || t === void 0 || t.call(this))
        }
        get position() {
          return this.chunkPosition + this.i
        }
        get columnIndex() {
          return this.position - this.positionAtNewLine
        }
        on(t, s) {
          this[zt[t]] = s
        }
        off(t) {
          this[zt[t]] = void 0
        }
        makeError(t) {
          var s
          let r = (s = this.fileName) !== null && s !== void 0 ? s : ''
          return (
            this.trackPosition &&
              (r.length > 0 && (r += ':'), (r += `${this.line}:${this.column}`)),
            r.length > 0 && (r += ': '),
            new Error(r + t)
          )
        }
        fail(t) {
          let s = this.makeError(t),
            r = this.errorHandler
          if (r === void 0) throw s
          return (r(s), this)
        }
        write(t) {
          if (this.closed) return this.fail('cannot write after close; assign an onready handler.')
          let s = !1
          ;(t === null ? ((s = !0), (t = '')) : typeof t == 'object' && (t = t.toString()),
            this.carriedFromPrevious !== void 0 &&
              ((t = `${this.carriedFromPrevious}${t}`), (this.carriedFromPrevious = void 0)))
          let r = t.length,
            i = t.charCodeAt(r - 1)
          !s &&
            (i === dt || (i >= 55296 && i <= 56319)) &&
            ((this.carriedFromPrevious = t[r - 1]), r--, (t = t.slice(0, r)))
          let { stateTable: o } = this
          for (this.chunk = t, this.i = 0; this.i < r;) o[this.state].call(this)
          return ((this.chunkPosition += r), s ? this.end() : this)
        }
        close() {
          return this.write(null)
        }
        getCode10() {
          let { chunk: t, i: s } = this
          if (((this.prevI = s), (this.i = s + 1), s >= t.length)) return u
          let r = t.charCodeAt(s)
          if ((this.column++, r < 55296)) {
            if (r >= $t || r === ft) return r
            switch (r) {
              case D:
                return (this.line++, (this.column = 0), (this.positionAtNewLine = this.position), D)
              case dt:
                return (
                  t.charCodeAt(s + 1) === D && (this.i = s + 2),
                  this.line++,
                  (this.column = 0),
                  (this.positionAtNewLine = this.position),
                  C
                )
              default:
                return (this.fail('disallowed character.'), r)
            }
          }
          if (r > 56319)
            return ((r >= 57344 && r <= 65533) || this.fail('disallowed character.'), r)
          let i = 65536 + (r - 55296) * 1024 + (t.charCodeAt(s + 1) - 56320)
          return ((this.i = s + 2), i > 1114111 && this.fail('disallowed character.'), i)
        }
        getCode11() {
          let { chunk: t, i: s } = this
          if (((this.prevI = s), (this.i = s + 1), s >= t.length)) return u
          let r = t.charCodeAt(s)
          if ((this.column++, r < 55296)) {
            if ((r > 31 && r < 127) || (r > 159 && r !== Wt) || r === ft) return r
            switch (r) {
              case D:
                return (this.line++, (this.column = 0), (this.positionAtNewLine = this.position), D)
              case dt: {
                let o = t.charCodeAt(s + 1)
                ;(o === D || o === Gt) && (this.i = s + 2)
              }
              case Gt:
              case Wt:
                return (this.line++, (this.column = 0), (this.positionAtNewLine = this.position), C)
              default:
                return (this.fail('disallowed character.'), r)
            }
          }
          if (r > 56319)
            return ((r >= 57344 && r <= 65533) || this.fail('disallowed character.'), r)
          let i = 65536 + (r - 55296) * 1024 + (t.charCodeAt(s + 1) - 56320)
          return ((this.i = s + 2), i > 1114111 && this.fail('disallowed character.'), i)
        }
        getCodeNorm() {
          let t = this.getCode()
          return t === C ? D : t
        }
        unget() {
          ;((this.i = this.prevI), this.column--)
        }
        captureTo(t) {
          let { i: s } = this,
            { chunk: r } = this
          for (;;) {
            let i = this.getCode(),
              o = i === C,
              a = o ? D : i
            if (a === u || t.includes(a)) return ((this.text += r.slice(s, this.prevI)), a)
            o &&
              ((this.text += `${r.slice(s, this.prevI)}
`),
              (s = this.i))
          }
        }
        captureToChar(t) {
          let { i: s } = this,
            { chunk: r } = this
          for (;;) {
            let i = this.getCode()
            switch (i) {
              case C:
                ;((this.text += `${r.slice(s, this.prevI)}
`),
                  (s = this.i),
                  (i = D))
                break
              case u:
                return ((this.text += r.slice(s)), !1)
              default:
            }
            if (i === t) return ((this.text += r.slice(s, this.prevI)), !0)
          }
        }
        captureNameChars() {
          let { chunk: t, i: s } = this
          for (;;) {
            let r = this.getCode()
            if (r === u) return ((this.name += t.slice(s)), u)
            if (!It(r)) return ((this.name += t.slice(s, this.prevI)), r === C ? D : r)
          }
        }
        skipSpaces() {
          for (;;) {
            let t = this.getCodeNorm()
            if (t === u || !w(t)) return t
          }
        }
        setXMLVersion(t) {
          ;((this.currentXMLVersion = t),
            t === '1.0'
              ? ((this.isChar = Re), (this.getCode = this.getCode10))
              : ((this.isChar = Le), (this.getCode = this.getCode11)))
        }
        sBegin() {
          ;(this.chunk.charCodeAt(0) === 65279 && (this.i++, this.column++), (this.state = Oe))
        }
        sBeginWhitespace() {
          let t = this.i,
            s = this.skipSpaces()
          switch ((this.prevI !== t && (this.xmlDeclPossible = !1), s)) {
            case T:
              if (((this.state = ot), this.text.length !== 0))
                throw new Error('no-empty text at start')
              break
            case u:
              break
            default:
              ;(this.unget(), (this.state = b), (this.xmlDeclPossible = !1))
          }
        }
        sDoctype() {
          var t
          let s = this.captureTo(hs)
          switch (s) {
            case d: {
              ;((t = this.doctypeHandler) === null || t === void 0 || t.call(this, this.text),
                (this.text = ''),
                (this.state = b),
                (this.doctype = !0))
              break
            }
            case u:
              break
            default:
              ;((this.text += String.fromCodePoint(s)),
                s === Yt ? (this.state = F) : z(s) && ((this.state = Pe), (this.q = s)))
          }
        }
        sDoctypeQuote() {
          let t = this.q
          this.captureToChar(t) &&
            ((this.text += String.fromCodePoint(t)), (this.q = null), (this.state = it))
        }
        sDTD() {
          let t = this.captureTo(us)
          t !== u &&
            ((this.text += String.fromCodePoint(t)),
            t === R
              ? (this.state = it)
              : t === T
                ? (this.state = Ve)
                : z(t) && ((this.state = Ue), (this.q = t)))
        }
        sDTDQuoted() {
          let t = this.q
          this.captureToChar(t) &&
            ((this.text += String.fromCodePoint(t)), (this.state = F), (this.q = null))
        }
        sDTDOpenWaka() {
          let t = this.getCodeNorm()
          switch (((this.text += String.fromCodePoint(t)), t)) {
            case Xt:
              ;((this.state = $e), (this.openWakaBang = ''))
              break
            case g:
              this.state = We
              break
            default:
              this.state = F
          }
        }
        sDTDOpenWakaBang() {
          let t = String.fromCodePoint(this.getCodeNorm()),
            s = (this.openWakaBang += t)
          ;((this.text += t),
            s !== '-' && ((this.state = s === '--' ? at : F), (this.openWakaBang = '')))
        }
        sDTDComment() {
          this.captureToChar(W) && ((this.text += '-'), (this.state = Xe))
        }
        sDTDCommentEnding() {
          let t = this.getCodeNorm()
          ;((this.text += String.fromCodePoint(t)), (this.state = t === W ? Ge : at))
        }
        sDTDCommentEnded() {
          let t = this.getCodeNorm()
          ;((this.text += String.fromCodePoint(t)),
            t === d ? (this.state = F) : (this.fail('malformed comment.'), (this.state = at)))
        }
        sDTDPI() {
          this.captureToChar(g) && ((this.text += '?'), (this.state = je))
        }
        sDTDPIEnding() {
          let t = this.getCodeNorm()
          ;((this.text += String.fromCodePoint(t)), t === d && (this.state = F))
        }
        sText() {
          this.tags.length !== 0 ? this.handleTextInRoot() : this.handleTextOutsideRoot()
        }
        sEntity() {
          let { i: t } = this,
            { chunk: s } = this
          t: for (;;)
            switch (this.getCode()) {
              case C:
                ;((this.entity += `${s.slice(t, this.prevI)}
`),
                  (t = this.i))
                break
              case cs: {
                let { entityReturnState: r } = this,
                  i = this.entity + s.slice(t, this.prevI)
                this.state = r
                let o
                ;(i === ''
                  ? (this.fail('empty entity name.'), (o = '&;'))
                  : ((o = this.parseEntity(i)), (this.entity = '')),
                  (r !== b || this.textHandler !== void 0) && (this.text += o))
                break t
              }
              case u:
                this.entity += s.slice(t)
                break t
              default:
            }
        }
        sOpenWaka() {
          let t = this.getCode()
          if (B(t)) ((this.state = is), this.unget(), (this.xmlDeclPossible = !1))
          else
            switch (t) {
              case j:
                ;((this.state = ns), (this.xmlDeclPossible = !1))
                break
              case Xt:
                ;((this.state = ze), (this.openWakaBang = ''), (this.xmlDeclPossible = !1))
                break
              case g:
                this.state = Je
                break
              default:
                ;(this.fail('disallowed character in tag name'),
                  (this.state = b),
                  (this.xmlDeclPossible = !1))
            }
        }
        sOpenWakaBang() {
          switch (
            ((this.openWakaBang += String.fromCodePoint(this.getCodeNorm())), this.openWakaBang)
          ) {
            case '[CDATA[':
              ;(!this.sawRoot &&
                !this.reportedTextBeforeRoot &&
                (this.fail('text data outside of root node.'), (this.reportedTextBeforeRoot = !0)),
                this.closedRoot &&
                  !this.reportedTextAfterRoot &&
                  (this.fail('text data outside of root node.'), (this.reportedTextAfterRoot = !0)),
                (this.state = lt),
                (this.openWakaBang = ''))
              break
            case '--':
              ;((this.state = nt), (this.openWakaBang = ''))
              break
            case 'DOCTYPE':
              ;((this.state = it),
                (this.doctype || this.sawRoot) &&
                  this.fail('inappropriately located doctype declaration.'),
                (this.openWakaBang = ''))
              break
            default:
              this.openWakaBang.length >= 7 && this.fail('incorrect syntax.')
          }
        }
        sComment() {
          this.captureToChar(W) && (this.state = Qe)
        }
        sCommentEnding() {
          var t
          let s = this.getCodeNorm()
          s === W
            ? ((this.state = Ke),
              (t = this.commentHandler) === null || t === void 0 || t.call(this, this.text),
              (this.text = ''))
            : ((this.text += `-${String.fromCodePoint(s)}`), (this.state = nt))
        }
        sCommentEnded() {
          let t = this.getCodeNorm()
          t !== d
            ? (this.fail('malformed comment.'),
              (this.text += `--${String.fromCodePoint(t)}`),
              (this.state = nt))
            : (this.state = b)
        }
        sCData() {
          this.captureToChar(R) && (this.state = Ze)
        }
        sCDataEnding() {
          let t = this.getCodeNorm()
          t === R
            ? (this.state = Ye)
            : ((this.text += `]${String.fromCodePoint(t)}`), (this.state = lt))
        }
        sCDataEnding2() {
          var t
          let s = this.getCodeNorm()
          switch (s) {
            case d: {
              ;((t = this.cdataHandler) === null || t === void 0 || t.call(this, this.text),
                (this.text = ''),
                (this.state = b))
              break
            }
            case R:
              this.text += ']'
              break
            default:
              ;((this.text += `]]${String.fromCodePoint(s)}`), (this.state = lt))
          }
        }
        sPIFirstChar() {
          let t = this.getCodeNorm()
          this.nameStartCheck(t)
            ? ((this.piTarget += String.fromCodePoint(t)), (this.state = Mt))
            : t === g || w(t)
              ? (this.fail('processing instruction without a target.'),
                (this.state = t === g ? G : ct))
              : (this.fail('disallowed character in processing instruction name.'),
                (this.piTarget += String.fromCodePoint(t)),
                (this.state = Mt))
        }
        sPIRest() {
          let { chunk: t, i: s } = this
          for (;;) {
            let r = this.getCodeNorm()
            if (r === u) {
              this.piTarget += t.slice(s)
              return
            }
            if (!this.nameCheck(r)) {
              this.piTarget += t.slice(s, this.prevI)
              let i = r === g
              i || w(r)
                ? this.piTarget === 'xml'
                  ? (this.xmlDeclPossible ||
                      this.fail('an XML declaration must be at the start of the document.'),
                    (this.state = i ? _ : Ht))
                  : (this.state = i ? G : ct)
                : (this.fail('disallowed character in processing instruction name.'),
                  (this.piTarget += String.fromCodePoint(r)))
              break
            }
          }
        }
        sPIBody() {
          if (this.text.length === 0) {
            let t = this.getCodeNorm()
            t === g ? (this.state = G) : w(t) || (this.text = String.fromCodePoint(t))
          } else this.captureToChar(g) && (this.state = G)
        }
        sPIEnding() {
          var t
          let s = this.getCodeNorm()
          if (s === d) {
            let { piTarget: r } = this
            ;(r.toLowerCase() === 'xml' &&
              this.fail('the XML declaration must appear at the start of the document.'),
              (t = this.piHandler) === null ||
                t === void 0 ||
                t.call(this, { target: r, body: this.text }),
              (this.piTarget = this.text = ''),
              (this.state = b))
          } else
            s === g
              ? (this.text += '?')
              : ((this.text += `?${String.fromCodePoint(s)}`), (this.state = ct))
          this.xmlDeclPossible = !1
        }
        sXMLDeclNameStart() {
          let t = this.skipSpaces()
          if (t === g) {
            this.state = _
            return
          }
          t !== u && ((this.state = ts), (this.name = String.fromCodePoint(t)))
        }
        sXMLDeclName() {
          let t = this.captureTo(fs)
          if (t === g) {
            ;((this.state = _),
              (this.name += this.text),
              (this.text = ''),
              this.fail('XML declaration is incomplete.'))
            return
          }
          if (w(t) || t === y) {
            if (
              ((this.name += this.text), (this.text = ''), !this.xmlDeclExpects.includes(this.name))
            )
              switch (this.name.length) {
                case 0:
                  this.fail('did not expect any more name/value pairs.')
                  break
                case 1:
                  this.fail(`expected the name ${this.xmlDeclExpects[0]}.`)
                  break
                default:
                  this.fail(`expected one of ${this.xmlDeclExpects.join(', ')}`)
              }
            this.state = t === y ? Ot : es
          }
        }
        sXMLDeclEq() {
          let t = this.getCodeNorm()
          if (t === g) {
            ;((this.state = _), this.fail('XML declaration is incomplete.'))
            return
          }
          w(t) || (t !== y && this.fail('value required.'), (this.state = Ot))
        }
        sXMLDeclValueStart() {
          let t = this.getCodeNorm()
          if (t === g) {
            ;((this.state = _), this.fail('XML declaration is incomplete.'))
            return
          }
          w(t) ||
            (z(t) ? (this.q = t) : (this.fail('value must be quoted.'), (this.q = $t)),
            (this.state = ss))
        }
        sXMLDeclValue() {
          let t = this.captureTo([this.q, g])
          if (t === g) {
            ;((this.state = _), (this.text = ''), this.fail('XML declaration is incomplete.'))
            return
          }
          if (t === u) return
          let s = this.text
          switch (((this.text = ''), this.name)) {
            case 'version': {
              this.xmlDeclExpects = ['encoding', 'standalone']
              let r = s
              ;((this.xmlDecl.version = r),
                /^1\.[0-9]+$/.test(r)
                  ? this.opt.forceXMLVersion || this.setXMLVersion(r)
                  : this.fail('version number must match /^1\\.[0-9]+$/.'))
              break
            }
            case 'encoding':
              ;(/^[A-Za-z][A-Za-z0-9._-]*$/.test(s) ||
                this.fail('encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.'),
                (this.xmlDeclExpects = ['standalone']),
                (this.xmlDecl.encoding = s))
              break
            case 'standalone':
              ;(s !== 'yes' &&
                s !== 'no' &&
                this.fail('standalone value must match "yes" or "no".'),
                (this.xmlDeclExpects = []),
                (this.xmlDecl.standalone = s))
              break
            default:
          }
          ;((this.name = ''), (this.state = rs))
        }
        sXMLDeclSeparator() {
          let t = this.getCodeNorm()
          if (t === g) {
            this.state = _
            return
          }
          ;(w(t) || (this.fail('whitespace required.'), this.unget()), (this.state = Ht))
        }
        sXMLDeclEnding() {
          var t
          ;(this.getCodeNorm() === d
            ? (this.piTarget !== 'xml'
                ? this.fail('processing instructions are not allowed before root.')
                : this.name !== 'version' &&
                  this.xmlDeclExpects.includes('version') &&
                  this.fail('XML declaration must contain a version.'),
              (t = this.xmldeclHandler) === null || t === void 0 || t.call(this, this.xmlDecl),
              (this.name = ''),
              (this.piTarget = this.text = ''),
              (this.state = b))
            : this.fail('The character ? is disallowed anywhere in XML declarations.'),
            (this.xmlDeclPossible = !1))
        }
        sOpenTag() {
          var t
          let s = this.captureNameChars()
          if (s === u) return
          let r = (this.tag = { name: this.name, attributes: Object.create(null) })
          switch (
            ((this.name = ''),
            this.xmlnsOpt && (this.topNS = r.ns = Object.create(null)),
            (t = this.openTagStartHandler) === null || t === void 0 || t.call(this, r),
            (this.sawRoot = !0),
            !this.fragmentOpt &&
              this.closedRoot &&
              this.fail('documents may contain only one root.'),
            s)
          ) {
            case d:
              this.openTag()
              break
            case j:
              this.state = ht
              break
            default:
              ;(w(s) || this.fail('disallowed character in tag name.'), (this.state = M))
          }
        }
        sOpenTagSlash() {
          this.getCode() === d
            ? this.openSelfClosingTag()
            : (this.fail('forward-slash in opening tag not followed by >.'), (this.state = M))
        }
        sAttrib() {
          let t = this.skipSpaces()
          t !== u &&
            (B(t)
              ? (this.unget(), (this.state = ut))
              : t === d
                ? this.openTag()
                : t === j
                  ? (this.state = ht)
                  : this.fail('disallowed character in attribute name.'))
        }
        sAttribName() {
          let t = this.captureNameChars()
          t === y
            ? (this.state = Pt)
            : w(t)
              ? (this.state = as)
              : t === d
                ? (this.fail('attribute without value.'),
                  this.pushAttrib(this.name, this.name),
                  (this.name = this.text = ''),
                  this.openTag())
                : t !== u && this.fail('disallowed character in attribute name.')
        }
        sAttribNameSawWhite() {
          let t = this.skipSpaces()
          switch (t) {
            case u:
              return
            case y:
              this.state = Pt
              break
            default:
              ;(this.fail('attribute without value.'),
                (this.text = ''),
                (this.name = ''),
                t === d
                  ? this.openTag()
                  : B(t)
                    ? (this.unget(), (this.state = ut))
                    : (this.fail('disallowed character in attribute name.'), (this.state = M)))
          }
        }
        sAttribValue() {
          let t = this.getCodeNorm()
          z(t)
            ? ((this.q = t), (this.state = Ut))
            : w(t) || (this.fail('unquoted attribute value.'), (this.state = Vt), this.unget())
        }
        sAttribValueQuoted() {
          let { q: t, chunk: s } = this,
            { i: r } = this
          for (;;)
            switch (this.getCode()) {
              case t:
                ;(this.pushAttrib(this.name, this.text + s.slice(r, this.prevI)),
                  (this.name = this.text = ''),
                  (this.q = null),
                  (this.state = os))
                return
              case H:
                ;((this.text += s.slice(r, this.prevI)),
                  (this.state = X),
                  (this.entityReturnState = Ut))
                return
              case D:
              case C:
              case ft:
                ;((this.text += `${s.slice(r, this.prevI)} `), (r = this.i))
                break
              case T:
                ;((this.text += s.slice(r, this.prevI)), this.fail('disallowed character.'))
                return
              case u:
                this.text += s.slice(r)
                return
              default:
            }
        }
        sAttribValueClosed() {
          let t = this.getCodeNorm()
          w(t)
            ? (this.state = M)
            : t === d
              ? this.openTag()
              : t === j
                ? (this.state = ht)
                : B(t)
                  ? (this.fail('no whitespace between attributes.'),
                    this.unget(),
                    (this.state = ut))
                  : this.fail('disallowed character in attribute name.')
        }
        sAttribValueUnquoted() {
          let t = this.captureTo(ds)
          switch (t) {
            case H:
              ;((this.state = X), (this.entityReturnState = Vt))
              break
            case T:
              this.fail('disallowed character.')
              break
            case u:
              break
            default:
              ;(this.text.includes(']]>') &&
                this.fail('the string "]]>" is disallowed in char data.'),
                this.pushAttrib(this.name, this.text),
                (this.name = this.text = ''),
                t === d ? this.openTag() : (this.state = M))
          }
        }
        sCloseTag() {
          let t = this.captureNameChars()
          t === d
            ? this.closeTag()
            : w(t)
              ? (this.state = ls)
              : t !== u && this.fail('disallowed character in closing tag.')
        }
        sCloseTagSawWhite() {
          switch (this.skipSpaces()) {
            case d:
              this.closeTag()
              break
            case u:
              break
            default:
              this.fail('disallowed character in closing tag.')
          }
        }
        handleTextInRoot() {
          let { i: t, forbiddenState: s } = this,
            { chunk: r, textHandler: i } = this
          t: for (;;)
            switch (this.getCode()) {
              case T: {
                if (((this.state = ot), i !== void 0)) {
                  let { text: o } = this,
                    a = r.slice(t, this.prevI)
                  o.length !== 0 ? (i(o + a), (this.text = '')) : a.length !== 0 && i(a)
                }
                s = S
                break t
              }
              case H:
                ;((this.state = X),
                  (this.entityReturnState = b),
                  i !== void 0 && (this.text += r.slice(t, this.prevI)),
                  (s = S))
                break t
              case R:
                switch (s) {
                  case S:
                    s = jt
                    break
                  case jt:
                    s = pt
                    break
                  case pt:
                    break
                  default:
                    throw new Error('impossible state')
                }
                break
              case d:
                ;(s === pt && this.fail('the string "]]>" is disallowed in char data.'), (s = S))
                break
              case C:
                ;(i !== void 0 &&
                  (this.text += `${r.slice(t, this.prevI)}
`),
                  (t = this.i),
                  (s = S))
                break
              case u:
                i !== void 0 && (this.text += r.slice(t))
                break t
              default:
                s = S
            }
          this.forbiddenState = s
        }
        handleTextOutsideRoot() {
          let { i: t } = this,
            { chunk: s, textHandler: r } = this,
            i = !1
          t: for (;;) {
            let o = this.getCode()
            switch (o) {
              case T: {
                if (((this.state = ot), r !== void 0)) {
                  let { text: a } = this,
                    n = s.slice(t, this.prevI)
                  a.length !== 0 ? (r(a + n), (this.text = '')) : n.length !== 0 && r(n)
                }
                break t
              }
              case H:
                ;((this.state = X),
                  (this.entityReturnState = b),
                  r !== void 0 && (this.text += s.slice(t, this.prevI)),
                  (i = !0))
                break t
              case C:
                ;(r !== void 0 &&
                  (this.text += `${s.slice(t, this.prevI)}
`),
                  (t = this.i))
                break
              case u:
                r !== void 0 && (this.text += s.slice(t))
                break t
              default:
                w(o) || (i = !0)
            }
          }
          i &&
            (!this.sawRoot &&
              !this.reportedTextBeforeRoot &&
              (this.fail('text data outside of root node.'), (this.reportedTextBeforeRoot = !0)),
            this.closedRoot &&
              !this.reportedTextAfterRoot &&
              (this.fail('text data outside of root node.'), (this.reportedTextAfterRoot = !0)))
        }
        pushAttribNS(t, s) {
          var r
          let { prefix: i, local: o } = this.qname(t),
            a = { name: t, prefix: i, local: o, value: s }
          if (
            (this.attribList.push(a),
            (r = this.attributeHandler) === null || r === void 0 || r.call(this, a),
            i === 'xmlns')
          ) {
            let n = s.trim()
            ;(this.currentXMLVersion === '1.0' &&
              n === '' &&
              this.fail('invalid attempt to undefine prefix in XML 1.0'),
              (this.topNS[o] = n),
              gt(this, o, n))
          } else if (t === 'xmlns') {
            let n = s.trim()
            ;((this.topNS[''] = n), gt(this, '', n))
          }
        }
        pushAttribPlain(t, s) {
          var r
          let i = { name: t, value: s }
          ;(this.attribList.push(i),
            (r = this.attributeHandler) === null || r === void 0 || r.call(this, i))
        }
        end() {
          var t, s
          this.sawRoot || this.fail('document must contain a root element.')
          let { tags: r } = this
          for (; r.length > 0;) {
            let o = r.pop()
            this.fail(`unclosed tag: ${o.name}`)
          }
          this.state !== Bt && this.state !== b && this.fail('unexpected end.')
          let { text: i } = this
          return (
            i.length !== 0 &&
              ((t = this.textHandler) === null || t === void 0 || t.call(this, i),
              (this.text = '')),
            (this._closed = !0),
            (s = this.endHandler) === null || s === void 0 || s.call(this),
            this._init(),
            this
          )
        }
        resolve(t) {
          var s, r
          let i = this.topNS[t]
          if (i !== void 0) return i
          let { tags: o } = this
          for (let a = o.length - 1; a >= 0; a--) if (((i = o[a].ns[t]), i !== void 0)) return i
          return (
            (i = this.ns[t]),
            i !== void 0
              ? i
              : (r = (s = this.opt).resolvePrefix) === null || r === void 0
                ? void 0
                : r.call(s, t)
          )
        }
        qname(t) {
          let s = t.indexOf(':')
          if (s === -1) return { prefix: '', local: t }
          let r = t.slice(s + 1),
            i = t.slice(0, s)
          return (
            (i === '' || r === '' || r.includes(':')) && this.fail(`malformed name: ${t}.`),
            { prefix: i, local: r }
          )
        }
        processAttribsNS() {
          var t
          let { attribList: s } = this,
            r = this.tag
          {
            let { prefix: a, local: n } = this.qname(r.name)
            ;((r.prefix = a), (r.local = n))
            let h = (r.uri = (t = this.resolve(a)) !== null && t !== void 0 ? t : '')
            a !== '' &&
              (a === 'xmlns' && this.fail('tags may not have "xmlns" as prefix.'),
              h === '' &&
                (this.fail(`unbound namespace prefix: ${JSON.stringify(a)}.`), (r.uri = a)))
          }
          if (s.length === 0) return
          let { attributes: i } = r,
            o = new Set()
          for (let a of s) {
            let { name: n, prefix: h, local: x } = a,
              p,
              m
            ;(h === ''
              ? ((p = n === 'xmlns' ? q : ''), (m = n))
              : ((p = this.resolve(h)),
                p === void 0 &&
                  (this.fail(`unbound namespace prefix: ${JSON.stringify(h)}.`), (p = h)),
                (m = `{${p}}${x}`)),
              o.has(m) && this.fail(`duplicate attribute: ${m}.`),
              o.add(m),
              (a.uri = p),
              (i[n] = a))
          }
          this.attribList = []
        }
        processAttribsPlain() {
          let { attribList: t } = this,
            s = this.tag.attributes
          for (let { name: r, value: i } of t)
            (s[r] !== void 0 && this.fail(`duplicate attribute: ${r}.`), (s[r] = i))
          this.attribList = []
        }
        openTag() {
          var t
          this.processAttribs()
          let { tags: s } = this,
            r = this.tag
          ;((r.isSelfClosing = !1),
            (t = this.openTagHandler) === null || t === void 0 || t.call(this, r),
            s.push(r),
            (this.state = b),
            (this.name = ''))
        }
        openSelfClosingTag() {
          var t, s, r
          this.processAttribs()
          let { tags: i } = this,
            o = this.tag
          ;((o.isSelfClosing = !0),
            (t = this.openTagHandler) === null || t === void 0 || t.call(this, o),
            (s = this.closeTagHandler) === null || s === void 0 || s.call(this, o),
            (this.tag = (r = i[i.length - 1]) !== null && r !== void 0 ? r : null) === null &&
              (this.closedRoot = !0),
            (this.state = b),
            (this.name = ''))
        }
        closeTag() {
          let { tags: t, name: s } = this
          if (((this.state = b), (this.name = ''), s === '')) {
            ;(this.fail('weird empty close tag.'), (this.text += '</>'))
            return
          }
          let r = this.closeTagHandler,
            i = t.length
          for (; i-- > 0;) {
            let o = (this.tag = t.pop())
            if (((this.topNS = o.ns), r?.(o), o.name === s)) break
            this.fail('unexpected close tag.')
          }
          i === 0
            ? (this.closedRoot = !0)
            : i < 0 && (this.fail(`unmatched closing tag: ${s}.`), (this.text += `</${s}>`))
        }
        parseEntity(t) {
          if (t[0] !== '#') {
            let r = this.ENTITIES[t]
            return r !== void 0
              ? r
              : (this.fail(
                  this.isName(t) ? 'undefined entity.' : 'disallowed character in entity name.',
                ),
                `&${t};`)
          }
          let s = NaN
          return (
            t[1] === 'x' && /^#x[0-9a-f]+$/i.test(t)
              ? (s = parseInt(t.slice(2), 16))
              : /^#[0-9]+$/.test(t) && (s = parseInt(t.slice(1), 10)),
            this.isChar(s)
              ? String.fromCodePoint(s)
              : (this.fail('malformed character entity.'), `&${t};`)
          )
        }
      }
    L.SaxesParser = mt
  })
  var ce = we(te(), 1)
  var ee = {
    AElig: '\xC6',
    AMP: '&',
    Aacute: '\xC1',
    Abreve: '\u0102',
    Acirc: '\xC2',
    Acy: '\u0410',
    Afr: '\u{1D504}',
    Agrave: '\xC0',
    Alpha: '\u0391',
    Amacr: '\u0100',
    And: '\u2A53',
    Aogon: '\u0104',
    Aopf: '\u{1D538}',
    ApplyFunction: '\u2061',
    Aring: '\xC5',
    Ascr: '\u{1D49C}',
    Assign: '\u2254',
    Atilde: '\xC3',
    Auml: '\xC4',
    Backslash: '\u2216',
    Barv: '\u2AE7',
    Barwed: '\u2306',
    Bcy: '\u0411',
    Because: '\u2235',
    Bernoullis: '\u212C',
    Beta: '\u0392',
    Bfr: '\u{1D505}',
    Bopf: '\u{1D539}',
    Breve: '\u02D8',
    Bscr: '\u212C',
    Bumpeq: '\u224E',
    CHcy: '\u0427',
    COPY: '\xA9',
    Cacute: '\u0106',
    Cap: '\u22D2',
    CapitalDifferentialD: '\u2145',
    Cayleys: '\u212D',
    Ccaron: '\u010C',
    Ccedil: '\xC7',
    Ccirc: '\u0108',
    Cconint: '\u2230',
    Cdot: '\u010A',
    Cedilla: '\xB8',
    CenterDot: '\xB7',
    Cfr: '\u212D',
    Chi: '\u03A7',
    CircleDot: '\u2299',
    CircleMinus: '\u2296',
    CirclePlus: '\u2295',
    CircleTimes: '\u2297',
    ClockwiseContourIntegral: '\u2232',
    CloseCurlyDoubleQuote: '\u201D',
    CloseCurlyQuote: '\u2019',
    Colon: '\u2237',
    Colone: '\u2A74',
    Congruent: '\u2261',
    Conint: '\u222F',
    ContourIntegral: '\u222E',
    Copf: '\u2102',
    Coproduct: '\u2210',
    CounterClockwiseContourIntegral: '\u2233',
    Cross: '\u2A2F',
    Cscr: '\u{1D49E}',
    Cup: '\u22D3',
    CupCap: '\u224D',
    DD: '\u2145',
    DDotrahd: '\u2911',
    DJcy: '\u0402',
    DScy: '\u0405',
    DZcy: '\u040F',
    Dagger: '\u2021',
    Darr: '\u21A1',
    Dashv: '\u2AE4',
    Dcaron: '\u010E',
    Dcy: '\u0414',
    Del: '\u2207',
    Delta: '\u0394',
    Dfr: '\u{1D507}',
    DiacriticalAcute: '\xB4',
    DiacriticalDot: '\u02D9',
    DiacriticalDoubleAcute: '\u02DD',
    DiacriticalGrave: '`',
    DiacriticalTilde: '\u02DC',
    Diamond: '\u22C4',
    DifferentialD: '\u2146',
    Dopf: '\u{1D53B}',
    Dot: '\xA8',
    DotDot: '\u20DC',
    DotEqual: '\u2250',
    DoubleContourIntegral: '\u222F',
    DoubleDot: '\xA8',
    DoubleDownArrow: '\u21D3',
    DoubleLeftArrow: '\u21D0',
    DoubleLeftRightArrow: '\u21D4',
    DoubleLeftTee: '\u2AE4',
    DoubleLongLeftArrow: '\u27F8',
    DoubleLongLeftRightArrow: '\u27FA',
    DoubleLongRightArrow: '\u27F9',
    DoubleRightArrow: '\u21D2',
    DoubleRightTee: '\u22A8',
    DoubleUpArrow: '\u21D1',
    DoubleUpDownArrow: '\u21D5',
    DoubleVerticalBar: '\u2225',
    DownArrow: '\u2193',
    DownArrowBar: '\u2913',
    DownArrowUpArrow: '\u21F5',
    DownBreve: '\u0311',
    DownLeftRightVector: '\u2950',
    DownLeftTeeVector: '\u295E',
    DownLeftVector: '\u21BD',
    DownLeftVectorBar: '\u2956',
    DownRightTeeVector: '\u295F',
    DownRightVector: '\u21C1',
    DownRightVectorBar: '\u2957',
    DownTee: '\u22A4',
    DownTeeArrow: '\u21A7',
    Downarrow: '\u21D3',
    Dscr: '\u{1D49F}',
    Dstrok: '\u0110',
    ENG: '\u014A',
    ETH: '\xD0',
    Eacute: '\xC9',
    Ecaron: '\u011A',
    Ecirc: '\xCA',
    Ecy: '\u042D',
    Edot: '\u0116',
    Efr: '\u{1D508}',
    Egrave: '\xC8',
    Element: '\u2208',
    Emacr: '\u0112',
    EmptySmallSquare: '\u25FB',
    EmptyVerySmallSquare: '\u25AB',
    Eogon: '\u0118',
    Eopf: '\u{1D53C}',
    Epsilon: '\u0395',
    Equal: '\u2A75',
    EqualTilde: '\u2242',
    Equilibrium: '\u21CC',
    Escr: '\u2130',
    Esim: '\u2A73',
    Eta: '\u0397',
    Euml: '\xCB',
    Exists: '\u2203',
    ExponentialE: '\u2147',
    Fcy: '\u0424',
    Ffr: '\u{1D509}',
    FilledSmallSquare: '\u25FC',
    FilledVerySmallSquare: '\u25AA',
    Fopf: '\u{1D53D}',
    ForAll: '\u2200',
    Fouriertrf: '\u2131',
    Fscr: '\u2131',
    GJcy: '\u0403',
    GT: '>',
    Gamma: '\u0393',
    Gammad: '\u03DC',
    Gbreve: '\u011E',
    Gcedil: '\u0122',
    Gcirc: '\u011C',
    Gcy: '\u0413',
    Gdot: '\u0120',
    Gfr: '\u{1D50A}',
    Gg: '\u22D9',
    Gopf: '\u{1D53E}',
    GreaterEqual: '\u2265',
    GreaterEqualLess: '\u22DB',
    GreaterFullEqual: '\u2267',
    GreaterGreater: '\u2AA2',
    GreaterLess: '\u2277',
    GreaterSlantEqual: '\u2A7E',
    GreaterTilde: '\u2273',
    Gscr: '\u{1D4A2}',
    Gt: '\u226B',
    HARDcy: '\u042A',
    Hacek: '\u02C7',
    Hat: '^',
    Hcirc: '\u0124',
    Hfr: '\u210C',
    HilbertSpace: '\u210B',
    Hopf: '\u210D',
    HorizontalLine: '\u2500',
    Hscr: '\u210B',
    Hstrok: '\u0126',
    HumpDownHump: '\u224E',
    HumpEqual: '\u224F',
    IEcy: '\u0415',
    IJlig: '\u0132',
    IOcy: '\u0401',
    Iacute: '\xCD',
    Icirc: '\xCE',
    Icy: '\u0418',
    Idot: '\u0130',
    Ifr: '\u2111',
    Igrave: '\xCC',
    Im: '\u2111',
    Imacr: '\u012A',
    ImaginaryI: '\u2148',
    Implies: '\u21D2',
    Int: '\u222C',
    Integral: '\u222B',
    Intersection: '\u22C2',
    InvisibleComma: '\u2063',
    InvisibleTimes: '\u2062',
    Iogon: '\u012E',
    Iopf: '\u{1D540}',
    Iota: '\u0399',
    Iscr: '\u2110',
    Itilde: '\u0128',
    Iukcy: '\u0406',
    Iuml: '\xCF',
    Jcirc: '\u0134',
    Jcy: '\u0419',
    Jfr: '\u{1D50D}',
    Jopf: '\u{1D541}',
    Jscr: '\u{1D4A5}',
    Jsercy: '\u0408',
    Jukcy: '\u0404',
    KHcy: '\u0425',
    KJcy: '\u040C',
    Kappa: '\u039A',
    Kcedil: '\u0136',
    Kcy: '\u041A',
    Kfr: '\u{1D50E}',
    Kopf: '\u{1D542}',
    Kscr: '\u{1D4A6}',
    LJcy: '\u0409',
    LT: '<',
    Lacute: '\u0139',
    Lambda: '\u039B',
    Lang: '\u27EA',
    Laplacetrf: '\u2112',
    Larr: '\u219E',
    Lcaron: '\u013D',
    Lcedil: '\u013B',
    Lcy: '\u041B',
    LeftAngleBracket: '\u27E8',
    LeftArrow: '\u2190',
    LeftArrowBar: '\u21E4',
    LeftArrowRightArrow: '\u21C6',
    LeftCeiling: '\u2308',
    LeftDoubleBracket: '\u27E6',
    LeftDownTeeVector: '\u2961',
    LeftDownVector: '\u21C3',
    LeftDownVectorBar: '\u2959',
    LeftFloor: '\u230A',
    LeftRightArrow: '\u2194',
    LeftRightVector: '\u294E',
    LeftTee: '\u22A3',
    LeftTeeArrow: '\u21A4',
    LeftTeeVector: '\u295A',
    LeftTriangle: '\u22B2',
    LeftTriangleBar: '\u29CF',
    LeftTriangleEqual: '\u22B4',
    LeftUpDownVector: '\u2951',
    LeftUpTeeVector: '\u2960',
    LeftUpVector: '\u21BF',
    LeftUpVectorBar: '\u2958',
    LeftVector: '\u21BC',
    LeftVectorBar: '\u2952',
    Leftarrow: '\u21D0',
    Leftrightarrow: '\u21D4',
    LessEqualGreater: '\u22DA',
    LessFullEqual: '\u2266',
    LessGreater: '\u2276',
    LessLess: '\u2AA1',
    LessSlantEqual: '\u2A7D',
    LessTilde: '\u2272',
    Lfr: '\u{1D50F}',
    Ll: '\u22D8',
    Lleftarrow: '\u21DA',
    Lmidot: '\u013F',
    LongLeftArrow: '\u27F5',
    LongLeftRightArrow: '\u27F7',
    LongRightArrow: '\u27F6',
    Longleftarrow: '\u27F8',
    Longleftrightarrow: '\u27FA',
    Longrightarrow: '\u27F9',
    Lopf: '\u{1D543}',
    LowerLeftArrow: '\u2199',
    LowerRightArrow: '\u2198',
    Lscr: '\u2112',
    Lsh: '\u21B0',
    Lstrok: '\u0141',
    Lt: '\u226A',
    Map: '\u2905',
    Mcy: '\u041C',
    MediumSpace: '\u205F',
    Mellintrf: '\u2133',
    Mfr: '\u{1D510}',
    MinusPlus: '\u2213',
    Mopf: '\u{1D544}',
    Mscr: '\u2133',
    Mu: '\u039C',
    NJcy: '\u040A',
    Nacute: '\u0143',
    Ncaron: '\u0147',
    Ncedil: '\u0145',
    Ncy: '\u041D',
    NegativeMediumSpace: '\u200B',
    NegativeThickSpace: '\u200B',
    NegativeThinSpace: '\u200B',
    NegativeVeryThinSpace: '\u200B',
    NestedGreaterGreater: '\u226B',
    NestedLessLess: '\u226A',
    NewLine: `
`,
    Nfr: '\u{1D511}',
    NoBreak: '\u2060',
    NonBreakingSpace: '\xA0',
    Nopf: '\u2115',
    Not: '\u2AEC',
    NotCongruent: '\u2262',
    NotCupCap: '\u226D',
    NotDoubleVerticalBar: '\u2226',
    NotElement: '\u2209',
    NotEqual: '\u2260',
    NotEqualTilde: '\u2242\u0338',
    NotExists: '\u2204',
    NotGreater: '\u226F',
    NotGreaterEqual: '\u2271',
    NotGreaterFullEqual: '\u2267\u0338',
    NotGreaterGreater: '\u226B\u0338',
    NotGreaterLess: '\u2279',
    NotGreaterSlantEqual: '\u2A7E\u0338',
    NotGreaterTilde: '\u2275',
    NotHumpDownHump: '\u224E\u0338',
    NotHumpEqual: '\u224F\u0338',
    NotLeftTriangle: '\u22EA',
    NotLeftTriangleBar: '\u29CF\u0338',
    NotLeftTriangleEqual: '\u22EC',
    NotLess: '\u226E',
    NotLessEqual: '\u2270',
    NotLessGreater: '\u2278',
    NotLessLess: '\u226A\u0338',
    NotLessSlantEqual: '\u2A7D\u0338',
    NotLessTilde: '\u2274',
    NotNestedGreaterGreater: '\u2AA2\u0338',
    NotNestedLessLess: '\u2AA1\u0338',
    NotPrecedes: '\u2280',
    NotPrecedesEqual: '\u2AAF\u0338',
    NotPrecedesSlantEqual: '\u22E0',
    NotReverseElement: '\u220C',
    NotRightTriangle: '\u22EB',
    NotRightTriangleBar: '\u29D0\u0338',
    NotRightTriangleEqual: '\u22ED',
    NotSquareSubset: '\u228F\u0338',
    NotSquareSubsetEqual: '\u22E2',
    NotSquareSuperset: '\u2290\u0338',
    NotSquareSupersetEqual: '\u22E3',
    NotSubset: '\u2282\u20D2',
    NotSubsetEqual: '\u2288',
    NotSucceeds: '\u2281',
    NotSucceedsEqual: '\u2AB0\u0338',
    NotSucceedsSlantEqual: '\u22E1',
    NotSucceedsTilde: '\u227F\u0338',
    NotSuperset: '\u2283\u20D2',
    NotSupersetEqual: '\u2289',
    NotTilde: '\u2241',
    NotTildeEqual: '\u2244',
    NotTildeFullEqual: '\u2247',
    NotTildeTilde: '\u2249',
    NotVerticalBar: '\u2224',
    Nscr: '\u{1D4A9}',
    Ntilde: '\xD1',
    Nu: '\u039D',
    OElig: '\u0152',
    Oacute: '\xD3',
    Ocirc: '\xD4',
    Ocy: '\u041E',
    Odblac: '\u0150',
    Ofr: '\u{1D512}',
    Ograve: '\xD2',
    Omacr: '\u014C',
    Omega: '\u03A9',
    Omicron: '\u039F',
    Oopf: '\u{1D546}',
    OpenCurlyDoubleQuote: '\u201C',
    OpenCurlyQuote: '\u2018',
    Or: '\u2A54',
    Oscr: '\u{1D4AA}',
    Oslash: '\xD8',
    Otilde: '\xD5',
    Otimes: '\u2A37',
    Ouml: '\xD6',
    OverBar: '\u203E',
    OverBrace: '\u23DE',
    OverBracket: '\u23B4',
    OverParenthesis: '\u23DC',
    PartialD: '\u2202',
    Pcy: '\u041F',
    Pfr: '\u{1D513}',
    Phi: '\u03A6',
    Pi: '\u03A0',
    PlusMinus: '\xB1',
    Poincareplane: '\u210C',
    Popf: '\u2119',
    Pr: '\u2ABB',
    Precedes: '\u227A',
    PrecedesEqual: '\u2AAF',
    PrecedesSlantEqual: '\u227C',
    PrecedesTilde: '\u227E',
    Prime: '\u2033',
    Product: '\u220F',
    Proportion: '\u2237',
    Proportional: '\u221D',
    Pscr: '\u{1D4AB}',
    Psi: '\u03A8',
    QUOT: '"',
    Qfr: '\u{1D514}',
    Qopf: '\u211A',
    Qscr: '\u{1D4AC}',
    RBarr: '\u2910',
    REG: '\xAE',
    Racute: '\u0154',
    Rang: '\u27EB',
    Rarr: '\u21A0',
    Rarrtl: '\u2916',
    Rcaron: '\u0158',
    Rcedil: '\u0156',
    Rcy: '\u0420',
    Re: '\u211C',
    ReverseElement: '\u220B',
    ReverseEquilibrium: '\u21CB',
    ReverseUpEquilibrium: '\u296F',
    Rfr: '\u211C',
    Rho: '\u03A1',
    RightAngleBracket: '\u27E9',
    RightArrow: '\u2192',
    RightArrowBar: '\u21E5',
    RightArrowLeftArrow: '\u21C4',
    RightCeiling: '\u2309',
    RightDoubleBracket: '\u27E7',
    RightDownTeeVector: '\u295D',
    RightDownVector: '\u21C2',
    RightDownVectorBar: '\u2955',
    RightFloor: '\u230B',
    RightTee: '\u22A2',
    RightTeeArrow: '\u21A6',
    RightTeeVector: '\u295B',
    RightTriangle: '\u22B3',
    RightTriangleBar: '\u29D0',
    RightTriangleEqual: '\u22B5',
    RightUpDownVector: '\u294F',
    RightUpTeeVector: '\u295C',
    RightUpVector: '\u21BE',
    RightUpVectorBar: '\u2954',
    RightVector: '\u21C0',
    RightVectorBar: '\u2953',
    Rightarrow: '\u21D2',
    Ropf: '\u211D',
    RoundImplies: '\u2970',
    Rrightarrow: '\u21DB',
    Rscr: '\u211B',
    Rsh: '\u21B1',
    RuleDelayed: '\u29F4',
    SHCHcy: '\u0429',
    SHcy: '\u0428',
    SOFTcy: '\u042C',
    Sacute: '\u015A',
    Sc: '\u2ABC',
    Scaron: '\u0160',
    Scedil: '\u015E',
    Scirc: '\u015C',
    Scy: '\u0421',
    Sfr: '\u{1D516}',
    ShortDownArrow: '\u2193',
    ShortLeftArrow: '\u2190',
    ShortRightArrow: '\u2192',
    ShortUpArrow: '\u2191',
    Sigma: '\u03A3',
    SmallCircle: '\u2218',
    Sopf: '\u{1D54A}',
    Sqrt: '\u221A',
    Square: '\u25A1',
    SquareIntersection: '\u2293',
    SquareSubset: '\u228F',
    SquareSubsetEqual: '\u2291',
    SquareSuperset: '\u2290',
    SquareSupersetEqual: '\u2292',
    SquareUnion: '\u2294',
    Sscr: '\u{1D4AE}',
    Star: '\u22C6',
    Sub: '\u22D0',
    Subset: '\u22D0',
    SubsetEqual: '\u2286',
    Succeeds: '\u227B',
    SucceedsEqual: '\u2AB0',
    SucceedsSlantEqual: '\u227D',
    SucceedsTilde: '\u227F',
    SuchThat: '\u220B',
    Sum: '\u2211',
    Sup: '\u22D1',
    Superset: '\u2283',
    SupersetEqual: '\u2287',
    Supset: '\u22D1',
    THORN: '\xDE',
    TRADE: '\u2122',
    TSHcy: '\u040B',
    TScy: '\u0426',
    Tab: '	',
    Tau: '\u03A4',
    Tcaron: '\u0164',
    Tcedil: '\u0162',
    Tcy: '\u0422',
    Tfr: '\u{1D517}',
    Therefore: '\u2234',
    Theta: '\u0398',
    ThickSpace: '\u205F\u200A',
    ThinSpace: '\u2009',
    Tilde: '\u223C',
    TildeEqual: '\u2243',
    TildeFullEqual: '\u2245',
    TildeTilde: '\u2248',
    Topf: '\u{1D54B}',
    TripleDot: '\u20DB',
    Tscr: '\u{1D4AF}',
    Tstrok: '\u0166',
    Uacute: '\xDA',
    Uarr: '\u219F',
    Uarrocir: '\u2949',
    Ubrcy: '\u040E',
    Ubreve: '\u016C',
    Ucirc: '\xDB',
    Ucy: '\u0423',
    Udblac: '\u0170',
    Ufr: '\u{1D518}',
    Ugrave: '\xD9',
    Umacr: '\u016A',
    UnderBar: '_',
    UnderBrace: '\u23DF',
    UnderBracket: '\u23B5',
    UnderParenthesis: '\u23DD',
    Union: '\u22C3',
    UnionPlus: '\u228E',
    Uogon: '\u0172',
    Uopf: '\u{1D54C}',
    UpArrow: '\u2191',
    UpArrowBar: '\u2912',
    UpArrowDownArrow: '\u21C5',
    UpDownArrow: '\u2195',
    UpEquilibrium: '\u296E',
    UpTee: '\u22A5',
    UpTeeArrow: '\u21A5',
    Uparrow: '\u21D1',
    Updownarrow: '\u21D5',
    UpperLeftArrow: '\u2196',
    UpperRightArrow: '\u2197',
    Upsi: '\u03D2',
    Upsilon: '\u03A5',
    Uring: '\u016E',
    Uscr: '\u{1D4B0}',
    Utilde: '\u0168',
    Uuml: '\xDC',
    VDash: '\u22AB',
    Vbar: '\u2AEB',
    Vcy: '\u0412',
    Vdash: '\u22A9',
    Vdashl: '\u2AE6',
    Vee: '\u22C1',
    Verbar: '\u2016',
    Vert: '\u2016',
    VerticalBar: '\u2223',
    VerticalLine: '|',
    VerticalSeparator: '\u2758',
    VerticalTilde: '\u2240',
    VeryThinSpace: '\u200A',
    Vfr: '\u{1D519}',
    Vopf: '\u{1D54D}',
    Vscr: '\u{1D4B1}',
    Vvdash: '\u22AA',
    Wcirc: '\u0174',
    Wedge: '\u22C0',
    Wfr: '\u{1D51A}',
    Wopf: '\u{1D54E}',
    Wscr: '\u{1D4B2}',
    Xfr: '\u{1D51B}',
    Xi: '\u039E',
    Xopf: '\u{1D54F}',
    Xscr: '\u{1D4B3}',
    YAcy: '\u042F',
    YIcy: '\u0407',
    YUcy: '\u042E',
    Yacute: '\xDD',
    Ycirc: '\u0176',
    Ycy: '\u042B',
    Yfr: '\u{1D51C}',
    Yopf: '\u{1D550}',
    Yscr: '\u{1D4B4}',
    Yuml: '\u0178',
    ZHcy: '\u0416',
    Zacute: '\u0179',
    Zcaron: '\u017D',
    Zcy: '\u0417',
    Zdot: '\u017B',
    ZeroWidthSpace: '\u200B',
    Zeta: '\u0396',
    Zfr: '\u2128',
    Zopf: '\u2124',
    Zscr: '\u{1D4B5}',
    aacute: '\xE1',
    abreve: '\u0103',
    ac: '\u223E',
    acE: '\u223E\u0333',
    acd: '\u223F',
    acirc: '\xE2',
    acute: '\xB4',
    acy: '\u0430',
    aelig: '\xE6',
    af: '\u2061',
    afr: '\u{1D51E}',
    agrave: '\xE0',
    alefsym: '\u2135',
    aleph: '\u2135',
    alpha: '\u03B1',
    amacr: '\u0101',
    amalg: '\u2A3F',
    amp: '&',
    and: '\u2227',
    andand: '\u2A55',
    andd: '\u2A5C',
    andslope: '\u2A58',
    andv: '\u2A5A',
    ang: '\u2220',
    ange: '\u29A4',
    angle: '\u2220',
    angmsd: '\u2221',
    angmsdaa: '\u29A8',
    angmsdab: '\u29A9',
    angmsdac: '\u29AA',
    angmsdad: '\u29AB',
    angmsdae: '\u29AC',
    angmsdaf: '\u29AD',
    angmsdag: '\u29AE',
    angmsdah: '\u29AF',
    angrt: '\u221F',
    angrtvb: '\u22BE',
    angrtvbd: '\u299D',
    angsph: '\u2222',
    angst: '\xC5',
    angzarr: '\u237C',
    aogon: '\u0105',
    aopf: '\u{1D552}',
    ap: '\u2248',
    apE: '\u2A70',
    apacir: '\u2A6F',
    ape: '\u224A',
    apid: '\u224B',
    apos: "'",
    approx: '\u2248',
    approxeq: '\u224A',
    aring: '\xE5',
    ascr: '\u{1D4B6}',
    ast: '*',
    asymp: '\u2248',
    asympeq: '\u224D',
    atilde: '\xE3',
    auml: '\xE4',
    awconint: '\u2233',
    awint: '\u2A11',
    bNot: '\u2AED',
    backcong: '\u224C',
    backepsilon: '\u03F6',
    backprime: '\u2035',
    backsim: '\u223D',
    backsimeq: '\u22CD',
    barvee: '\u22BD',
    barwed: '\u2305',
    barwedge: '\u2305',
    bbrk: '\u23B5',
    bbrktbrk: '\u23B6',
    bcong: '\u224C',
    bcy: '\u0431',
    bdquo: '\u201E',
    becaus: '\u2235',
    because: '\u2235',
    bemptyv: '\u29B0',
    bepsi: '\u03F6',
    bernou: '\u212C',
    beta: '\u03B2',
    beth: '\u2136',
    between: '\u226C',
    bfr: '\u{1D51F}',
    bigcap: '\u22C2',
    bigcirc: '\u25EF',
    bigcup: '\u22C3',
    bigodot: '\u2A00',
    bigoplus: '\u2A01',
    bigotimes: '\u2A02',
    bigsqcup: '\u2A06',
    bigstar: '\u2605',
    bigtriangledown: '\u25BD',
    bigtriangleup: '\u25B3',
    biguplus: '\u2A04',
    bigvee: '\u22C1',
    bigwedge: '\u22C0',
    bkarow: '\u290D',
    blacklozenge: '\u29EB',
    blacksquare: '\u25AA',
    blacktriangle: '\u25B4',
    blacktriangledown: '\u25BE',
    blacktriangleleft: '\u25C2',
    blacktriangleright: '\u25B8',
    blank: '\u2423',
    blk12: '\u2592',
    blk14: '\u2591',
    blk34: '\u2593',
    block: '\u2588',
    bne: '=\u20E5',
    bnequiv: '\u2261\u20E5',
    bnot: '\u2310',
    bopf: '\u{1D553}',
    bot: '\u22A5',
    bottom: '\u22A5',
    bowtie: '\u22C8',
    boxDL: '\u2557',
    boxDR: '\u2554',
    boxDl: '\u2556',
    boxDr: '\u2553',
    boxH: '\u2550',
    boxHD: '\u2566',
    boxHU: '\u2569',
    boxHd: '\u2564',
    boxHu: '\u2567',
    boxUL: '\u255D',
    boxUR: '\u255A',
    boxUl: '\u255C',
    boxUr: '\u2559',
    boxV: '\u2551',
    boxVH: '\u256C',
    boxVL: '\u2563',
    boxVR: '\u2560',
    boxVh: '\u256B',
    boxVl: '\u2562',
    boxVr: '\u255F',
    boxbox: '\u29C9',
    boxdL: '\u2555',
    boxdR: '\u2552',
    boxdl: '\u2510',
    boxdr: '\u250C',
    boxh: '\u2500',
    boxhD: '\u2565',
    boxhU: '\u2568',
    boxhd: '\u252C',
    boxhu: '\u2534',
    boxminus: '\u229F',
    boxplus: '\u229E',
    boxtimes: '\u22A0',
    boxuL: '\u255B',
    boxuR: '\u2558',
    boxul: '\u2518',
    boxur: '\u2514',
    boxv: '\u2502',
    boxvH: '\u256A',
    boxvL: '\u2561',
    boxvR: '\u255E',
    boxvh: '\u253C',
    boxvl: '\u2524',
    boxvr: '\u251C',
    bprime: '\u2035',
    breve: '\u02D8',
    brvbar: '\xA6',
    bscr: '\u{1D4B7}',
    bsemi: '\u204F',
    bsim: '\u223D',
    bsime: '\u22CD',
    bsol: '\\',
    bsolb: '\u29C5',
    bsolhsub: '\u27C8',
    bull: '\u2022',
    bullet: '\u2022',
    bump: '\u224E',
    bumpE: '\u2AAE',
    bumpe: '\u224F',
    bumpeq: '\u224F',
    cacute: '\u0107',
    cap: '\u2229',
    capand: '\u2A44',
    capbrcup: '\u2A49',
    capcap: '\u2A4B',
    capcup: '\u2A47',
    capdot: '\u2A40',
    caps: '\u2229\uFE00',
    caret: '\u2041',
    caron: '\u02C7',
    ccaps: '\u2A4D',
    ccaron: '\u010D',
    ccedil: '\xE7',
    ccirc: '\u0109',
    ccups: '\u2A4C',
    ccupssm: '\u2A50',
    cdot: '\u010B',
    cedil: '\xB8',
    cemptyv: '\u29B2',
    cent: '\xA2',
    centerdot: '\xB7',
    cfr: '\u{1D520}',
    chcy: '\u0447',
    check: '\u2713',
    checkmark: '\u2713',
    chi: '\u03C7',
    cir: '\u25CB',
    cirE: '\u29C3',
    circ: '\u02C6',
    circeq: '\u2257',
    circlearrowleft: '\u21BA',
    circlearrowright: '\u21BB',
    circledR: '\xAE',
    circledS: '\u24C8',
    circledast: '\u229B',
    circledcirc: '\u229A',
    circleddash: '\u229D',
    cire: '\u2257',
    cirfnint: '\u2A10',
    cirmid: '\u2AEF',
    cirscir: '\u29C2',
    clubs: '\u2663',
    clubsuit: '\u2663',
    colon: ':',
    colone: '\u2254',
    coloneq: '\u2254',
    comma: ',',
    commat: '@',
    comp: '\u2201',
    compfn: '\u2218',
    complement: '\u2201',
    complexes: '\u2102',
    cong: '\u2245',
    congdot: '\u2A6D',
    conint: '\u222E',
    copf: '\u{1D554}',
    coprod: '\u2210',
    copy: '\xA9',
    copysr: '\u2117',
    crarr: '\u21B5',
    cross: '\u2717',
    cscr: '\u{1D4B8}',
    csub: '\u2ACF',
    csube: '\u2AD1',
    csup: '\u2AD0',
    csupe: '\u2AD2',
    ctdot: '\u22EF',
    cudarrl: '\u2938',
    cudarrr: '\u2935',
    cuepr: '\u22DE',
    cuesc: '\u22DF',
    cularr: '\u21B6',
    cularrp: '\u293D',
    cup: '\u222A',
    cupbrcap: '\u2A48',
    cupcap: '\u2A46',
    cupcup: '\u2A4A',
    cupdot: '\u228D',
    cupor: '\u2A45',
    cups: '\u222A\uFE00',
    curarr: '\u21B7',
    curarrm: '\u293C',
    curlyeqprec: '\u22DE',
    curlyeqsucc: '\u22DF',
    curlyvee: '\u22CE',
    curlywedge: '\u22CF',
    curren: '\xA4',
    curvearrowleft: '\u21B6',
    curvearrowright: '\u21B7',
    cuvee: '\u22CE',
    cuwed: '\u22CF',
    cwconint: '\u2232',
    cwint: '\u2231',
    cylcty: '\u232D',
    dArr: '\u21D3',
    dHar: '\u2965',
    dagger: '\u2020',
    daleth: '\u2138',
    darr: '\u2193',
    dash: '\u2010',
    dashv: '\u22A3',
    dbkarow: '\u290F',
    dblac: '\u02DD',
    dcaron: '\u010F',
    dcy: '\u0434',
    dd: '\u2146',
    ddagger: '\u2021',
    ddarr: '\u21CA',
    ddotseq: '\u2A77',
    deg: '\xB0',
    delta: '\u03B4',
    demptyv: '\u29B1',
    dfisht: '\u297F',
    dfr: '\u{1D521}',
    dharl: '\u21C3',
    dharr: '\u21C2',
    diam: '\u22C4',
    diamond: '\u22C4',
    diamondsuit: '\u2666',
    diams: '\u2666',
    die: '\xA8',
    digamma: '\u03DD',
    disin: '\u22F2',
    div: '\xF7',
    divide: '\xF7',
    divideontimes: '\u22C7',
    divonx: '\u22C7',
    djcy: '\u0452',
    dlcorn: '\u231E',
    dlcrop: '\u230D',
    dollar: '$',
    dopf: '\u{1D555}',
    dot: '\u02D9',
    doteq: '\u2250',
    doteqdot: '\u2251',
    dotminus: '\u2238',
    dotplus: '\u2214',
    dotsquare: '\u22A1',
    doublebarwedge: '\u2306',
    downarrow: '\u2193',
    downdownarrows: '\u21CA',
    downharpoonleft: '\u21C3',
    downharpoonright: '\u21C2',
    drbkarow: '\u2910',
    drcorn: '\u231F',
    drcrop: '\u230C',
    dscr: '\u{1D4B9}',
    dscy: '\u0455',
    dsol: '\u29F6',
    dstrok: '\u0111',
    dtdot: '\u22F1',
    dtri: '\u25BF',
    dtrif: '\u25BE',
    duarr: '\u21F5',
    duhar: '\u296F',
    dwangle: '\u29A6',
    dzcy: '\u045F',
    dzigrarr: '\u27FF',
    eDDot: '\u2A77',
    eDot: '\u2251',
    eacute: '\xE9',
    easter: '\u2A6E',
    ecaron: '\u011B',
    ecir: '\u2256',
    ecirc: '\xEA',
    ecolon: '\u2255',
    ecy: '\u044D',
    edot: '\u0117',
    ee: '\u2147',
    efDot: '\u2252',
    efr: '\u{1D522}',
    eg: '\u2A9A',
    egrave: '\xE8',
    egs: '\u2A96',
    egsdot: '\u2A98',
    el: '\u2A99',
    elinters: '\u23E7',
    ell: '\u2113',
    els: '\u2A95',
    elsdot: '\u2A97',
    emacr: '\u0113',
    empty: '\u2205',
    emptyset: '\u2205',
    emptyv: '\u2205',
    emsp13: '\u2004',
    emsp14: '\u2005',
    emsp: '\u2003',
    eng: '\u014B',
    ensp: '\u2002',
    eogon: '\u0119',
    eopf: '\u{1D556}',
    epar: '\u22D5',
    eparsl: '\u29E3',
    eplus: '\u2A71',
    epsi: '\u03B5',
    epsilon: '\u03B5',
    epsiv: '\u03F5',
    eqcirc: '\u2256',
    eqcolon: '\u2255',
    eqsim: '\u2242',
    eqslantgtr: '\u2A96',
    eqslantless: '\u2A95',
    equals: '=',
    equest: '\u225F',
    equiv: '\u2261',
    equivDD: '\u2A78',
    eqvparsl: '\u29E5',
    erDot: '\u2253',
    erarr: '\u2971',
    escr: '\u212F',
    esdot: '\u2250',
    esim: '\u2242',
    eta: '\u03B7',
    eth: '\xF0',
    euml: '\xEB',
    euro: '\u20AC',
    excl: '!',
    exist: '\u2203',
    expectation: '\u2130',
    exponentiale: '\u2147',
    fallingdotseq: '\u2252',
    fcy: '\u0444',
    female: '\u2640',
    ffilig: '\uFB03',
    fflig: '\uFB00',
    ffllig: '\uFB04',
    ffr: '\u{1D523}',
    filig: '\uFB01',
    fjlig: 'fj',
    flat: '\u266D',
    fllig: '\uFB02',
    fltns: '\u25B1',
    fnof: '\u0192',
    fopf: '\u{1D557}',
    forall: '\u2200',
    fork: '\u22D4',
    forkv: '\u2AD9',
    fpartint: '\u2A0D',
    frac12: '\xBD',
    frac13: '\u2153',
    frac14: '\xBC',
    frac15: '\u2155',
    frac16: '\u2159',
    frac18: '\u215B',
    frac23: '\u2154',
    frac25: '\u2156',
    frac34: '\xBE',
    frac35: '\u2157',
    frac38: '\u215C',
    frac45: '\u2158',
    frac56: '\u215A',
    frac58: '\u215D',
    frac78: '\u215E',
    frasl: '\u2044',
    frown: '\u2322',
    fscr: '\u{1D4BB}',
    gE: '\u2267',
    gEl: '\u2A8C',
    gacute: '\u01F5',
    gamma: '\u03B3',
    gammad: '\u03DD',
    gap: '\u2A86',
    gbreve: '\u011F',
    gcirc: '\u011D',
    gcy: '\u0433',
    gdot: '\u0121',
    ge: '\u2265',
    gel: '\u22DB',
    geq: '\u2265',
    geqq: '\u2267',
    geqslant: '\u2A7E',
    ges: '\u2A7E',
    gescc: '\u2AA9',
    gesdot: '\u2A80',
    gesdoto: '\u2A82',
    gesdotol: '\u2A84',
    gesl: '\u22DB\uFE00',
    gesles: '\u2A94',
    gfr: '\u{1D524}',
    gg: '\u226B',
    ggg: '\u22D9',
    gimel: '\u2137',
    gjcy: '\u0453',
    gl: '\u2277',
    glE: '\u2A92',
    gla: '\u2AA5',
    glj: '\u2AA4',
    gnE: '\u2269',
    gnap: '\u2A8A',
    gnapprox: '\u2A8A',
    gne: '\u2A88',
    gneq: '\u2A88',
    gneqq: '\u2269',
    gnsim: '\u22E7',
    gopf: '\u{1D558}',
    grave: '`',
    gscr: '\u210A',
    gsim: '\u2273',
    gsime: '\u2A8E',
    gsiml: '\u2A90',
    gt: '>',
    gtcc: '\u2AA7',
    gtcir: '\u2A7A',
    gtdot: '\u22D7',
    gtlPar: '\u2995',
    gtquest: '\u2A7C',
    gtrapprox: '\u2A86',
    gtrarr: '\u2978',
    gtrdot: '\u22D7',
    gtreqless: '\u22DB',
    gtreqqless: '\u2A8C',
    gtrless: '\u2277',
    gtrsim: '\u2273',
    gvertneqq: '\u2269\uFE00',
    gvnE: '\u2269\uFE00',
    hArr: '\u21D4',
    hairsp: '\u200A',
    half: '\xBD',
    hamilt: '\u210B',
    hardcy: '\u044A',
    harr: '\u2194',
    harrcir: '\u2948',
    harrw: '\u21AD',
    hbar: '\u210F',
    hcirc: '\u0125',
    hearts: '\u2665',
    heartsuit: '\u2665',
    hellip: '\u2026',
    hercon: '\u22B9',
    hfr: '\u{1D525}',
    hksearow: '\u2925',
    hkswarow: '\u2926',
    hoarr: '\u21FF',
    homtht: '\u223B',
    hookleftarrow: '\u21A9',
    hookrightarrow: '\u21AA',
    hopf: '\u{1D559}',
    horbar: '\u2015',
    hscr: '\u{1D4BD}',
    hslash: '\u210F',
    hstrok: '\u0127',
    hybull: '\u2043',
    hyphen: '\u2010',
    iacute: '\xED',
    ic: '\u2063',
    icirc: '\xEE',
    icy: '\u0438',
    iecy: '\u0435',
    iexcl: '\xA1',
    iff: '\u21D4',
    ifr: '\u{1D526}',
    igrave: '\xEC',
    ii: '\u2148',
    iiiint: '\u2A0C',
    iiint: '\u222D',
    iinfin: '\u29DC',
    iiota: '\u2129',
    ijlig: '\u0133',
    imacr: '\u012B',
    image: '\u2111',
    imagline: '\u2110',
    imagpart: '\u2111',
    imath: '\u0131',
    imof: '\u22B7',
    imped: '\u01B5',
    in: '\u2208',
    incare: '\u2105',
    infin: '\u221E',
    infintie: '\u29DD',
    inodot: '\u0131',
    int: '\u222B',
    intcal: '\u22BA',
    integers: '\u2124',
    intercal: '\u22BA',
    intlarhk: '\u2A17',
    intprod: '\u2A3C',
    iocy: '\u0451',
    iogon: '\u012F',
    iopf: '\u{1D55A}',
    iota: '\u03B9',
    iprod: '\u2A3C',
    iquest: '\xBF',
    iscr: '\u{1D4BE}',
    isin: '\u2208',
    isinE: '\u22F9',
    isindot: '\u22F5',
    isins: '\u22F4',
    isinsv: '\u22F3',
    isinv: '\u2208',
    it: '\u2062',
    itilde: '\u0129',
    iukcy: '\u0456',
    iuml: '\xEF',
    jcirc: '\u0135',
    jcy: '\u0439',
    jfr: '\u{1D527}',
    jmath: '\u0237',
    jopf: '\u{1D55B}',
    jscr: '\u{1D4BF}',
    jsercy: '\u0458',
    jukcy: '\u0454',
    kappa: '\u03BA',
    kappav: '\u03F0',
    kcedil: '\u0137',
    kcy: '\u043A',
    kfr: '\u{1D528}',
    kgreen: '\u0138',
    khcy: '\u0445',
    kjcy: '\u045C',
    kopf: '\u{1D55C}',
    kscr: '\u{1D4C0}',
    lAarr: '\u21DA',
    lArr: '\u21D0',
    lAtail: '\u291B',
    lBarr: '\u290E',
    lE: '\u2266',
    lEg: '\u2A8B',
    lHar: '\u2962',
    lacute: '\u013A',
    laemptyv: '\u29B4',
    lagran: '\u2112',
    lambda: '\u03BB',
    lang: '\u27E8',
    langd: '\u2991',
    langle: '\u27E8',
    lap: '\u2A85',
    laquo: '\xAB',
    larr: '\u2190',
    larrb: '\u21E4',
    larrbfs: '\u291F',
    larrfs: '\u291D',
    larrhk: '\u21A9',
    larrlp: '\u21AB',
    larrpl: '\u2939',
    larrsim: '\u2973',
    larrtl: '\u21A2',
    lat: '\u2AAB',
    latail: '\u2919',
    late: '\u2AAD',
    lates: '\u2AAD\uFE00',
    lbarr: '\u290C',
    lbbrk: '\u2772',
    lbrace: '{',
    lbrack: '[',
    lbrke: '\u298B',
    lbrksld: '\u298F',
    lbrkslu: '\u298D',
    lcaron: '\u013E',
    lcedil: '\u013C',
    lceil: '\u2308',
    lcub: '{',
    lcy: '\u043B',
    ldca: '\u2936',
    ldquo: '\u201C',
    ldquor: '\u201E',
    ldrdhar: '\u2967',
    ldrushar: '\u294B',
    ldsh: '\u21B2',
    le: '\u2264',
    leftarrow: '\u2190',
    leftarrowtail: '\u21A2',
    leftharpoondown: '\u21BD',
    leftharpoonup: '\u21BC',
    leftleftarrows: '\u21C7',
    leftrightarrow: '\u2194',
    leftrightarrows: '\u21C6',
    leftrightharpoons: '\u21CB',
    leftrightsquigarrow: '\u21AD',
    leftthreetimes: '\u22CB',
    leg: '\u22DA',
    leq: '\u2264',
    leqq: '\u2266',
    leqslant: '\u2A7D',
    les: '\u2A7D',
    lescc: '\u2AA8',
    lesdot: '\u2A7F',
    lesdoto: '\u2A81',
    lesdotor: '\u2A83',
    lesg: '\u22DA\uFE00',
    lesges: '\u2A93',
    lessapprox: '\u2A85',
    lessdot: '\u22D6',
    lesseqgtr: '\u22DA',
    lesseqqgtr: '\u2A8B',
    lessgtr: '\u2276',
    lesssim: '\u2272',
    lfisht: '\u297C',
    lfloor: '\u230A',
    lfr: '\u{1D529}',
    lg: '\u2276',
    lgE: '\u2A91',
    lhard: '\u21BD',
    lharu: '\u21BC',
    lharul: '\u296A',
    lhblk: '\u2584',
    ljcy: '\u0459',
    ll: '\u226A',
    llarr: '\u21C7',
    llcorner: '\u231E',
    llhard: '\u296B',
    lltri: '\u25FA',
    lmidot: '\u0140',
    lmoust: '\u23B0',
    lmoustache: '\u23B0',
    lnE: '\u2268',
    lnap: '\u2A89',
    lnapprox: '\u2A89',
    lne: '\u2A87',
    lneq: '\u2A87',
    lneqq: '\u2268',
    lnsim: '\u22E6',
    loang: '\u27EC',
    loarr: '\u21FD',
    lobrk: '\u27E6',
    longleftarrow: '\u27F5',
    longleftrightarrow: '\u27F7',
    longmapsto: '\u27FC',
    longrightarrow: '\u27F6',
    looparrowleft: '\u21AB',
    looparrowright: '\u21AC',
    lopar: '\u2985',
    lopf: '\u{1D55D}',
    loplus: '\u2A2D',
    lotimes: '\u2A34',
    lowast: '\u2217',
    lowbar: '_',
    loz: '\u25CA',
    lozenge: '\u25CA',
    lozf: '\u29EB',
    lpar: '(',
    lparlt: '\u2993',
    lrarr: '\u21C6',
    lrcorner: '\u231F',
    lrhar: '\u21CB',
    lrhard: '\u296D',
    lrm: '\u200E',
    lrtri: '\u22BF',
    lsaquo: '\u2039',
    lscr: '\u{1D4C1}',
    lsh: '\u21B0',
    lsim: '\u2272',
    lsime: '\u2A8D',
    lsimg: '\u2A8F',
    lsqb: '[',
    lsquo: '\u2018',
    lsquor: '\u201A',
    lstrok: '\u0142',
    lt: '<',
    ltcc: '\u2AA6',
    ltcir: '\u2A79',
    ltdot: '\u22D6',
    lthree: '\u22CB',
    ltimes: '\u22C9',
    ltlarr: '\u2976',
    ltquest: '\u2A7B',
    ltrPar: '\u2996',
    ltri: '\u25C3',
    ltrie: '\u22B4',
    ltrif: '\u25C2',
    lurdshar: '\u294A',
    luruhar: '\u2966',
    lvertneqq: '\u2268\uFE00',
    lvnE: '\u2268\uFE00',
    mDDot: '\u223A',
    macr: '\xAF',
    male: '\u2642',
    malt: '\u2720',
    maltese: '\u2720',
    map: '\u21A6',
    mapsto: '\u21A6',
    mapstodown: '\u21A7',
    mapstoleft: '\u21A4',
    mapstoup: '\u21A5',
    marker: '\u25AE',
    mcomma: '\u2A29',
    mcy: '\u043C',
    mdash: '\u2014',
    measuredangle: '\u2221',
    mfr: '\u{1D52A}',
    mho: '\u2127',
    micro: '\xB5',
    mid: '\u2223',
    midast: '*',
    midcir: '\u2AF0',
    middot: '\xB7',
    minus: '\u2212',
    minusb: '\u229F',
    minusd: '\u2238',
    minusdu: '\u2A2A',
    mlcp: '\u2ADB',
    mldr: '\u2026',
    mnplus: '\u2213',
    models: '\u22A7',
    mopf: '\u{1D55E}',
    mp: '\u2213',
    mscr: '\u{1D4C2}',
    mstpos: '\u223E',
    mu: '\u03BC',
    multimap: '\u22B8',
    mumap: '\u22B8',
    nGg: '\u22D9\u0338',
    nGt: '\u226B\u20D2',
    nGtv: '\u226B\u0338',
    nLeftarrow: '\u21CD',
    nLeftrightarrow: '\u21CE',
    nLl: '\u22D8\u0338',
    nLt: '\u226A\u20D2',
    nLtv: '\u226A\u0338',
    nRightarrow: '\u21CF',
    nVDash: '\u22AF',
    nVdash: '\u22AE',
    nabla: '\u2207',
    nacute: '\u0144',
    nang: '\u2220\u20D2',
    nap: '\u2249',
    napE: '\u2A70\u0338',
    napid: '\u224B\u0338',
    napos: '\u0149',
    napprox: '\u2249',
    natur: '\u266E',
    natural: '\u266E',
    naturals: '\u2115',
    nbsp: '\xA0',
    nbump: '\u224E\u0338',
    nbumpe: '\u224F\u0338',
    ncap: '\u2A43',
    ncaron: '\u0148',
    ncedil: '\u0146',
    ncong: '\u2247',
    ncongdot: '\u2A6D\u0338',
    ncup: '\u2A42',
    ncy: '\u043D',
    ndash: '\u2013',
    ne: '\u2260',
    neArr: '\u21D7',
    nearhk: '\u2924',
    nearr: '\u2197',
    nearrow: '\u2197',
    nedot: '\u2250\u0338',
    nequiv: '\u2262',
    nesear: '\u2928',
    nesim: '\u2242\u0338',
    nexist: '\u2204',
    nexists: '\u2204',
    nfr: '\u{1D52B}',
    ngE: '\u2267\u0338',
    nge: '\u2271',
    ngeq: '\u2271',
    ngeqq: '\u2267\u0338',
    ngeqslant: '\u2A7E\u0338',
    nges: '\u2A7E\u0338',
    ngsim: '\u2275',
    ngt: '\u226F',
    ngtr: '\u226F',
    nhArr: '\u21CE',
    nharr: '\u21AE',
    nhpar: '\u2AF2',
    ni: '\u220B',
    nis: '\u22FC',
    nisd: '\u22FA',
    niv: '\u220B',
    njcy: '\u045A',
    nlArr: '\u21CD',
    nlE: '\u2266\u0338',
    nlarr: '\u219A',
    nldr: '\u2025',
    nle: '\u2270',
    nleftarrow: '\u219A',
    nleftrightarrow: '\u21AE',
    nleq: '\u2270',
    nleqq: '\u2266\u0338',
    nleqslant: '\u2A7D\u0338',
    nles: '\u2A7D\u0338',
    nless: '\u226E',
    nlsim: '\u2274',
    nlt: '\u226E',
    nltri: '\u22EA',
    nltrie: '\u22EC',
    nmid: '\u2224',
    nopf: '\u{1D55F}',
    not: '\xAC',
    notin: '\u2209',
    notinE: '\u22F9\u0338',
    notindot: '\u22F5\u0338',
    notinva: '\u2209',
    notinvb: '\u22F7',
    notinvc: '\u22F6',
    notni: '\u220C',
    notniva: '\u220C',
    notnivb: '\u22FE',
    notnivc: '\u22FD',
    npar: '\u2226',
    nparallel: '\u2226',
    nparsl: '\u2AFD\u20E5',
    npart: '\u2202\u0338',
    npolint: '\u2A14',
    npr: '\u2280',
    nprcue: '\u22E0',
    npre: '\u2AAF\u0338',
    nprec: '\u2280',
    npreceq: '\u2AAF\u0338',
    nrArr: '\u21CF',
    nrarr: '\u219B',
    nrarrc: '\u2933\u0338',
    nrarrw: '\u219D\u0338',
    nrightarrow: '\u219B',
    nrtri: '\u22EB',
    nrtrie: '\u22ED',
    nsc: '\u2281',
    nsccue: '\u22E1',
    nsce: '\u2AB0\u0338',
    nscr: '\u{1D4C3}',
    nshortmid: '\u2224',
    nshortparallel: '\u2226',
    nsim: '\u2241',
    nsime: '\u2244',
    nsimeq: '\u2244',
    nsmid: '\u2224',
    nspar: '\u2226',
    nsqsube: '\u22E2',
    nsqsupe: '\u22E3',
    nsub: '\u2284',
    nsubE: '\u2AC5\u0338',
    nsube: '\u2288',
    nsubset: '\u2282\u20D2',
    nsubseteq: '\u2288',
    nsubseteqq: '\u2AC5\u0338',
    nsucc: '\u2281',
    nsucceq: '\u2AB0\u0338',
    nsup: '\u2285',
    nsupE: '\u2AC6\u0338',
    nsupe: '\u2289',
    nsupset: '\u2283\u20D2',
    nsupseteq: '\u2289',
    nsupseteqq: '\u2AC6\u0338',
    ntgl: '\u2279',
    ntilde: '\xF1',
    ntlg: '\u2278',
    ntriangleleft: '\u22EA',
    ntrianglelefteq: '\u22EC',
    ntriangleright: '\u22EB',
    ntrianglerighteq: '\u22ED',
    nu: '\u03BD',
    num: '#',
    numero: '\u2116',
    numsp: '\u2007',
    nvDash: '\u22AD',
    nvHarr: '\u2904',
    nvap: '\u224D\u20D2',
    nvdash: '\u22AC',
    nvge: '\u2265\u20D2',
    nvgt: '>\u20D2',
    nvinfin: '\u29DE',
    nvlArr: '\u2902',
    nvle: '\u2264\u20D2',
    nvlt: '<\u20D2',
    nvltrie: '\u22B4\u20D2',
    nvrArr: '\u2903',
    nvrtrie: '\u22B5\u20D2',
    nvsim: '\u223C\u20D2',
    nwArr: '\u21D6',
    nwarhk: '\u2923',
    nwarr: '\u2196',
    nwarrow: '\u2196',
    nwnear: '\u2927',
    oS: '\u24C8',
    oacute: '\xF3',
    oast: '\u229B',
    ocir: '\u229A',
    ocirc: '\xF4',
    ocy: '\u043E',
    odash: '\u229D',
    odblac: '\u0151',
    odiv: '\u2A38',
    odot: '\u2299',
    odsold: '\u29BC',
    oelig: '\u0153',
    ofcir: '\u29BF',
    ofr: '\u{1D52C}',
    ogon: '\u02DB',
    ograve: '\xF2',
    ogt: '\u29C1',
    ohbar: '\u29B5',
    ohm: '\u03A9',
    oint: '\u222E',
    olarr: '\u21BA',
    olcir: '\u29BE',
    olcross: '\u29BB',
    oline: '\u203E',
    olt: '\u29C0',
    omacr: '\u014D',
    omega: '\u03C9',
    omicron: '\u03BF',
    omid: '\u29B6',
    ominus: '\u2296',
    oopf: '\u{1D560}',
    opar: '\u29B7',
    operp: '\u29B9',
    oplus: '\u2295',
    or: '\u2228',
    orarr: '\u21BB',
    ord: '\u2A5D',
    order: '\u2134',
    orderof: '\u2134',
    ordf: '\xAA',
    ordm: '\xBA',
    origof: '\u22B6',
    oror: '\u2A56',
    orslope: '\u2A57',
    orv: '\u2A5B',
    oscr: '\u2134',
    oslash: '\xF8',
    osol: '\u2298',
    otilde: '\xF5',
    otimes: '\u2297',
    otimesas: '\u2A36',
    ouml: '\xF6',
    ovbar: '\u233D',
    par: '\u2225',
    para: '\xB6',
    parallel: '\u2225',
    parsim: '\u2AF3',
    parsl: '\u2AFD',
    part: '\u2202',
    pcy: '\u043F',
    percnt: '%',
    period: '.',
    permil: '\u2030',
    perp: '\u22A5',
    pertenk: '\u2031',
    pfr: '\u{1D52D}',
    phi: '\u03C6',
    phiv: '\u03D5',
    phmmat: '\u2133',
    phone: '\u260E',
    pi: '\u03C0',
    pitchfork: '\u22D4',
    piv: '\u03D6',
    planck: '\u210F',
    planckh: '\u210E',
    plankv: '\u210F',
    plus: '+',
    plusacir: '\u2A23',
    plusb: '\u229E',
    pluscir: '\u2A22',
    plusdo: '\u2214',
    plusdu: '\u2A25',
    pluse: '\u2A72',
    plusmn: '\xB1',
    plussim: '\u2A26',
    plustwo: '\u2A27',
    pm: '\xB1',
    pointint: '\u2A15',
    popf: '\u{1D561}',
    pound: '\xA3',
    pr: '\u227A',
    prE: '\u2AB3',
    prap: '\u2AB7',
    prcue: '\u227C',
    pre: '\u2AAF',
    prec: '\u227A',
    precapprox: '\u2AB7',
    preccurlyeq: '\u227C',
    preceq: '\u2AAF',
    precnapprox: '\u2AB9',
    precneqq: '\u2AB5',
    precnsim: '\u22E8',
    precsim: '\u227E',
    prime: '\u2032',
    primes: '\u2119',
    prnE: '\u2AB5',
    prnap: '\u2AB9',
    prnsim: '\u22E8',
    prod: '\u220F',
    profalar: '\u232E',
    profline: '\u2312',
    profsurf: '\u2313',
    prop: '\u221D',
    propto: '\u221D',
    prsim: '\u227E',
    prurel: '\u22B0',
    pscr: '\u{1D4C5}',
    psi: '\u03C8',
    puncsp: '\u2008',
    qfr: '\u{1D52E}',
    qint: '\u2A0C',
    qopf: '\u{1D562}',
    qprime: '\u2057',
    qscr: '\u{1D4C6}',
    quaternions: '\u210D',
    quatint: '\u2A16',
    quest: '?',
    questeq: '\u225F',
    quot: '"',
    rAarr: '\u21DB',
    rArr: '\u21D2',
    rAtail: '\u291C',
    rBarr: '\u290F',
    rHar: '\u2964',
    race: '\u223D\u0331',
    racute: '\u0155',
    radic: '\u221A',
    raemptyv: '\u29B3',
    rang: '\u27E9',
    rangd: '\u2992',
    range: '\u29A5',
    rangle: '\u27E9',
    raquo: '\xBB',
    rarr: '\u2192',
    rarrap: '\u2975',
    rarrb: '\u21E5',
    rarrbfs: '\u2920',
    rarrc: '\u2933',
    rarrfs: '\u291E',
    rarrhk: '\u21AA',
    rarrlp: '\u21AC',
    rarrpl: '\u2945',
    rarrsim: '\u2974',
    rarrtl: '\u21A3',
    rarrw: '\u219D',
    ratail: '\u291A',
    ratio: '\u2236',
    rationals: '\u211A',
    rbarr: '\u290D',
    rbbrk: '\u2773',
    rbrace: '}',
    rbrack: ']',
    rbrke: '\u298C',
    rbrksld: '\u298E',
    rbrkslu: '\u2990',
    rcaron: '\u0159',
    rcedil: '\u0157',
    rceil: '\u2309',
    rcub: '}',
    rcy: '\u0440',
    rdca: '\u2937',
    rdldhar: '\u2969',
    rdquo: '\u201D',
    rdquor: '\u201D',
    rdsh: '\u21B3',
    real: '\u211C',
    realine: '\u211B',
    realpart: '\u211C',
    reals: '\u211D',
    rect: '\u25AD',
    reg: '\xAE',
    rfisht: '\u297D',
    rfloor: '\u230B',
    rfr: '\u{1D52F}',
    rhard: '\u21C1',
    rharu: '\u21C0',
    rharul: '\u296C',
    rho: '\u03C1',
    rhov: '\u03F1',
    rightarrow: '\u2192',
    rightarrowtail: '\u21A3',
    rightharpoondown: '\u21C1',
    rightharpoonup: '\u21C0',
    rightleftarrows: '\u21C4',
    rightleftharpoons: '\u21CC',
    rightrightarrows: '\u21C9',
    rightsquigarrow: '\u219D',
    rightthreetimes: '\u22CC',
    ring: '\u02DA',
    risingdotseq: '\u2253',
    rlarr: '\u21C4',
    rlhar: '\u21CC',
    rlm: '\u200F',
    rmoust: '\u23B1',
    rmoustache: '\u23B1',
    rnmid: '\u2AEE',
    roang: '\u27ED',
    roarr: '\u21FE',
    robrk: '\u27E7',
    ropar: '\u2986',
    ropf: '\u{1D563}',
    roplus: '\u2A2E',
    rotimes: '\u2A35',
    rpar: ')',
    rpargt: '\u2994',
    rppolint: '\u2A12',
    rrarr: '\u21C9',
    rsaquo: '\u203A',
    rscr: '\u{1D4C7}',
    rsh: '\u21B1',
    rsqb: ']',
    rsquo: '\u2019',
    rsquor: '\u2019',
    rthree: '\u22CC',
    rtimes: '\u22CA',
    rtri: '\u25B9',
    rtrie: '\u22B5',
    rtrif: '\u25B8',
    rtriltri: '\u29CE',
    ruluhar: '\u2968',
    rx: '\u211E',
    sacute: '\u015B',
    sbquo: '\u201A',
    sc: '\u227B',
    scE: '\u2AB4',
    scap: '\u2AB8',
    scaron: '\u0161',
    sccue: '\u227D',
    sce: '\u2AB0',
    scedil: '\u015F',
    scirc: '\u015D',
    scnE: '\u2AB6',
    scnap: '\u2ABA',
    scnsim: '\u22E9',
    scpolint: '\u2A13',
    scsim: '\u227F',
    scy: '\u0441',
    sdot: '\u22C5',
    sdotb: '\u22A1',
    sdote: '\u2A66',
    seArr: '\u21D8',
    searhk: '\u2925',
    searr: '\u2198',
    searrow: '\u2198',
    sect: '\xA7',
    semi: ';',
    seswar: '\u2929',
    setminus: '\u2216',
    setmn: '\u2216',
    sext: '\u2736',
    sfr: '\u{1D530}',
    sfrown: '\u2322',
    sharp: '\u266F',
    shchcy: '\u0449',
    shcy: '\u0448',
    shortmid: '\u2223',
    shortparallel: '\u2225',
    shy: '\xAD',
    sigma: '\u03C3',
    sigmaf: '\u03C2',
    sigmav: '\u03C2',
    sim: '\u223C',
    simdot: '\u2A6A',
    sime: '\u2243',
    simeq: '\u2243',
    simg: '\u2A9E',
    simgE: '\u2AA0',
    siml: '\u2A9D',
    simlE: '\u2A9F',
    simne: '\u2246',
    simplus: '\u2A24',
    simrarr: '\u2972',
    slarr: '\u2190',
    smallsetminus: '\u2216',
    smashp: '\u2A33',
    smeparsl: '\u29E4',
    smid: '\u2223',
    smile: '\u2323',
    smt: '\u2AAA',
    smte: '\u2AAC',
    smtes: '\u2AAC\uFE00',
    softcy: '\u044C',
    sol: '/',
    solb: '\u29C4',
    solbar: '\u233F',
    sopf: '\u{1D564}',
    spades: '\u2660',
    spadesuit: '\u2660',
    spar: '\u2225',
    sqcap: '\u2293',
    sqcaps: '\u2293\uFE00',
    sqcup: '\u2294',
    sqcups: '\u2294\uFE00',
    sqsub: '\u228F',
    sqsube: '\u2291',
    sqsubset: '\u228F',
    sqsubseteq: '\u2291',
    sqsup: '\u2290',
    sqsupe: '\u2292',
    sqsupset: '\u2290',
    sqsupseteq: '\u2292',
    squ: '\u25A1',
    square: '\u25A1',
    squarf: '\u25AA',
    squf: '\u25AA',
    srarr: '\u2192',
    sscr: '\u{1D4C8}',
    ssetmn: '\u2216',
    ssmile: '\u2323',
    sstarf: '\u22C6',
    star: '\u2606',
    starf: '\u2605',
    straightepsilon: '\u03F5',
    straightphi: '\u03D5',
    strns: '\xAF',
    sub: '\u2282',
    subE: '\u2AC5',
    subdot: '\u2ABD',
    sube: '\u2286',
    subedot: '\u2AC3',
    submult: '\u2AC1',
    subnE: '\u2ACB',
    subne: '\u228A',
    subplus: '\u2ABF',
    subrarr: '\u2979',
    subset: '\u2282',
    subseteq: '\u2286',
    subseteqq: '\u2AC5',
    subsetneq: '\u228A',
    subsetneqq: '\u2ACB',
    subsim: '\u2AC7',
    subsub: '\u2AD5',
    subsup: '\u2AD3',
    succ: '\u227B',
    succapprox: '\u2AB8',
    succcurlyeq: '\u227D',
    succeq: '\u2AB0',
    succnapprox: '\u2ABA',
    succneqq: '\u2AB6',
    succnsim: '\u22E9',
    succsim: '\u227F',
    sum: '\u2211',
    sung: '\u266A',
    sup1: '\xB9',
    sup2: '\xB2',
    sup3: '\xB3',
    sup: '\u2283',
    supE: '\u2AC6',
    supdot: '\u2ABE',
    supdsub: '\u2AD8',
    supe: '\u2287',
    supedot: '\u2AC4',
    suphsol: '\u27C9',
    suphsub: '\u2AD7',
    suplarr: '\u297B',
    supmult: '\u2AC2',
    supnE: '\u2ACC',
    supne: '\u228B',
    supplus: '\u2AC0',
    supset: '\u2283',
    supseteq: '\u2287',
    supseteqq: '\u2AC6',
    supsetneq: '\u228B',
    supsetneqq: '\u2ACC',
    supsim: '\u2AC8',
    supsub: '\u2AD4',
    supsup: '\u2AD6',
    swArr: '\u21D9',
    swarhk: '\u2926',
    swarr: '\u2199',
    swarrow: '\u2199',
    swnwar: '\u292A',
    szlig: '\xDF',
    target: '\u2316',
    tau: '\u03C4',
    tbrk: '\u23B4',
    tcaron: '\u0165',
    tcedil: '\u0163',
    tcy: '\u0442',
    tdot: '\u20DB',
    telrec: '\u2315',
    tfr: '\u{1D531}',
    there4: '\u2234',
    therefore: '\u2234',
    theta: '\u03B8',
    thetasym: '\u03D1',
    thetav: '\u03D1',
    thickapprox: '\u2248',
    thicksim: '\u223C',
    thinsp: '\u2009',
    thkap: '\u2248',
    thksim: '\u223C',
    thorn: '\xFE',
    tilde: '\u02DC',
    times: '\xD7',
    timesb: '\u22A0',
    timesbar: '\u2A31',
    timesd: '\u2A30',
    tint: '\u222D',
    toea: '\u2928',
    top: '\u22A4',
    topbot: '\u2336',
    topcir: '\u2AF1',
    topf: '\u{1D565}',
    topfork: '\u2ADA',
    tosa: '\u2929',
    tprime: '\u2034',
    trade: '\u2122',
    triangle: '\u25B5',
    triangledown: '\u25BF',
    triangleleft: '\u25C3',
    trianglelefteq: '\u22B4',
    triangleq: '\u225C',
    triangleright: '\u25B9',
    trianglerighteq: '\u22B5',
    tridot: '\u25EC',
    trie: '\u225C',
    triminus: '\u2A3A',
    triplus: '\u2A39',
    trisb: '\u29CD',
    tritime: '\u2A3B',
    trpezium: '\u23E2',
    tscr: '\u{1D4C9}',
    tscy: '\u0446',
    tshcy: '\u045B',
    tstrok: '\u0167',
    twixt: '\u226C',
    twoheadleftarrow: '\u219E',
    twoheadrightarrow: '\u21A0',
    uArr: '\u21D1',
    uHar: '\u2963',
    uacute: '\xFA',
    uarr: '\u2191',
    ubrcy: '\u045E',
    ubreve: '\u016D',
    ucirc: '\xFB',
    ucy: '\u0443',
    udarr: '\u21C5',
    udblac: '\u0171',
    udhar: '\u296E',
    ufisht: '\u297E',
    ufr: '\u{1D532}',
    ugrave: '\xF9',
    uharl: '\u21BF',
    uharr: '\u21BE',
    uhblk: '\u2580',
    ulcorn: '\u231C',
    ulcorner: '\u231C',
    ulcrop: '\u230F',
    ultri: '\u25F8',
    umacr: '\u016B',
    uml: '\xA8',
    uogon: '\u0173',
    uopf: '\u{1D566}',
    uparrow: '\u2191',
    updownarrow: '\u2195',
    upharpoonleft: '\u21BF',
    upharpoonright: '\u21BE',
    uplus: '\u228E',
    upsi: '\u03C5',
    upsih: '\u03D2',
    upsilon: '\u03C5',
    upuparrows: '\u21C8',
    urcorn: '\u231D',
    urcorner: '\u231D',
    urcrop: '\u230E',
    uring: '\u016F',
    urtri: '\u25F9',
    uscr: '\u{1D4CA}',
    utdot: '\u22F0',
    utilde: '\u0169',
    utri: '\u25B5',
    utrif: '\u25B4',
    uuarr: '\u21C8',
    uuml: '\xFC',
    uwangle: '\u29A7',
    vArr: '\u21D5',
    vBar: '\u2AE8',
    vBarv: '\u2AE9',
    vDash: '\u22A8',
    vangrt: '\u299C',
    varepsilon: '\u03F5',
    varkappa: '\u03F0',
    varnothing: '\u2205',
    varphi: '\u03D5',
    varpi: '\u03D6',
    varpropto: '\u221D',
    varr: '\u2195',
    varrho: '\u03F1',
    varsigma: '\u03C2',
    varsubsetneq: '\u228A\uFE00',
    varsubsetneqq: '\u2ACB\uFE00',
    varsupsetneq: '\u228B\uFE00',
    varsupsetneqq: '\u2ACC\uFE00',
    vartheta: '\u03D1',
    vartriangleleft: '\u22B2',
    vartriangleright: '\u22B3',
    vcy: '\u0432',
    vdash: '\u22A2',
    vee: '\u2228',
    veebar: '\u22BB',
    veeeq: '\u225A',
    vellip: '\u22EE',
    verbar: '|',
    vert: '|',
    vfr: '\u{1D533}',
    vltri: '\u22B2',
    vnsub: '\u2282\u20D2',
    vnsup: '\u2283\u20D2',
    vopf: '\u{1D567}',
    vprop: '\u221D',
    vrtri: '\u22B3',
    vscr: '\u{1D4CB}',
    vsubnE: '\u2ACB\uFE00',
    vsubne: '\u228A\uFE00',
    vsupnE: '\u2ACC\uFE00',
    vsupne: '\u228B\uFE00',
    vzigzag: '\u299A',
    wcirc: '\u0175',
    wedbar: '\u2A5F',
    wedge: '\u2227',
    wedgeq: '\u2259',
    weierp: '\u2118',
    wfr: '\u{1D534}',
    wopf: '\u{1D568}',
    wp: '\u2118',
    wr: '\u2240',
    wreath: '\u2240',
    wscr: '\u{1D4CC}',
    xcap: '\u22C2',
    xcirc: '\u25EF',
    xcup: '\u22C3',
    xdtri: '\u25BD',
    xfr: '\u{1D535}',
    xhArr: '\u27FA',
    xharr: '\u27F7',
    xi: '\u03BE',
    xlArr: '\u27F8',
    xlarr: '\u27F5',
    xmap: '\u27FC',
    xnis: '\u22FB',
    xodot: '\u2A00',
    xopf: '\u{1D569}',
    xoplus: '\u2A01',
    xotime: '\u2A02',
    xrArr: '\u27F9',
    xrarr: '\u27F6',
    xscr: '\u{1D4CD}',
    xsqcup: '\u2A06',
    xuplus: '\u2A04',
    xutri: '\u25B3',
    xvee: '\u22C1',
    xwedge: '\u22C0',
    yacute: '\xFD',
    yacy: '\u044F',
    ycirc: '\u0177',
    ycy: '\u044B',
    yen: '\xA5',
    yfr: '\u{1D536}',
    yicy: '\u0457',
    yopf: '\u{1D56A}',
    yscr: '\u{1D4CE}',
    yucy: '\u044E',
    yuml: '\xFF',
    zacute: '\u017A',
    zcaron: '\u017E',
    zcy: '\u0437',
    zdot: '\u017C',
    zeetrf: '\u2128',
    zeta: '\u03B6',
    zfr: '\u{1D537}',
    zhcy: '\u0436',
    zigrarr: '\u21DD',
    zopf: '\u{1D56B}',
    zscr: '\u{1D4CF}',
    zwj: '\u200D',
    zwnj: '\u200C',
  }
  /*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */ function xs(e) {
    return e instanceof Uint8Array || (ArrayBuffer.isView(e) && e.constructor.name === 'Uint8Array')
  }
  function O(e, ...t) {
    if (!xs(e)) throw new Error('Uint8Array expected')
    if (t.length > 0 && !t.includes(e.length))
      throw new Error('Uint8Array expected of length ' + t + ', got length=' + e.length)
  }
  function bt(e, t = !0) {
    if (e.destroyed) throw new Error('Hash instance has been destroyed')
    if (t && e.finished) throw new Error('Hash#digest() has already been called')
  }
  function se(e, t) {
    O(e)
    let s = t.outputLen
    if (e.length < s) throw new Error('digestInto() expects output buffer of length at least ' + s)
  }
  function P(...e) {
    for (let t = 0; t < e.length; t++) e[t].fill(0)
  }
  function Z(e) {
    return new DataView(e.buffer, e.byteOffset, e.byteLength)
  }
  function re(e, t) {
    return (e << t) | ((e >>> (32 - t)) >>> 0)
  }
  var bs =
      typeof Uint8Array.from([]).toHex == 'function' && typeof Uint8Array.fromHex == 'function',
    Es = Array.from({ length: 256 }, (e, t) => t.toString(16).padStart(2, '0'))
  function ie(e) {
    if ((O(e), bs)) return e.toHex()
    let t = ''
    for (let s = 0; s < e.length; s++) t += Es[e[s]]
    return t
  }
  function ws(e) {
    if (typeof e != 'string') throw new Error('string expected')
    return new Uint8Array(new TextEncoder().encode(e))
  }
  function Et(e) {
    return (typeof e == 'string' && (e = ws(e)), O(e), e)
  }
  var K = class {}
  function ae(e) {
    let t = (r) => e().update(Et(r)).digest(),
      s = e()
    return ((t.outputLen = s.outputLen), (t.blockLen = s.blockLen), (t.create = () => e()), t)
  }
  function As(e, t, s, r) {
    if (typeof e.setBigUint64 == 'function') return e.setBigUint64(t, s, r)
    let i = BigInt(32),
      o = BigInt(4294967295),
      a = Number((s >> i) & o),
      n = Number(s & o),
      h = r ? 4 : 0,
      x = r ? 0 : 4
    ;(e.setUint32(t + h, a, r), e.setUint32(t + x, n, r))
  }
  function wt(e, t, s) {
    return (e & t) ^ (~e & s)
  }
  var Y = class extends K {
    constructor(t, s, r, i) {
      ;(super(),
        (this.finished = !1),
        (this.length = 0),
        (this.pos = 0),
        (this.destroyed = !1),
        (this.blockLen = t),
        (this.outputLen = s),
        (this.padOffset = r),
        (this.isLE = i),
        (this.buffer = new Uint8Array(t)),
        (this.view = Z(this.buffer)))
    }
    update(t) {
      ;(bt(this), (t = Et(t)), O(t))
      let { view: s, buffer: r, blockLen: i } = this,
        o = t.length
      for (let a = 0; a < o;) {
        let n = Math.min(i - this.pos, o - a)
        if (n === i) {
          let h = Z(t)
          for (; i <= o - a; a += i) this.process(h, a)
          continue
        }
        ;(r.set(t.subarray(a, a + n), this.pos),
          (this.pos += n),
          (a += n),
          this.pos === i && (this.process(s, 0), (this.pos = 0)))
      }
      return ((this.length += t.length), this.roundClean(), this)
    }
    digestInto(t) {
      ;(bt(this), se(t, this), (this.finished = !0))
      let { buffer: s, view: r, blockLen: i, isLE: o } = this,
        { pos: a } = this
      ;((s[a++] = 128),
        P(this.buffer.subarray(a)),
        this.padOffset > i - a && (this.process(r, 0), (a = 0)))
      for (let m = a; m < i; m++) s[m] = 0
      ;(As(r, i - 8, BigInt(this.length * 8), o), this.process(r, 0))
      let n = Z(t),
        h = this.outputLen
      if (h % 4) throw new Error('_sha2: outputLen should be aligned to 32bit')
      let x = h / 4,
        p = this.get()
      if (x > p.length) throw new Error('_sha2: outputLen bigger than state')
      for (let m = 0; m < x; m++) n.setUint32(4 * m, p[m], o)
    }
    digest() {
      let { buffer: t, outputLen: s } = this
      this.digestInto(t)
      let r = t.slice(0, s)
      return (this.destroy(), r)
    }
    _cloneInto(t) {
      ;(t || (t = new this.constructor()), t.set(...this.get()))
      let { blockLen: s, buffer: r, length: i, finished: o, destroyed: a, pos: n } = this
      return (
        (t.destroyed = a),
        (t.finished = o),
        (t.length = i),
        (t.pos = n),
        i % s && t.buffer.set(r),
        t
      )
    }
    clone() {
      return this._cloneInto()
    }
  }
  var Ds = Uint32Array.from([1732584193, 4023233417, 2562383102, 271733878, 3285377520])
  var Cs = Math.pow(2, 32),
    Ts = Array.from({ length: 64 }, (e, t) => Math.floor(Cs * Math.abs(Math.sin(t + 1)))),
    J = Ds.slice(0, 4),
    At = new Uint32Array(16),
    Dt = class extends Y {
      constructor() {
        ;(super(64, 16, 8, !0),
          (this.A = J[0] | 0),
          (this.B = J[1] | 0),
          (this.C = J[2] | 0),
          (this.D = J[3] | 0))
      }
      get() {
        let { A: t, B: s, C: r, D: i } = this
        return [t, s, r, i]
      }
      set(t, s, r, i) {
        ;((this.A = t | 0), (this.B = s | 0), (this.C = r | 0), (this.D = i | 0))
      }
      process(t, s) {
        for (let n = 0; n < 16; n++, s += 4) At[n] = t.getUint32(s, !0)
        let { A: r, B: i, C: o, D: a } = this
        for (let n = 0; n < 64; n++) {
          let h, x, p
          ;(n < 16
            ? ((h = wt(i, o, a)), (x = n), (p = [7, 12, 17, 22]))
            : n < 32
              ? ((h = wt(a, i, o)), (x = (5 * n + 1) % 16), (p = [5, 9, 14, 20]))
              : n < 48
                ? ((h = i ^ o ^ a), (x = (3 * n + 5) % 16), (p = [4, 11, 16, 23]))
                : ((h = o ^ (i | ~a)), (x = (7 * n) % 16), (p = [6, 10, 15, 21])),
            (h = h + r + Ts[n] + At[x]),
            (r = a),
            (a = o),
            (o = i),
            (i = i + re(h, p[n % 4])))
        }
        ;((r = (r + this.A) | 0),
          (i = (i + this.B) | 0),
          (o = (o + this.C) | 0),
          (a = (a + this.D) | 0),
          this.set(r, i, o, a))
      }
      roundClean() {
        P(At)
      }
      destroy() {
        ;(this.set(0, 0, 0, 0), P(this.buffer))
      }
    },
    oe = ae(() => new Dt())
  function he(e, t = !1) {
    let s = new ce.SaxesParser()
    t && Object.assign(s.ENTITIES, ee)
    let r = [],
      i
    s.on('opentag', (a) => {
      let n = { name: a.name, attrs: a.attributes, children: [] }
      ;(r.length ? r[r.length - 1].children.push(n) : (i = n), r.push(n))
    })
    let o = (a) => r[r.length - 1]?.children.push(a)
    ;(s.on('text', o),
      s.on('cdata', o),
      s.on('closetag', () => {
        r.pop()
      }))
    try {
      s.write(e).close()
    } catch {
      throw new Error('E_IMPORT_ENEX_XML')
    }
    if (!i) throw new Error('E_IMPORT_ENEX_XML')
    return i
  }
  var I = (e, t) => e.children.filter((s) => typeof s != 'string' && s.name === t),
    Ct = (e) => e.children.map((t) => (typeof t == 'string' ? t : Ct(t))).join(''),
    v = (e, t) => I(e, t).map(Ct)[0] ?? '',
    ne = (e) =>
      e
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
  function le(e) {
    let t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(e)
    if (!t) return
    let s = `${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}.000Z`,
      r = Date.parse(s)
    return Number.isSafeInteger(r) && r >= 0 && new Date(r).toISOString() === s ? r : void 0
  }
  function Ns(e) {
    let t = [],
      s = [],
      r = new Map(),
      i = new Set()
    for (let f of I(e, 'resource'))
      try {
        let A = v(f, 'data').replace(/\s/g, '')
        if (A.length > Math.ceil((10 * 1024 * 1024) / 3) * 4) throw new Error('E_FILE_SIZE_INVALID')
        let U = Uint8Array.from(atob(A), (de) => de.charCodeAt(0)),
          N = ie(oe(U)),
          V = I(f, 'resource-attributes')[0],
          ue = v(f, 'mime') || 'application/octet-stream',
          fe = (V && v(V, 'file-name')) || `resource-${t.length + 1}`
        ;(r.set(N, t.length), t.push({ name: fe, mime: ue, data: A }))
      } catch (A) {
        s.push(
          A instanceof Error && A.message === 'E_FILE_SIZE_INVALID'
            ? 'E_FILE_SIZE_INVALID'
            : 'E_IMPORT_ATTACHMENT_INVALID',
        )
      }
    let o = he(v(e, 'content') || '<en-note/>', !0)
    if (o.name !== 'en-note') throw new Error('E_IMPORT_ENEX_CONTENT')
    let a = (f) => `<img src="attachment:${f}" alt=""/>`,
      n = (f) => {
        if (typeof f == 'string') return ne(f)
        if (f.name === 'en-crypt') return (s.push('E_IMPORT_ENCRYPTED'), '')
        if (f.name === 'en-media') {
          let N = r.get((f.attrs.hash ?? '').toLowerCase())
          return N === void 0 ? (s.push('E_IMPORT_ATTACHMENT_MISSING'), '') : (i.add(N), a(N))
        }
        if (f.name === 'en-todo')
          return `<input type="checkbox" disabled${f.attrs.checked === 'true' ? ' checked' : ''}/>`
        let A = f.children.map(n).join('')
        if (f.name !== 'li' && I(f, 'en-todo').length) return `<ul><li>${A}</li></ul>`
        if (f.name === 'en-note') return A
        let U = Object.entries(f.attrs)
          .map(([N, V]) => ` ${N}="${ne(V)}"`)
          .join('')
        return [
          'br',
          'hr',
          'img',
          'input',
          'wbr',
          'area',
          'base',
          'col',
          'embed',
          'link',
          'meta',
          'param',
          'source',
          'track',
        ].includes(f.name)
          ? `<${f.name}${U}/>`
          : `<${f.name}${U}>${A}</${f.name}>`
      },
      h = n(o)
    t.forEach((f, A) => {
      i.has(A) || (h += `<div>${a(A)}</div>`)
    })
    let x = Date.now(),
      p = le(v(e, 'created')) ?? x,
      m = Math.max(p, le(v(e, 'updated')) ?? x)
    return {
      title: [...v(e, 'title')].slice(0, 1e3).join(''),
      html: h,
      attachments: t,
      tags: I(e, 'tag').map(Ct),
      createdAt: p,
      updatedAt: m,
      diagnostics: s,
    }
  }
  function _s(e) {
    let t = he(e.text)
    if (t.name !== 'en-export') throw new Error('E_IMPORT_ENEX_XML')
    return I(t, 'note').map(Ns)
  }
  devot.importer.handle('enex', _s)
})()
