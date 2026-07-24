// "page" is rendered and legended, but nothing emits it yet: DTORequirement.container is a
// DTOConfluenceSpaceContainer (it answers getSpaceKey()), so it identifies the space, not the page.
export type GalaxyNodeType = "requirement" | "page" | "jira"

export type GalaxyNode = {
  id: string
  type: GalaxyNodeType
  label: string
  key?: string
  text?: string
  status?: string
  properties?: Record<string, string>
  confluenceUrl?: string
  jiraUrl?: string
  rawId?: number | string
}

export type GalaxyEdgeType = "hierarchy" | "dependency" | "relationship" | "jira"

export type GalaxyEdge = { id: string; source: string; target: string; type: GalaxyEdgeType; label?: string }

export type GalaxyPayload = {
  title: string
  query: string
  focusNodeId?: string
  totalCount: number
  truncated: boolean
  nodes: GalaxyNode[]
  edges: GalaxyEdge[]
  notes: string[]
}
