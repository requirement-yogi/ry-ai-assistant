import { z } from "zod"

export const PropertySchema = z.object({
  label: z.string(),
  value: z.string(),
})

export const RequirementNodeSchema: z.ZodType<RequirementNode> = z.lazy(() =>
  z.object({
    key: z.string().regex(/^[A-Z]{2,8}-\d{3}$/, "Format attendu : PREFIX-NNN (ex: WEBHOOK-001)"),
    title: z.string(),
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
  key: string   // code identifiant : FORMAT [A-Z]{2,8}-\d{3} ex: WEBHOOK-001
  title: string // texte descriptif : ex: "Webhook de déclenchement café"
  properties: Property[]
  children: RequirementNode[]
}
export type RequirementsTree = z.infer<typeof RequirementsTreeSchema>
