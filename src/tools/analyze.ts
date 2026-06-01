import { RequirementsTreeSchema, type RequirementsTree } from "../schemas/requirements.js"

export const ANALYZE_TOOL = {
  name: "analyze_prompt",
  description: `Analyzes a user prompt and produces a structured requirements tree in JSON format.

Break down the request into hierarchical requirements (2 to 4 levels depending on complexity).
Each requirement has a short meaningful key and free-form properties.

Recommended properties:
- "Description": detailed explanation of the requirement
- "Acceptance criteria": validation conditions
- "Priority": Must / Should / Could / Won't

Return ONLY a valid JSON object matching this schema:
${JSON.stringify(RequirementsTreeSchema.shape, null, 2)}`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user request describing the feature or need to specify",
      },
      project_name: {
        type: "string",
        description: "Name of the project",
      },
    },
    required: ["prompt", "project_name"],
  },
} as const

export function validateTree(raw: unknown): RequirementsTree {
  return RequirementsTreeSchema.parse(raw)
}
