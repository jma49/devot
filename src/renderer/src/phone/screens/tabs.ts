import { PHONE_TABS, type PhoneNavigation, type PhoneTab } from '../navigation'
import type { TabsState } from './message'
import type { ScreensHandlers } from './ops'

export interface NativeTabs {
  readonly show: (tab: PhoneTab) => void
  readonly popToRoot: (tab: PhoneTab) => void
}

const isPhoneTab = (value: unknown): value is PhoneTab => PHONE_TABS.some((tab) => tab === value)

/** The native tab bar's operations, run against the page's own navigation. */
export function tabHandlers(tabs: NativeTabs): ScreensHandlers {
  const withTab =
    (run: (tab: PhoneTab) => void) => async (args: Readonly<Record<string, unknown>>) => {
      const tab = args['tab']
      if (!isPhoneTab(tab)) throw new Error('E_SCREENS_ARGS_INVALID')
      run(tab)
      return {}
    }
  return { 'tabs.show': withTab(tabs.show), 'tabs.popToRoot': withTab(tabs.popToRoot) }
}

/**
 * The bar goes over a note, as the system's goes over a pushed editor, and while something covers
 * the whole page (search, a sheet); it stays over a pushed list or pane.
 */
export function tabsState(
  navigation: PhoneNavigation,
  covered: boolean,
  attention: boolean,
): TabsState {
  const top = navigation.stacks[navigation.tab].at(-1)
  return { tab: navigation.tab, barHidden: covered || top?.screen === 'note', attention }
}
