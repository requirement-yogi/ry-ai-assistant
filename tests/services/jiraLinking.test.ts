import { describe, it, expect } from "vitest"
import {
  createJiraLinkBatch,
  describeSelection,
  formatBulkLinkResult,
  formatLinkReport,
  type JiraLinkingApi,
  type LinkReport,
  type LinkRequest,
} from "../../src/services/jiraLinking.js"
import type { BulkLinkResult } from "../../src/api/dto.js"
import type { JiraBulkLink } from "../../src/api/ryClient.js"

// link_requirements_to_jira is the only tool that writes. What it reports back therefore has to be
// unambiguous: the model decides from this text whether to retry, and a retry that shouldn't have
// happened creates duplicate work for the user.

describe("formatBulkLinkResult", () => {
  it("reports a clean run in one sentence", () => {
    expect(formatBulkLinkResult({ linkedCount: 3, skippedCount: 0, unauthorizedCount: 0 })).toBe(
      "3 link(s) created"
    )
  })

  it("surfaces skipped and unauthorized counts only when there are any", () => {
    expect(formatBulkLinkResult({ linkedCount: 2, skippedCount: 1, unauthorizedCount: 4 })).toBe(
      "2 link(s) created, 1 skipped (link already existed), 4 unauthorized (the user cannot read those Jira issues)"
    )
  })

  it("names 'already existed' explicitly — that is what makes a re-run safe to read", () => {
    expect(formatBulkLinkResult({ linkedCount: 0, skippedCount: 5 })).toContain("already existed")
  })

  it("falls back to the raw payload rather than inventing a count", () => {
    expect(formatBulkLinkResult({ weird: true } as never)).toBe('{"weird":true}')
  })

  it("reports an empty-body success as completed, not as a raw '{}'", () => {
    // Some deployments answer a successful link with 204/empty; createJiraLinks turns that into {}.
    // It must read as a success, or the model would treat a link it created as needing a retry.
    expect(formatBulkLinkResult({})).toBe("Link operation completed (Requirement Yogi returned no counts).")
  })
})

describe("describeSelection", () => {
  const link = (selection: Partial<JiraBulkLink["selection"]>): JiraBulkLink => ({
    selection: {
      containerId: 1,
      variantId: 2,
      selectedRequirementIds: [],
      excludedRequirementIds: [],
      selectAll: false,
      ...selection,
    },
    jiraApplicationId: 7,
    issueIds: [100, 101],
    relationshipId: 42,
  })

  it("names the explicitly selected requirements", () => {
    expect(describeSelection(link({ selectedRequirementIds: [10, 11] }))).toBe(
      "requirements [10, 11] → issues [100, 101] (relationship 42)"
    )
  })

  it("names the query instead when the operation selects everything it matches", () => {
    expect(describeSelection(link({ selectAll: true, query: "key ~ 'REQ-%'" }))).toContain(
      `query "key ~ 'REQ-%'"`
    )
  })
})

describe("formatLinkReport", () => {
  const operation = (ok: boolean, selection: string, result: string) => ({ selection, ok, result })
  const report = (operations: LinkReport["operations"]): LinkReport => ({
    completed: operations.filter((o) => o.ok).length,
    failed: operations.filter((o) => !o.ok).length,
    operations,
  })

  it("lists successes and failures in separate sections", () => {
    const text = formatLinkReport(
      report([
        operation(true, "requirements [1] → issues [10] (relationship 3)", "1 link(s) created"),
        operation(false, "requirements [2] → issues [11] (relationship 3)", "403 Forbidden"),
      ])
    )
    expect(text).toContain("Completed 1 link operation(s)")
    expect(text).toContain("Failed 1 link operation(s)")
    // Every operation must be traceable back to what it covered, so a partial batch can be resumed.
    expect(text).toContain("requirements [1] → issues [10] (relationship 3): 1 link(s) created")
    expect(text).toContain("requirements [2] → issues [11] (relationship 3): 403 Forbidden")
  })

  it("says plainly when nothing was created", () => {
    const text = formatLinkReport(report([operation(false, "requirements [1] → issues [10]", "500")]))
    expect(text).toContain("No link operation completed.")
  })

  it("omits the failure section entirely when everything worked", () => {
    const text = formatLinkReport(report([operation(true, "requirements [1] → issues [10]", "1 link(s) created")]))
    expect(text).not.toContain("Failed")
  })
})

// Partial failure is the case that matters: a batch is often one operation per requirement, so
// aborting on the first rejection would strand the links already created and leave the model
// unable to tell which ones went through.

function fakeApi(outcomes: (BulkLinkResult | Error)[]): JiraLinkingApi {
  let call = 0
  return {
    async createJiraLinks() {
      const outcome = outcomes[call++]
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

const request = (id: number): LinkRequest => ({
  selection: { container_id: 1, variant_id: 2, selected_requirement_ids: [id] },
  jira_application_id: 7,
  issue_ids: [100 + id],
  relationship_id: 42,
})

describe("createJiraLinkBatch", () => {
  it("keeps going after a failed operation and reports each one", async () => {
    const report = await createJiraLinkBatch([request(1), request(2), request(3)], {
      api: fakeApi([{ linkedCount: 1 }, new Error("403 Forbidden"), { linkedCount: 1 }]),
    })

    expect(report.completed).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.operations.map((operation) => operation.ok)).toEqual([true, false, true])
    expect(report.operations[1].result).toBe("403 Forbidden")
  })

  it("keeps the operations in the order they were requested", async () => {
    const report = await createJiraLinkBatch([request(1), request(2)], {
      api: fakeApi([{ linkedCount: 1 }, { linkedCount: 1 }]),
    })
    expect(report.operations.map((operation) => operation.selection)).toEqual([
      "requirements [1] → issues [101] (relationship 42)",
      "requirements [2] → issues [102] (relationship 42)",
    ])
  })

  it("translates the MCP snake_case selection into the RY API's shape", async () => {
    let received: unknown
    const report = await createJiraLinkBatch(
      [
        {
          selection: { container_id: 9, variant_id: 8, select_all: true, query: "key ~ 'REQ-%'" },
          jira_application_id: 7,
          issue_ids: [100],
          relationship_id: 42,
        },
      ],
      {
        api: {
          async createJiraLinks(link) {
            received = link
            return { linkedCount: 5 }
          },
        },
      }
    )

    expect(received).toEqual({
      selection: {
        query: "key ~ 'REQ-%'",
        containerId: 9,
        variantId: 8,
        selectedRequirementIds: [],
        excludedRequirementIds: [],
        selectAll: true,
      },
      jiraApplicationId: 7,
      issueIds: [100],
      relationshipId: 42,
    })
    expect(report.operations[0].result).toBe("5 link(s) created")
  })

  it("reports an empty batch as doing nothing rather than failing", async () => {
    const report = await createJiraLinkBatch([], { api: fakeApi([]) })
    expect(report).toEqual({ completed: 0, failed: 0, operations: [] })
  })
})
