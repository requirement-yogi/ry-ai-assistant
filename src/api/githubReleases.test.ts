import { describe, it, expect } from "vitest"
import { compareSemver, parseSemver, buildUpdateCheck } from "./githubReleases.js"

describe("parseSemver", () => {
  it("parses plain, v-prefixed and prerelease versions", () => {
    expect(parseSemver("1.2.3")).toEqual({ core: [1, 2, 3], prerelease: [] })
    expect(parseSemver("v1.2.3")).toEqual({ core: [1, 2, 3], prerelease: [] })
    expect(parseSemver("0.2.0-beta")).toEqual({ core: [0, 2, 0], prerelease: ["beta"] })
    expect(parseSemver("1.0.0-beta.11")).toEqual({ core: [1, 0, 0], prerelease: ["beta", "11"] })
  })

  it("returns null for unparseable input", () => {
    expect(parseSemver("not-a-version")).toBeNull()
    expect(parseSemver("")).toBeNull()
  })
})

describe("compareSemver", () => {
  it("orders by numeric core", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1)
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1)
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0)
  })

  it("treats a prerelease as older than its release", () => {
    expect(compareSemver("0.2.0-beta", "0.2.0")).toBe(-1)
    expect(compareSemver("0.2.0", "0.2.0-beta")).toBe(1)
  })

  it("orders prerelease identifiers per semver", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1)
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1) // numeric, not lexical
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.1")).toBe(-1) // shorter prefix is lower
  })

  it("ignores a leading v on either side", () => {
    expect(compareSemver("v1.2.3", "1.2.4")).toBe(-1)
  })

  it("degrades to equal when a version is unparseable", () => {
    expect(compareSemver("weird", "1.0.0")).toBe(0)
  })
})

describe("buildUpdateCheck", () => {
  it("flags an available update and carries the release metadata", () => {
    const check = buildUpdateCheck("0.2.0-beta", {
      tag_name: "v0.3.0",
      name: "0.3.0 — telemetry",
      html_url: "https://github.com/requirement-yogi/ry-ai-assistant/releases/tag/v0.3.0",
      body: "New telemetry endpoint.",
      published_at: "2026-07-01T00:00:00Z",
    })
    expect(check).toMatchObject({
      current_version: "0.2.0-beta",
      latest_version: "v0.3.0",
      update_available: true,
      release_name: "0.3.0 — telemetry",
      release_notes: "New telemetry endpoint.",
      checked: true,
    })
  })

  it("reports up to date when current >= latest", () => {
    const check = buildUpdateCheck("1.0.0", { tag_name: "v1.0.0" })
    expect(check.update_available).toBe(false)
    expect(check.checked).toBe(true)
  })

  it("truncates long release notes", () => {
    const long = "x".repeat(5000)
    const check = buildUpdateCheck("1.0.0", { tag_name: "v1.1.0", body: long })
    expect(check.release_notes?.endsWith("…(truncated)")).toBe(true)
    expect(check.release_notes!.length).toBeLessThan(long.length)
  })

  it("marks the check as failed when the release has no tag", () => {
    const check = buildUpdateCheck("1.0.0", {})
    expect(check.checked).toBe(false)
    expect(check.note).toBeTruthy()
  })
})
