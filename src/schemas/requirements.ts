import { z } from "zod"

export const PropertySchema = z.object({
  label: z.string(),
  value: z.string(),
})

export const RequirementNodeSchema: z.ZodType<RequirementNode> = z.lazy(() =>
  z.object({
    // Free-form key chosen by the user — no imposed format. A node WITHOUT a key
    // is a pure section (rendered as a heading, no macro).
    key: z.string().min(1).optional(),
    description: z.string(),
    properties: z.array(PropertySchema).default([]),
    children: z.array(RequirementNodeSchema).default([]),
  })
)

export const RequirementsTreeSchema = z.object({
  version: z.literal("1.0"),
  project_name: z.string(),
  description: z.string(),
  created_at: z.string().datetime(),
  requirements: z.array(RequirementNodeSchema),
})

export type Property = z.infer<typeof PropertySchema>
export type RequirementNode = {
  key?: string            // free-form identifier; absent on section nodes
  description: string     // col 2 in a table, text after the macro in a paragraph, heading text
  properties: Property[]  // extra table columns only (empty for paragraph/heading contexts)
  children: RequirementNode[]
}
export type RequirementsTree = z.infer<typeof RequirementsTreeSchema>
