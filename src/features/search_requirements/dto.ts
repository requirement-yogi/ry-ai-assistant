// The fields this tool exposes to the LLM — its OUTPUT contract, not the wire DTO (core/dto.ts's
// RequirementSchema, which is deliberately loose and carries whatever else the API sends). The two
// currently share a field list, but that is a coincidence of this use case, not infrastructure: only
// search_requirements decides what "the linking essentials" are, so it owns this schema.
// Declaring it as its own schema (rather than a hand-picked field list) makes the exposed shape DATA
// projectOn (core/dto.ts) can reduce a full Requirement onto.

import { z } from "zod"
import { RequirementPropertiesSchema } from "../../core/dto.js"

export const RequirementSummarySchema = z.object({
  id: z.number().int().nullish(),
  key: z.string().nullish(),
  text: z.string().nullish(),
  applicationId: z.number().int().nullish(),
  containerId: z.number().int().nullish(),
  variantId: z.number().int().nullish(),
  status: z.string().nullish(),
  canonicalURL: z.string().nullish(),
  properties: RequirementPropertiesSchema.nullish(),
})

export type RequirementSummary = z.infer<typeof RequirementSummarySchema>
