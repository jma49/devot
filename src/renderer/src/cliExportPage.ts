// The entry of export.html (see cliExport.ts).
import { runExport } from './cliExport'
import { resolveLocale, setLocale } from './i18n'

await setLocale(resolveLocale(navigator.languages))
void runExport()
