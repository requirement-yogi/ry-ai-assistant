import { describe, it, expect } from "vitest"
import { withTelemetry, TOOL_NAMES } from "../../src/tools/registry.js"
import { RyApiError, RyAmbiguityError } from "../../src/errors.js"

// registry.ts is the choke point every tool passes through, so what it does on failure IS the
// error behaviour of every registered tool. A thrown error must come back as an `isError` tool result the
// LLM can read and react to — never as a protocol-level crash, which the client surfaces as a dead
// tool with no explanation.
//
// Note: sendTelemetry is fire-and-forget and swallows its own failures, and no RY_* env var is set
// here, so nothing in these tests touches the network.

const call = (tool: any, args: unknown = {}) => tool(args, {} as any) as Promise<any>

describe("withTelemetry", () => {
  it("passes a successful result through untouched", async () => {
    const result = { content: [{ type: "text", text: "ok" }] }
    const wrapped = withTelemetry(TOOL_NAMES.listApplications, (async () => result) as any)
    expect(await call(wrapped)).toEqual(result)
  })

  it("turns a thrown error into an isError result carrying message and guidance", async () => {
    const wrapped = withTelemetry(TOOL_NAMES.listApplications, (async () => {
      throw new RyAmbiguityError("Several Confluence instances are connected (a, b).")
    }) as any)

    const result = await call(wrapped)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("list_applications failed: Several Confluence instances")
    expect(result.content[0].text).toContain("Ask the user which one to use")
  })

  it("appends the tool's own guidance when one is configured", async () => {
    const wrapped = withTelemetry(
      TOOL_NAMES.searchRequirements,
      (async () => {
        throw new RyApiError("400 — Syntax error at position 4", 400, "GET", "/rest/search", "")
      }) as any,
      (error) => (error instanceof RyApiError && error.status === 400 ? "Call list_searchable_fields." : undefined)
    )

    const text = (await call(wrapped)).content[0].text
    // The server's verbatim parse error is what lets the model self-correct — it must survive.
    expect(text).toContain("Syntax error at position 4")
    expect(text).toContain("Call list_searchable_fields.")
  })

  it("omits the tool guidance when the hook returns undefined for that error", async () => {
    const wrapped = withTelemetry(
      TOOL_NAMES.searchRequirements,
      (async () => {
        throw new RyApiError("503", 503, "GET", "/rest/search", "")
      }) as any,
      (error) => (error instanceof RyApiError && error.status === 400 ? "Call list_searchable_fields." : undefined)
    )
    expect((await call(wrapped)).content[0].text).not.toContain("list_searchable_fields")
  })

  it("does not swallow an isError result the handler produced itself", async () => {
    const wrapped = withTelemetry(TOOL_NAMES.buildRequirementsAdf, (async () => ({
      content: [{ type: "text", text: "Validation error: bad tree" }],
      isError: true,
    })) as any)

    const result = await call(wrapped)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("Validation error: bad tree")
  })

  it("handles a handler throwing something that is not an Error", async () => {
    const wrapped = withTelemetry(TOOL_NAMES.listRelationships, (async () => {
      throw "nope"
    }) as any)
    expect((await call(wrapped)).content[0].text).toBe("list_relationships failed: nope")
  })
})
