// Starter templates: a few ready-made templates every library offers. They
// are not stored: they are read-only, listed after the user's own templates
// under "Built-in", and editing one saves a copy as the user's own template
// (TemplateService.save). Their IDs start with `starter:`, which no stored
// note's ID does.
//
// Each body has an instruction quote (`> # !Instructions`): it
// explains the template, stays visible in the template and is left out of
// the notes made from it (templates.ts).

export const STARTER_PREFIX = 'starter:'

export interface StarterTemplate {
  /** `starter:` and a short name. */
  id: string
  title: string
  body: string
}

const make = (name: string, title: string, body: string): StarterTemplate => ({
  id: `${STARTER_PREFIX}${name}`,
  title,
  body,
})

export const STARTER_TEMPLATES: readonly StarterTemplate[] = Object.freeze([
  make(
    'brainstorming',
    'Brainstorming',
    `> # !Instructions
> Write the topic under Goal, then list every idea without judging it.
> Group the ideas, pick the best few and give each a next step.

# {{title}}

## Goal

## Ideas

- 

## Groups

## Next steps

- [ ] 
`,
  ),
  make(
    'debugging',
    'Debugging',
    `> # !Instructions
> Describe what you expected and what happened, then record each attempt
> and what it showed. Finish with the cause and the fix.

# {{title}}

## Expected behaviour

## Actual behaviour

## Steps to reproduce

1. 

## Attempts

- 

## Cause

## Fix

- [ ] 
`,
  ),
  make(
    'learning',
    'Learning',
    `> # !Instructions
> Note the source and what you want to learn. Write the key points in your
> own words, then questions, then a short summary you could teach from.

# {{title}}

## Source

## What I want to learn

## Key points

- 

## Questions

- 

## Summary
`,
  ),
  make(
    'planning',
    'Planning',
    `> # !Instructions
> State the outcome and why it matters. Break it into tasks with owners and
> dates, and list what could go wrong.

# {{title}}

## Outcome

## Why it matters

## Tasks

- [ ] 

## Timeline

## Risks
`,
  ),
  make(
    'daily-report',
    'Daily Report',
    `---
title: Daily Report {{date}}
---

> # !Instructions
> Fill this in at the end of the day. {{date}} is replaced with today's date
> in each note made from this template.

# {{title}}

## Done today

- 

## In progress

- 

## Blockers

- 

## Plan for tomorrow

- [ ] 
`,
  ),
])

/** Whether `id` names a starter template (it need not exist). */
export const isStarterTemplate = (id: string) => id.startsWith(STARTER_PREFIX)

/** The starter template with this ID, or undefined. */
export const starterTemplate = (id: string): StarterTemplate | undefined =>
  STARTER_TEMPLATES.find((t) => t.id === id)
