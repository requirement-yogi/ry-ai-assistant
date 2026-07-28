import { describe, it, expect } from "vitest"
import { formatUpdateBanner, formatUpdateSummary } from "../src/updateCheck.js"
import type { UpdateCheck } from "../src/api/githubReleases.js"

const UPDATE: UpdateCheck = {
  current_version: "0.2.0-beta",
  latest_version: "v0.3.0",
  update_available: true,
  release_name: "0.3.0",
  release_url: "https://github.com/requirement-yogi/ry-ai-assistant/releases/tag/v0.3.0",
  release_notes: "New stuff.",
  checked: true,
}

describe("formatUpdateBanner", () => {
  it("leads with the tagged notice and includes versions, url and notes", () => {
    const banner = formatUpdateBanner(UPDATE)
    expect(banner.startsWith("[Requirement Yogi AI Assistant — update available]")).toBe(true)
    expect(banner).toContain("0.2.0-beta")
    expect(banner).toContain("v0.3.0")
    expect(banner).toContain(UPDATE.release_url!)
    expect(banner).toContain("New stuff.")
  })
})

describe("formatUpdateSummary", () => {
  it("returns the banner when an update is available", () => {
    expect(formatUpdateSummary(UPDATE)).toBe(formatUpdateBanner(UPDATE))
  })

  it("says up to date when current matches latest", () => {
    const summary = formatUpdateSummary({
      current_version: "1.0.0",
      latest_version: "v1.0.0",
      update_available: false,
      checked: true,
    })
    expect(summary).toContain("up to date")
    expect(summary).not.toContain("update available")
  })

  it("explains a failed check without alarming", () => {
    const summary = formatUpdateSummary({
      current_version: "1.0.0",
      checked: false,
      note: "No published release found on GitHub yet.",
    })
    expect(summary).toContain("Could not check for updates")
    expect(summary).toContain("does not affect the tools")
  })
})
