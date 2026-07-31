// Typed access to the tool descriptions authored in src/prompts/tools/*.md and embedded at build
// time by scripts/embed-docs.mjs. Tool files never carry their own description string: registry.ts
// resolves it from the tool name, so the prompt and the registration can't drift.

import { COLUMN_MEANINGS, TOOL_DESCRIPTIONS } from "./index.generated.js"
import type { ToolName } from "../tools/toolNames.js"
import type { StepType } from "../api/traceabilityDto.js"

// Completeness is enforced in BOTH directions at compile time:
//  - a tool declared in TOOL_NAMES with no src/prompts/tools/<name>.md → this assignment fails;
//  - an orphan .md matching no tool → the AssertExtends alias below fails.
const DESCRIPTIONS: Record<ToolName, string> = TOOL_DESCRIPTIONS

type AssertExtends<Subset extends Superset, Superset> = Subset
type _NoOrphanPrompt = AssertExtends<keyof typeof TOOL_DESCRIPTIONS, ToolName>

export function toolDescription(name: ToolName): string {
  return DESCRIPTIONS[name]
}

// What each traceability column type MEANS, from the `## STEP_TYPE` sections of
// src/prompts/matrix_columns.md. Same both-directions compile-time check as the tool descriptions: a step
// type with no section fails this assignment, a section matching no step type fails the alias below.
// So the glossary cannot silently fall behind the enum — which is the whole point, since a type the
// model cannot interpret is a column it will refuse to use.
//
// (Importing a type from api/ here mirrors the ToolName import above: prompts/ owns text but is
// allowed to check itself against the enums that text describes.)
const MEANINGS: Record<StepType, string> = COLUMN_MEANINGS
type _NoOrphanColumn = AssertExtends<keyof typeof COLUMN_MEANINGS, StepType>

export function columnMeaning(type: StepType): string {
  return MEANINGS[type]
}
