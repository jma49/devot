import { extract, pageTitle, type Mode } from './extract'

const target = globalThis as typeof globalThis & {
  devotExtract?: (mode: Mode) => ReturnType<typeof extract>
  devotPage?: () => { title: string; selection: boolean }
}
target.devotExtract = (mode) => extract(document, location.href, mode)
target.devotPage = () => ({
  title: pageTitle(document),
  selection: !!document.getSelection()?.toString().trim(),
})
