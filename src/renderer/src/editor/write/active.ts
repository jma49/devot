import { Facet } from '@codemirror/state'

export const writeActive = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})
