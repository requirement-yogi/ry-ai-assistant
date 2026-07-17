import { describe, it, expect, afterEach } from "vitest"
import { buildInlineExtension } from "./macro.js"

const APP_ID = "2237ccc1-3339-4360-9e41-d8b594746224"
const PROD_ENVIRONMENT_ID = "126ed95b-265f-4505-988f-39c68147fb29"

// The macro reads RY_ENV / RY_DEV_FORGE_ENV_ID from process.env at call time, so save and restore
// them around each test.
const saved = { RY_ENV: process.env.RY_ENV, RY_DEV_FORGE_ENV_ID: process.env.RY_DEV_FORGE_ENV_ID }
afterEach(() => {
  process.env.RY_ENV = saved.RY_ENV
  process.env.RY_DEV_FORGE_ENV_ID = saved.RY_DEV_FORGE_ENV_ID
})

describe("buildInlineExtension", () => {
  it("uses the baked prod environment id when RY_ENV is not dev", () => {
    delete process.env.RY_ENV
    const node = buildInlineExtension("REQ-1") as any
    const path = `${APP_ID}/${PROD_ENVIRONMENT_ID}/static/requirement-yogi`
    expect(node.type).toBe("inlineExtension")
    expect(node.attrs.extensionType).toBe("com.atlassian.ecosystem")
    expect(node.attrs.extensionKey).toBe(path)
    expect(node.attrs.parameters.extensionId).toBe(`ari:cloud:ecosystem::extension/${path}`)
    expect(node.attrs.parameters.guestParams).toEqual({ reqKey: "REQ-1" })
  })

  it("uses the per-developer RY_DEV_FORGE_ENV_ID in dev", () => {
    process.env.RY_ENV = "dev"
    process.env.RY_DEV_FORGE_ENV_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const node = buildInlineExtension("REQ-2") as any
    const path = `${APP_ID}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/static/requirement-yogi`
    expect(node.attrs.extensionKey).toBe(path)
    expect(node.attrs.parameters.extensionId).toBe(`ari:cloud:ecosystem::extension/${path}`)
  })

  it("throws a clear error in dev when RY_DEV_FORGE_ENV_ID is missing", () => {
    process.env.RY_ENV = "dev"
    delete process.env.RY_DEV_FORGE_ENV_ID
    expect(() => buildInlineExtension("REQ-3")).toThrow(/RY_DEV_FORGE_ENV_ID is not set/)
  })
})
