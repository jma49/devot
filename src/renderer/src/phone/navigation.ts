import { sizes } from '../theme/tokens'
import type { PhoneStatusFilter, PhoneView } from './library'

export type PhoneTab = 'notes' | 'library' | 'activity' | 'settings'
export const PHONE_TABS: readonly PhoneTab[] = ['notes', 'library', 'activity', 'settings']

export type PhoneScreen = 'root' | 'list' | 'note'

export interface PhoneRoute {
  readonly id: number
  readonly screen: PhoneScreen
  readonly view?: PhoneView
  readonly noteId?: string
  /** A note New Note made: discarded when its screen is left untouched. */
  readonly fresh?: boolean
}

export interface PhoneNavigation {
  readonly tab: PhoneTab
  readonly stacks: Readonly<Record<PhoneTab, readonly PhoneRoute[]>>
  readonly nextId: number
  /** What the Notes tab's root lists, set by a smart tile. */
  readonly notes: { readonly view: PhoneView; readonly status: PhoneStatusFilter }
}

export type PhoneNavigationAction =
  | { readonly type: 'selectTab'; readonly tab: PhoneTab }
  | ({ readonly type: 'push' } & Omit<PhoneRoute, 'id'>)
  | { readonly type: 'showNotes'; readonly view: PhoneView; readonly status: PhoneStatusFilter }
  | { readonly type: 'pop' }
  /** A note New Note made, over the list that shows it when the one below would not (`listView`). */
  | { readonly type: 'newNoteShown'; readonly listView: PhoneView | null; readonly noteId: string }

// An iPad's layout is out of scope, and an iPhone keeps this layout turned sideways.
export const isPhoneLayout = (userAgent: string): boolean => /\biPhone\b/.test(userAgent)

export const initialNavigation = (): PhoneNavigation => ({
  tab: 'library',
  stacks: {
    notes: [{ id: 0, screen: 'root' }],
    library: [{ id: 1, screen: 'root' }],
    activity: [{ id: 2, screen: 'root' }],
    settings: [{ id: 3, screen: 'root' }],
  },
  nextId: 4,
  notes: { view: { kind: 'all' }, status: 'all' },
})

export function navigate(state: PhoneNavigation, action: PhoneNavigationAction): PhoneNavigation {
  const stack = state.stacks[state.tab]
  const withStack = (next: readonly PhoneRoute[]) => ({
    ...state,
    stacks: { ...state.stacks, [state.tab]: next },
  })
  switch (action.type) {
    case 'selectTab':
      return action.tab === state.tab ? withStack(stack.slice(0, 1)) : { ...state, tab: action.tab }
    case 'push':
      return {
        ...withStack([
          ...stack,
          (({ type: _type, ...route }) => ({ ...route, id: state.nextId }))(action),
        ]),
        nextId: state.nextId + 1,
      }
    case 'showNotes':
      return {
        ...state,
        tab: 'notes',
        stacks: { ...state.stacks, notes: state.stacks.notes.slice(0, 1) },
        notes: { view: action.view, status: action.status },
      }
    case 'pop':
      return stack.length > 1 ? withStack(stack.slice(0, -1)) : state
    case 'newNoteShown': {
      const list: PhoneRoute[] = action.listView
        ? [{ id: state.nextId, screen: 'list', view: action.listView }]
        : []
      const note: PhoneRoute = {
        id: state.nextId + list.length,
        screen: 'note',
        noteId: action.noteId,
        fresh: true,
      }
      return { ...withStack([...stack, ...list, note]), nextId: note.id + 1 }
    }
  }
}

const BACK_THRESHOLD = Number.parseFloat(sizes['size.phone-back-threshold'])
const FLICK_SPEED = 0.5
const FLICK_MIN_TRAVEL = 24

/** Whether letting go of a back swipe pops; `speed` is rightward points a millisecond. */
export const releasePops = (travel: number, speed: number): boolean =>
  speed >= 0 && (travel > BACK_THRESHOLD || (speed > FLICK_SPEED && travel > FLICK_MIN_TRAVEL))

const FLICK_MAX_REST_MS = 100

/** A finger that stopped before letting go has not flicked, whatever its last move's speed. */
export const releaseSpeed = (lastSpeed: number, restMs: number): number =>
  restMs > FLICK_MAX_REST_MS ? 0 : lastSpeed

const PUSHED_BELOW_VW = 30
const DIM_BELOW = Number(sizes['opacity.phone-dim-push'])

export function layerPlacement(
  index: number,
  top: number,
  drag: number,
  width: number,
): { x: string; dim: number } {
  if (index === top) return { x: `${drag}px`, dim: 0 }
  const progress = index === top - 1 ? 1 - Math.min(1, drag / width) : 1
  return { x: `${PUSHED_BELOW_VW * -progress}vw`.replace('-0vw', '0vw'), dim: DIM_BELOW * progress }
}

const DEFAULT_BODY_POINTS = 17

// The smallest accessibility text size has a 28 pt body; the largest standard one, 23.
const ACCESSIBILITY_SCALE = 28 / 17

export const isAccessibilitySize = (textScale: number): boolean => textScale >= ACCESSIBILITY_SCALE

export const textScaleFrom = (bodyPoints: number): number =>
  bodyPoints > 0 ? bodyPoints / DEFAULT_BODY_POINTS : 1
