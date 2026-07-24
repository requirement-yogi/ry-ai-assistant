import type { GalaxyEdge, GalaxyEdgeType, GalaxyNode, GalaxyPayload } from "../ui/galaxy/model.js"

type RecordValue = Record<string, unknown>

const MAX_NODES = 400

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" ? (value as RecordValue) : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number") return String(value)
  return undefined
}

function identifier(value: unknown): string | undefined {
  const item = record(value)
  return text(item?.id ?? item?.requirementId ?? item?.targetId ?? item?.issueId ?? value)
}

// DTOProperty carries the value either directly or as a list of values.
function propertyValue(property: unknown): string | undefined {
  const item = record(property)
  if (!item) return text(property)
  const single = text(item.value)
  if (single) return single
  const values = Array.isArray(item.values) ? item.values : undefined
  const parts = values?.map((value) => text(record(value)?.value ?? value)).filter((value): value is string => !!value)
  return parts?.length ? parts.join(", ") : undefined
}

// DTORequirement.properties is a Map<String, DTOProperty> keyed by the property name. The array
// form is kept for the trimmed requirements the linking tools return.
function propertiesOf(value: unknown): Record<string, string> {
  const properties: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const property of value) {
      const item = record(property)
      const label = text(item?.label ?? item?.name ?? item?.key)
      const propertyText = propertyValue(item)
      if (label && propertyText) properties[label] = propertyText
    }
    return properties
  }
  for (const [name, property] of Object.entries(record(value) ?? {})) {
    const propertyText = propertyValue(property)
    if (propertyText) properties[name] = propertyText
  }
  return properties
}

function requirementNode(item: RecordValue): GalaxyNode | undefined {
  const id = identifier(item.id)
  if (!id) return undefined
  const properties = propertiesOf(item.properties)
  const key = text(item.key)
  const body = text(item.text ?? item.description)
  return {
    id: `requirement:${id}`,
    rawId: id,
    type: "requirement",
    label: key ?? body ?? `Requirement ${id}`,
    key,
    text: body,
    status: text(item.status),
    properties,
    confluenceUrl: text(item.canonicalURL ?? item.canonicalUrl ?? item.url),
  }
}

function edgeId(type: GalaxyEdgeType, source: string, target: string, label?: string): string {
  return `${type}:${source}:${target}:${label ?? ""}`
}

function addEdge(edges: Map<string, GalaxyEdge>, type: GalaxyEdgeType, source: string, target: string, label?: string) {
  if (source === target) return
  const id = edgeId(type, source, target, label)
  edges.set(id, { id, source, target, type, label })
}

function references(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.flatMap(references)
  const item = record(value)
  return item ? [item] : []
}

function relationLabel(link: RecordValue): string | undefined {
  const relationship = record(link.relationship)
  return text(link.relationshipName ?? link.type ?? link.label ?? relationship?.name ?? relationship?.label)
}

// PaginatedList<T> wraps its page in a well-known property; a bare array is accepted too.
function paginatedItems(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return references(value)
  const item = record(value)
  if (!item) return []
  for (const property of ["items", "results", "values", "list", "content", "elements"]) {
    if (Array.isArray(item[property])) return references(item[property])
  }
  return []
}

// toDependencies / fromDependencies are Map<relationship name, PaginatedList<DTORequirement>>:
// the relationship name is the map KEY, not a field of the referenced requirement.
function groupedRequirements(value: unknown): Array<[string, RecordValue[]]> {
  return Object.entries(record(value) ?? {}).map(([name, list]) => [name, paginatedItems(list)])
}

