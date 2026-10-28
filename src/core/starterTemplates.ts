// Starter templates: a few ready-made templates every library offers. They
// are not stored: they are read-only, listed after the user's own templates
// under "Built-in", and editing one saves a copy as the user's own template
// (TemplateService.save). Their IDs start with `starter:`, which no stored
// note's ID does. The window supplies their text from the message catalog
// (`starters` in TemplateServiceOptions).
//
// Each body has an instruction quote (`> # !Instructions`): it
// explains the template, stays visible in the template and is left out of
// the notes made from it (templates.ts).

export const STARTER_PREFIX = 'starter:'

export interface StarterTemplate {
  id: string
  title: string
  body: string
}

export const isStarterTemplate = (id: string) => id.startsWith(STARTER_PREFIX)
