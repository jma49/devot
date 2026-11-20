import type { WelcomeContent } from '../../../core'

// Only a new, empty library takes the first-launch notes, so their text stays out of the window's first load.
export const loadWelcome = (): Promise<WelcomeContent> =>
  import('./content').then((m) => m.welcomeContent())
