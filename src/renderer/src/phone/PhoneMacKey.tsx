import { useCallback, useEffect, useRef, useState } from 'react'
import { errorCode } from '../../../core/errors'
import { writeClipboardText } from '../clipboard'
import { format, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { getMacKey, licenceLink, type MacKey } from '../licence'
import { licenceProblem } from '../licenceView'
import { PhoneSheet } from './PhoneSheet'
import { logFailure } from '../failure'

type Fetching =
  | { readonly kind: 'getting' }
  | { readonly kind: 'ready'; readonly key: MacKey; readonly copied: boolean }
  | { readonly kind: 'failed'; readonly code: string }

/**
 * The Devot Pro purchase's Mac licence key (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md),
 * to copy or share to a Mac. The key lives in this sheet alone: this iPhone never adds it.
 */
function MacKeySheet(props: { onClose: () => void }) {
  const [fetching, setFetching] = useState<Fetching>({ kind: 'getting' })
  const mounted = useRef(true)
  const load = useCallback(() => {
    getMacKey().then(
      (key) => mounted.current && setFetching({ kind: 'ready', key, copied: false }),
      (error: unknown) =>
        mounted.current &&
        setFetching({
          kind: 'failed',
          code: logFailure(errorCode(error), 'W_PHONE_MAC_KEY_FAILED'),
        }),
    )
  }, [])
  useEffect(() => {
    mounted.current = true
    load()
    return () => {
      mounted.current = false
    }
  }, [load])
  const title = t('phone.macKey.title')
  return (
    <PhoneSheet title={title} onClose={props.onClose} plain done={t('phone.hint.done')}>
      <div className="phone-detail-head">
        <span className="phone-detail-icon">
          <Icon name="phone.settings.licence" size="md" />
        </span>
        <h2 className="phone-detail-title">{title}</h2>
      </div>
      <p className="phone-detail-body">{t('phone.macKey.body')}</p>
      {fetching.kind === 'getting' && (
        <p className="phone-detail-body" role="status">
          {t('phone.macKey.getting')}
        </p>
      )}
      {fetching.kind === 'failed' && (
        <>
          <p className="phone-detail-body phone-purchase-message" role="alert">
            {format(t('phone.macKey.failed'), { problem: licenceProblem(fetching.code) })}
          </p>
          <div className="phone-purchase-actions">
            <button
              type="button"
              className="phone-purchase-primary"
              onClick={() => {
                setFetching({ kind: 'getting' })
                load()
              }}
            >
              {t('phone.macKey.retry')}
            </button>
          </div>
        </>
      )}
      {fetching.kind === 'ready' && (
        <ReadyKey
          macKey={fetching.key}
          copied={fetching.copied}
          onCopied={() => setFetching({ ...fetching, copied: true })}
        />
      )}
    </PhoneSheet>
  )
}

function ReadyKey(props: { macKey: MacKey; copied: boolean; onCopied: () => void }) {
  const { key } = props.macKey
  const canShare = typeof navigator.share === 'function'
  const copy = () =>
    void writeClipboardText(key).then(props.onCopied, () => console.warn('W_MAC_KEY_COPY_FAILED'))
  const share = () =>
    // A share the user cancels rejects too: nothing to tell them.
    void navigator
      .share({
        title: t('phone.macKey.title'),
        text: format(t('phone.macKey.shareText'), { key, link: licenceLink(key) }),
      })
      .catch(() => undefined)
  return (
    <>
      <p className="phone-detail-body phone-figures phone-mac-key">{key}</p>
      <div className="phone-purchase-actions">
        <button type="button" className="phone-purchase-primary" onClick={copy}>
          {t('phone.macKey.copy')}
        </button>
        {canShare && (
          <button type="button" className="phone-glass phone-detail-done" onClick={share}>
            {t('phone.macKey.share')}
          </button>
        )}
        <p className="phone-detail-body" role="status">
          {props.copied ? t('phone.macKey.copied') : null}
        </p>
      </div>
    </>
  )
}

/** Get a Mac License Key, in an App Store build that holds Devot Pro: it opens the key's sheet. */
export function MacKeyRow() {
  const [open, setOpen] = useState(false)
  return (
    <li className="phone-grouped-row">
      <button type="button" className="phone-grouped-open" onClick={() => setOpen(true)}>
        <span className="phone-grouped-text">
          <span className="phone-grouped-label">{t('phone.settings.macKey')}</span>
        </span>
        <span className="phone-chevron">
          <Icon name="phone.disclosure" size="xs" weight="medium" />
        </span>
      </button>
      {open && <MacKeySheet onClose={() => setOpen(false)} />}
    </li>
  )
}
