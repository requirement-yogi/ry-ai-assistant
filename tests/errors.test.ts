import { describe, it, expect } from "vitest"
import {
  RyError,
  RyApiError,
  RyConfigError,
  RyAmbiguityError,
  RyConnectionError,
  formatToolFailure,
} from "../src/errors.js"

describe("the error taxonomy", () => {
  it("keeps instanceof working so callers can branch on the failure kind", () => {
    const error = new RyApiError("boom", 400, "GET", "/rest/search", "Syntax error")
    expect(error).toBeInstanceOf(RyApiError)
    expect(error).toBeInstanceOf(RyError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("RyApiError")
  })

  it("exposes the status as a field rather than something to regex out of the message", () => {
    const error = new RyApiError("boom", 429, "GET", "/applications", "")
    expect(error.status).toBe(429)
    expect(error.method).toBe("GET")
    expect(error.path).toBe("/applications")
  })

  it("gives each status its own actionable guidance", () => {
    const at = (status: number) => new RyApiError("x", status, "GET", "/p", "").guidance
    expect(at(400)).toMatch(/rejected the request as invalid/)
    expect(at(401)).toMatch(/Authentication or authorisation/)
    expect(at(403)).toMatch(/Authentication or authorisation/)
    expect(at(404)).toMatch(/does not exist/)
    expect(at(429)).toMatch(/rate-limiting/)
    expect(at(503)).toMatch(/failed on its side/)
  })

  it("tells the model a config error is not worth retrying", () => {
    expect(new RyConfigError("no token").guidance).toMatch(/retrying will not help/i)
  })

  it("tells the model to ask the user when several candidates match", () => {
    expect(new RyAmbiguityError("two instances").guidance).toMatch(/Ask the user which one/)
  })

  it("says nothing was changed when the API was never reached", () => {
    const error = new RyConnectionError("ECONNREFUSED", "http://localhost:8082/api/applications")
    expect(error.url).toBe("http://localhost:8082/api/applications")
    expect(error.guidance).toMatch(/never reached, so nothing was changed/)
  })
})

describe("formatToolFailure", () => {
  it("reports the tool, the message and the class guidance", () => {
    const text = formatToolFailure("search_requirements", new RyConfigError("RY_DATA_RESIDENCY must be EU or US"))
    expect(text).toContain("search_requirements failed: RY_DATA_RESIDENCY must be EU or US")
    expect(text).toContain("retrying will not help")
  })

  it("appends tool-specific guidance after the class guidance, never instead of it", () => {
    const error = new RyApiError("400 — Syntax error at position 4", 400, "GET", "/rest/search", "")
    const text = formatToolFailure("search_requirements", error, "Call list_searchable_fields first.")
    expect(text.indexOf("rejected the request as invalid")).toBeLessThan(
      text.indexOf("Call list_searchable_fields first.")
    )
  })

  it("still reports an error that is not part of the taxonomy", () => {
    expect(formatToolFailure("build_requirements_adf", new Error("kaboom"))).toBe(
      "build_requirements_adf failed: kaboom"
    )
  })

  it("survives a thrown non-Error", () => {
    expect(formatToolFailure("x", "just a string")).toBe("x failed: just a string")
  })
})
