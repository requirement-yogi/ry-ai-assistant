// Typed access to the tool descriptions authored in src/prompts/tools/*.md and embedded at build
// time by scripts/embed-docs.mjs. Tool files never carry their own description string: registry.ts
// resolves it from the tool name, so the prompt and the registration can't drift.

import { TOOL_DESCRIPTIONS } from "./index.generated.js"
import type { ToolName } from "../tools/toolNames.js"

// Completeness is enforced in BOTH directions at compile time:
//  - a tool declared in TOOL_NAMES with no src/prompts/tools/<name>.md → this assignment fails;
//  - an orphan .md matching no tool → the AssertExtends alias below fails.
const DESCRIPTIONS: Record<ToolName, string> = TOOL_DESCRIPTIONS

type AssertExtends<Subset extends Superset, Superset> = Subset
type _NoOrphanPrompt = AssertExtends<keyof typeof TOOL_DESCRIPTIONS, ToolName>

export function toolDescription(name: ToolName): string {
  return DESCRIPTIONS[name]
}
