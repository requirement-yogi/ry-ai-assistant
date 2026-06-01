import { RequirementsTreeSchema, type RequirementsTree } from "../schemas/requirements.js"

export const REFINE_TOOL = {
  name: "refine_requirements",
  description: `Refines an existing requirements tree by applying user feedback.

Receives the current tree (current_tree) and the user's feedback.
Modifies the tree accordingly: add, remove, rephrase, or reorganize requirements.
Returns ONLY the complete, valid, updated JSON tree.`,
  inputSchema: {
    type: "object",
    properties: {
      current_tree: {
        type: "object",
        description: "The current requirements tree (complete JSON object)",
      },
      feedback: {
        type: "string",
        description: "The feedback or changes requested by the user",
      },
    },
    required: ["current_tree", "feedback"],
  },
} as const

export function validateTree(raw: unknown): RequirementsTree {
  return RequirementsTreeSchema.parse(raw)
}