// A DTOLink is only a Jira issue when it carries an issue reference. Its own `id` must never be
// used as a fallback: every link has one, including the origin link that says where the
// requirement is defined, and that would turn each requirement's own placement into a Jira node.
function jiraNode(link: RecordValue): GalaxyNode | undefined {
  const id = text(link.issueId ?? link.jiraIssueId)
  const key = text(link.issueKey ?? link.jiraKey)
  if (!id && !key) return undefined
  const rawId = id ?? key!
  return {
    id: `jira:${rawId}`,
    rawId,
    type: "jira",
    label: key ?? `Jira ${rawId}`,
    key,
    text: text(link.summary ?? link.text ?? link.title),
    status: text(link.status),
    jiraUrl: text(link.url ?? link.browseUrl ?? link.canonicalURL),
  }
}

function requirementReference(value: unknown, nodes: Map<string, GalaxyNode>): string | undefined {
  const item = record(value)
  if (!item) return undefined
  const node = requirementNode(item)
  if (node) {
    nodes.set(node.id, node)
    return node.id
  }
  const id = identifier(item)
  return id ? `requirement:${id}` : undefined
}

/**
 * Converts search DTOs defensively. RY deployments have used different property names for
 * hierarchy, links and Jira references, so unknown fields are ignored rather than guessed.
 */
export function buildGalaxyPayload(page: unknown, query: string): GalaxyPayload {
  const response = record(page)
  const results = Array.isArray(response?.results) ? response.results : []
  const nodes = new Map<string, GalaxyNode>()
  const edges = new Map<string, GalaxyEdge>()

  for (const result of results) {
    const requirement = record(result)
    if (!requirement) continue
    const source = requirementNode(requirement)
    if (!source) continue
    nodes.set(source.id, source)

    // fromDependencies = the requirements this one REFERENCES → edge outwards.
    for (const [relationship, targets] of groupedRequirements(requirement.fromDependencies)) {
      for (const target of targets) {
        const targetId = requirementReference(target, nodes)
        if (targetId) addEdge(edges, "dependency", source.id, targetId, relationship)
      }
    }
    // toDependencies = the requirements POINTING TO this one → same edge, drawn inwards. Both
    // endpoints usually appear in the results, so the two directions converge on one edge id.
    for (const [relationship, origins] of groupedRequirements(requirement.toDependencies)) {
      for (const origin of origins) {
        const originId = requirementReference(origin, nodes)
        if (originId) addEdge(edges, "dependency", originId, source.id, relationship)
      }
    }
    // DTORequirement.links is a PaginatedList<DTOLink>: mostly the origin link (where the
    // requirement is defined), plus the Jira links when withJiraData asked for them. Only the
    // entries that actually carry an issue reference become Jira nodes.
    for (const link of paginatedItems(requirement.links)) {
      const jira = jiraNode(link)
      if (!jira) continue
      nodes.set(jira.id, jira)
      addEdge(edges, "jira", source.id, jira.id, relationLabel(link) ?? "Jira")
    }
  }

  // The payload travels through the MCP client to the iframe, and a search page of 200
  // requirements with all their links/dependencies expands into far more nodes than a graph can
  // usefully show. Cap it, and drop the edges whose endpoints did not survive the cap.
  const keptNodes = [...nodes.values()].slice(0, MAX_NODES)
  const keptIds = new Set(keptNodes.map((node) => node.id))
  const cappedNodes = keptNodes.length < nodes.size
  const keptEdges = [...edges.values()].filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
  const morePages = response?.hasNext === true

  return {
    title: "Requirement Galaxy",
    query,
    focusNodeId: keptNodes.find((node) => node.type === "requirement")?.id,
    totalCount: typeof response?.total === "number" ? response.total : results.length,
    truncated: morePages || cappedNodes,
    nodes: keptNodes,
    edges: keptEdges,
    notes: [
      "The galaxy shows the current search page and relationship data returned by Requirement Yogi.",
      ...(morePages ? ["More search results exist; refine the query to keep this view focused."] : []),
      ...(cappedNodes ? [`The graph was capped at ${MAX_NODES} nodes (${nodes.size} were found); narrow the query to see the rest.`] : []),
    ],
  }
}
