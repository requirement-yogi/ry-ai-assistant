import { describe, expect, it } from "vitest"
import { buildGalaxyPayload } from "./galaxyGraph.js"

// Shapes mirror DTOSearchResult<DTORequirement>: properties is a Map<name, DTOProperty>,
// to/fromDependencies are Map<relationship name, PaginatedList<DTORequirement>>, and links is a
// PaginatedList<DTOLink> holding the origin link plus any Jira link.
describe("buildGalaxyPayload", () => {
  it("reads relations from to/fromDependencies and Jira issues from links", () => {
    const graph = buildGalaxyPayload(
      {
        total: 1,
        results: [{
          id: 1,
          key: "AUTH-1",
          text: "Authenticate users",
          status: "ACTIVE",
          canonicalURL: "https://confluence.example/1",
          properties: { Priority: { key: "Priority", value: "High" } },
          fromDependencies: { "verified by": { items: [{ id: 4, key: "SEC-1" }] } },
          toDependencies: { refines: { items: [{ id: 2, key: "AUTH" }] } },
          links: {
            items: [
              { id: 99, type: "ORIGIN" },
              { id: 100, issueId: 42, issueKey: "PROJ-42", summary: "Auth work" },
            ],
          },
        }],
      },
      "key = 'AUTH-1'"
    )

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "requirement:1", key: "AUTH-1", properties: { Priority: "High" } }),
      expect.objectContaining({ id: "requirement:4", key: "SEC-1" }),
      expect.objectContaining({ id: "requirement:2", key: "AUTH" }),
      expect.objectContaining({ id: "jira:42", key: "PROJ-42" }),
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dependency", source: "requirement:1", target: "requirement:4", label: "verified by" }),
      expect.objectContaining({ type: "dependency", source: "requirement:2", target: "requirement:1", label: "refines" }),
      expect.objectContaining({ type: "jira", source: "requirement:1", target: "jira:42" }),
    ]))
  })

  it("never turns a requirement's own origin link into a Jira node", () => {
    const graph = buildGalaxyPayload(
      { results: [{ id: 1, key: "A", links: { items: [{ id: 77, type: "ORIGIN" }] } }] },
      "key = 'A'"
    )

    expect(graph.nodes.filter((node) => node.type === "jira")).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it("draws one edge when both endpoints report the same relation", () => {
    const graph = buildGalaxyPayload(
      {
        results: [
          { id: 1, key: "A", fromDependencies: { refines: { items: [{ id: 2, key: "B" }] } } },
          { id: 2, key: "B", toDependencies: { refines: { items: [{ id: 1, key: "A" }] } } },
        ],
      },
      "key ~ '%'"
    )

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toEqual(expect.objectContaining({ source: "requirement:1", target: "requirement:2", label: "refines" }))
  })

  it("reports the fields actually present when no relation is found", () => {
    const graph = buildGalaxyPayload(
      { total: 1, results: [{ id: 1, key: "A", storageData: { html: "<p>x</p>" }, toDependencies: {}, fromDependencies: {} }] },
      "key = 'A'"
    )

    expect(graph.edges).toEqual([])
    expect(graph.notes.at(-1)).toContain("storageData")
    expect(graph.notes.at(-1)).not.toContain("toDependencies")
  })
})
