export const DOVE = {
  viewBox: '0 0 84.95 74.03',
  gradient: { y1: '3', y2: '69' },
  path: 'M2.6 50.5 C2.2 50.25 2.12 49.75 2.39 49.35 C5.05 45.4 7.05 41.1 10.95 37.8 C13.75 35.43 16.18 34.35 19.65 34.35 C23.55 34.35 26.12 36.15 29.7 37.55 C31.85 38.39 33.65 37.4 34.65 35.4 C41.1 22.6 53.4 10.2 67.2 3.05 C68 2.635 68.75 3.37 68.39 4.21 L65.75 10.4 C65.44 11.13 65.8 11.94 66.6 12.12 C71.8 13.3 75.1 15.78 75.1 18.25 C75.1 20.55 70.83 22.64 67.15 24.25 C66.3 24.622 66.4 25.769 67.31 26.02 C71.63 27.21 73.82 29.12 73.82 31.28 C73.82 33.44 71.17 36.06 68.65 37.95 C67.93 38.49 68.03 39.49 68.89 39.9 C73.84 42.26 77.45 43.64 82 44.55 C82.76 44.702 83.04 45.38 82.58 45.96 L78.96 50.55 C78.58 51.03 78.58 51.69 78.98 52.17 L82.43 56.36 C82.93 56.97 82.67 57.62 81.94 57.84 C72.05 60.82 61.54 65.78 51.1 67.7 C41.05 69.55 30.17 68.58 23.3 65.94 C17.35 63.65 14.6 59.87 10.32 55.97 C7.53 53.43 4.96 52.03 2.6 50.5 Z M33 53.4 C42.1 52.8 52.4 49.8 62.1 45.8 C55.5 50.9 45.2 54.8 33 53.4 Z M15.05 43.95 a2.05 2.05 0 1 0 4.1 0 a2.05 2.05 0 1 0 -4.1 0 Z',
  smallPath:
    'M2.6 50.5 C2.2 50.25 2.12 49.75 2.39 49.35 C5.05 45.4 7.05 41.1 10.95 37.8 C13.75 35.43 16.18 34.35 19.65 34.35 C23.55 34.35 26.12 36.15 29.7 37.55 C31.85 38.39 33.65 37.4 34.65 35.4 C41.1 22.6 53.4 10.2 67.2 3.05 C68 2.635 68.75 3.37 68.39 4.21 L65.5 14.1 C65.2 15.1 65.75 16.1 66.8 16.35 C72.6 17.7 76.05 20.8 75.65 24.35 C75.29 27.55 71.36 32.03 67.85 35.15 C66.94 35.96 67.16 37.24 68.28 37.83 C73.19 40.43 77.45 43.64 82 44.55 C82.96 44.742 83.31 45.66 82.6 46.48 L77.94 50.42 C77.12 51.11 77.12 52.07 77.98 52.82 L82.43 56.7 C83.2 57.37 82.84 58.26 81.94 58.53 C72.05 60.82 61.54 65.78 51.1 67.7 C41.05 69.55 30.17 68.58 23.3 65.94 C17.35 63.65 14.6 59.87 10.32 55.97 C7.53 53.43 4.96 52.03 2.6 50.5 Z M13.1 43.95 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 Z',
  ink: {
    light: ['#25837a', '#0e6b62', '#0d655c'],
    dark: ['#74d4c7', '#63cdbf', '#36a092'],
  },
} as const

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
  const path = size <= 32 ? DOVE.smallPath : DOVE.path
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${DOVE.viewBox}" width="${size}" height="${Math.round((size * height) / width)}" aria-hidden="true" focusable="false"${style ? ` style="${style}"` : ''}>` +
    `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${DOVE.gradient.y1}" x2="0" y2="${DOVE.gradient.y2}">${stops}</linearGradient></defs>` +
    `<path fill="url(#${id})" fill-rule="evenodd" d="${path}"/></svg>`
  )
}
