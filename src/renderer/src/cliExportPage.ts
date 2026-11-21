// The entry of export.html (see cliExport.ts).
import { runExport } from './cliExport'
import { resolveLocale, setLocale, shownLanguages } from './i18n'

await setLocale(resolveLocale(shownLanguages()))
void runExport()
