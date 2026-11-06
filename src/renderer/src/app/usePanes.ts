import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { areaOf } from '../areas'
import { useMenuEvent } from '../commands/dispatch'
import type { EditorHandle } from '../editor/handle'
import { currentFocusStore, currentSidebarStore } from '../focus'
import { invoke } from '../ipc'
import type { ListLayout } from '../lastState'
import { useNarrowWindow } from '../narrowWindow'
import { fadeInListBody, measurePanes, movePanes, type PaneBoxes, shownPanes } from '../paneMotion'
import { hasDesktopShell } from '../platform'
import type { FocusRequest } from './focusRequest'

const EDITOR_REMEASURE_MS = 100

const TOGGLE_SIDEBAR = 'devot:toggle-sidebar'

/** A menu toggle this soon after the key did the same is that key press echoing through the menu; it is dropped. */
export const MENU_ECHO_MS = 500

/** Focus mode and the sidebar: whether each shows, and the panes sliding as they hide and show. */
export function usePanes({
  editorRef,
  requestFocus,
  startFailure,
}: {
  editorRef: RefObject<EditorHandle | null>
  requestFocus: (request: FocusRequest) => void
  startFailure: string | undefined
}) {
  const focusStore = useMemo(() => currentFocusStore(), [])
  const [focus, setFocus] = useState(() => focusStore.load())
  const toggleFocus = useCallback(() => {
    setFocus((on) => {
      focusStore.save(!on)
      return !on
    })
  }, [focusStore])
  const sidebarStore = useMemo(() => currentSidebarStore(), [])
  const [sidebarHidden, setSidebarHidden] = useState(() => sidebarStore.load())
  // A narrow window hides the sidebar until Show Sidebar asks; the request lasts until the window crosses the threshold again. Neither is stored.
  const narrow = useNarrowWindow()
  const [askedIn, setAskedIn] = useState<boolean | null>(null)
  if (!narrow && askedIn !== null) setAskedIn(null)
  const sidebarOff = sidebarHidden || (narrow && askedIn !== narrow)
  const sidebarShown = !focus && !sidebarOff
  // Hide/show fades and slides the panes (paneMotion.ts): positions are measured before the change renders and played back after layout.
  // Panes are inert from the first frame of a hide, so the keyboard leaves them as it did when they vanished at once.
  const [panesSeen, setPanesSeen] = useState({ focus, sidebarOff })
  const panesBefore = useRef<PaneBoxes | null>(null)
  if (panesSeen.focus !== focus || panesSeen.sidebarOff !== sidebarOff) {
    // oxlint-disable-next-line react/refs -- The panes are measured before the change commits, while their old layout is still on screen (paneMotion.ts).
    panesBefore.current = measurePanes(shownPanes(panesSeen))
    setPanesSeen({ focus, sidebarOff })
  }
  useLayoutEffect(() => {
    const before = panesBefore.current
    panesBefore.current = null
    if (!before) return
    movePanes(before, shownPanes(panesSeen))
    const timer = setTimeout(() => editorRef.current?.remeasure(), EDITOR_REMEASURE_MS)
    return () => clearTimeout(timer)
  }, [panesSeen, editorRef])
  useLayoutEffect(() => {
    document.querySelector('.window > .sidebar')?.toggleAttribute('inert', focus || sidebarOff)
    document.querySelector('.window > .list')?.toggleAttribute('inert', focus)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A start that failed is replaced by a fresh window (Try Again): its panes are new.
  }, [focus, sidebarOff, startFailure])

  // Focus mode hides the sidebar too, so showing it leaves focus mode. A hiding sidebar with the keyboard hands it to the list; shown from the list header toggle, the sidebar takes it.
  const toggleSidebar = () => {
    if (sidebarShown) {
      const hadKeyboard = areaOf(document.activeElement) === 'sidebar'
      // Shown on request in a narrow window: put away again, nothing stored.
      if (narrow && !sidebarHidden) setAskedIn(null)
      else {
        sidebarStore.save(true)
        setSidebarHidden(true)
      }
      if (hadKeyboard) requestFocus({ kind: 'area', area: 'list' })
      return
    }
    if (document.activeElement?.closest('.sidebar-toggle')) {
      requestFocus({ kind: 'area', area: 'sidebar' })
    }
    if (focus) {
      focusStore.save(false)
      setFocus(false)
    }
    sidebarStore.save(false)
    setSidebarHidden(false)
    setAskedIn(narrow)
  }

  return {
    focusStore,
    focus,
    setFocus,
    toggleFocus,
    narrow,
    sidebarOff,
    sidebarShown,
    toggleSidebar,
  }
}

/** View > Sidebar in the menu bar, which the window's own key also reaches. */
export function useSidebarMenu({
  sidebarShown,
  toggleSidebar,
}: {
  sidebarShown: boolean
  toggleSidebar: () => void
}) {
  const sidebarKeyEcho = useRef(-Infinity)
  useMenuEvent('devot://toggle-sidebar', TOGGLE_SIDEBAR, () => {
    const echo = performance.now() < sidebarKeyEcho.current
    sidebarKeyEcho.current = -Infinity
    if (!echo) toggleSidebar()
  })
  // The menu item is shared by the main windows, so the one in front says what it shows.
  useEffect(() => {
    if (!hasDesktopShell) return
    const say = () =>
      void invoke('sidebar_menu_set', { shown: sidebarShown }).catch(() =>
        console.warn('W_SIDEBAR_MENU_SET_FAILED'),
      )
    say()
    window.addEventListener('focus', say)
    return () => window.removeEventListener('focus', say)
  }, [sidebarShown])
  const toggleSidebarCommand = () => {
    sidebarKeyEcho.current = performance.now() + MENU_ECHO_MS
    toggleSidebar()
  }
  return toggleSidebarCommand
}

export function useListLayoutFade(listView: string, shownLayout: ListLayout) {
  const layoutSeen = useRef({ view: listView, layout: shownLayout })
  useLayoutEffect(() => {
    const was = layoutSeen.current
    layoutSeen.current = { view: listView, layout: shownLayout }
    if (was.view === listView && was.layout !== shownLayout) fadeInListBody()
  }, [listView, shownLayout])
}
