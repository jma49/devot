/** Devot's dove (design/app-icon/dove.svg) and the theme colours the pages and the email use. */

export const DOVE = {
  viewBox: '0 0 84.95 74.03',
  gradient: { y1: '2.00', y2: '72.22' },
  path: 'M2.309 51.059 C1.992 50.846 1.905 50.418 2.113 50.098 C4.803 45.955 6.706 41.626 10.538 38.174 C13.273 35.712 15.858 34.674 19.538 34.674 C24.551 34.674 25.698 36.611 30.049 38.369 C31.489 38.95 33.138 38.414 33.961 37.097 C37.749 31.035 38.674 25.481 46.938 17.774 C52.008 13.047 63.108 4.394 68.303 2.081 C69.043 1.751 69.807 2.489 69.504 3.24 C68.53 5.651 67.344 8.296 66.37 10.706 C66.151 11.249 66.499 11.853 67.079 11.935 C70.506 12.416 76.186 15.615 75.938 17.974 C75.701 20.231 69.892 22.573 67.682 24.063 C66.998 24.525 67.243 25.586 68.06 25.701 C71.9 26.24 75.414 28.948 75.138 31.574 C74.908 33.762 71.986 36.784 70.084 38.067 C69.498 38.462 69.576 39.347 70.222 39.635 C74.972 41.75 77.515 44.362 82.089 44.843 C82.671 44.904 82.993 45.549 82.692 46.051 C81.867 47.422 80.296 49.052 79.771 50.35 C79.558 50.879 79.558 51.47 79.771 51.999 C80.296 53.297 82.014 55.371 82.838 56.743 C83.098 57.174 82.899 57.734 82.426 57.906 C76.867 59.93 56.561 69.542 47.938 71.374 C40.09 73.043 27.64 71.231 22.538 69.374 C15.753 66.905 13.868 61.304 9.738 57.174 C7.983 55.419 4.311 52.41 2.309 51.059 Z M31.538 53.174 C41.525 53.698 53.732 52.006 62.338 49.374 C52.812 54.874 40.368 57.869 31.538 53.174 Z M14.938 44.674a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z',
  /** The ink's stops in light (dove.svg) and dark (lockup-dark.svg). */
  ink: {
    light: ['#25837a', '#0e6b62', '#0d655c'],
    dark: ['#74d4c7', '#63cdbf', '#36a092'],
  },
} as const

/** The system theme's colour tokens (design/tokens) in light and dark, by token name. */
export const COLORS = {
  light: {
    'surface-editor': '#ffffff',
    'surface-window': '#ffffff',
    'text-primary': '#212121',
    'text-secondary': '#595959',
    'text-destructive': '#af3b36',
    'line-separator': 'rgb(23 23 23 / 0.1)',
    'line-control': 'rgb(28 27 25 / 0.2)',
    'fill-card': 'rgb(28 27 25 / 0.065)',
    'fill-button': '#ebeae7',
    'fill-field': '#ffffff',
    'accent-text': '#2856a2',
    'accent-on-fill': '#ffffff',
    'focus-ring': 'rgb(52 114 214 / 0.79)',
    'activity-level-4': '#0e6b62',
  },
  dark: {
    'surface-editor': '#0a0a0a',
    'surface-window': '#000000',
    'text-primary': '#dbdbdb',
    'text-secondary': '#a3a3a3',
    'text-destructive': '#f0a6a2',
    'line-separator': 'rgb(245 245 245 / 0.1)',
    'line-control': 'rgb(235 232 226 / 0.18)',
    'fill-card': 'rgb(235 232 226 / 0.08)',
    'fill-button': '#34332f',
    'fill-field': '#171717',
    'accent-text': '#7ea6d8',
    'accent-on-fill': '#ffffff',
    'focus-ring': 'rgb(69 118 178 / 0.97)',
    'activity-level-4': '#63cdbf',
  },
} as const

export type ColorToken = keyof (typeof COLORS)['light']

/**
 * The dove as inline SVG; its stops carry classes so a stylesheet can ink them for dark. `style`
 * is for mail only: the pages' policy refuses style attributes.
 */
export function doveSvg(size: number, id = 'devot-ink', style?: string): string {
  const stops = DOVE.ink.light
    .map((color, i) => `<stop class="ink-${i}" offset="${i / 2}" stop-color="${color}"/>`)
    .join('')
  const [, , width = 1, height = 1] = DOVE.viewBox.split(' ').map(Number)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${DOVE.viewBox}" width="${size}" height="${Math.round((size * height) / width)}" aria-hidden="true" focusable="false"${style ? ` style="${style}"` : ''}>` +
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${DOVE.gradient.y1}" x2="0" y2="${DOVE.gradient.y2}">${stops}</linearGradient></defs>` +
    `<path fill="url(#${id})" fill-rule="evenodd" d="${DOVE.path}"/></svg>`
  )
}
