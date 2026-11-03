import { Facet } from '@codemirror/state'

/** True while Write mode is on in the editor. */
export const writeActive = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})
