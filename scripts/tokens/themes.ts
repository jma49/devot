// The built-in themes besides the default one (the `system` token files).
// Each is `design/tokens/themes/<id>.light|dark.tokens.json`, compiled to
// rules scoped by `data-theme='<id>'` on the root element. The ids are the
// values of the `theme` setting (`THEMES` in src/core/editorSettings.ts);
// tests/tokens/themes.test.ts keeps the two lists in step.
export const BUILT_IN_THEMES: readonly { readonly id: string }[] = [{ id: 'ivory' }]
