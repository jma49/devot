import type { ReactNode } from 'react'
import { BackupNotice } from '../BackupNotice'
import { ChangeNotice } from '../ChangeNotice'
import { CoreNotice } from '../CoreNotice'
import { ImageActionNotice, ImageNotice } from '../ImageNotice'
import { Notices } from '../Notices'
import type { SyncSnapshot } from '../sync'
import { SyncNotice } from '../SyncNotice'
import { ActivationBar, TrialEndedBar, TrialReminder } from '../TrialNotices'

/** A notice the window holds by code until it is dismissed. */
export interface HeldNotice<T = string> {
  code: T | undefined
  dismiss: () => void
}

/** The main window's notices, in the order they stack. */
export function WindowNotices(props: {
  save: ReactNode
  backup: HeldNotice & { backupsOpen: boolean; show: () => void }
  syncSnapshot: SyncSnapshot
  exported: ReactNode
  searchIndex: ReactNode
  mirror: ReactNode
  updates: ReactNode
  change: HeldNotice
  undoDropped: ReactNode
  batch: ReactNode
  aiAccess: ReactNode
  coreFailure: HeldNotice
  ai: ReactNode
  images: HeldNotice<string[]>
  link: ReactNode
  licence: ReactNode
  plugins: ReactNode
}) {
  const { backup, change, coreFailure, images } = props
  return (
    <Notices>
      <ActivationBar />
      <TrialEndedBar />
      <TrialReminder />
      {props.save}
      {backup.code && !backup.backupsOpen ? (
        <BackupNotice
          code={backup.code}
          onShow={() => {
            backup.dismiss()
            backup.show()
          }}
          onDismiss={backup.dismiss}
        />
      ) : null}
      <SyncNotice snapshot={props.syncSnapshot} />
      {props.exported}
      {props.searchIndex}
      {props.mirror}
      {props.updates}
      {change.code ? <ChangeNotice code={change.code} onDismiss={change.dismiss} /> : null}
      {props.undoDropped}
      {props.batch}
      {props.aiAccess}
      {coreFailure.code ? (
        <CoreNotice code={coreFailure.code} onDismiss={coreFailure.dismiss} />
      ) : null}
      {props.ai}
      {images.code ? <ImageNotice codes={images.code} onDismiss={images.dismiss} /> : null}
      <ImageActionNotice />
      {props.link}
      {props.licence}
      {props.plugins}
    </Notices>
  )
}
