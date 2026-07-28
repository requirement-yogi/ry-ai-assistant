import { describe, it, expect } from "vitest"
import { anchoredInject, applyReplace, applyInsertAfter, blockText } from "../../src/tools/editPage.js"

// These helpers rewrite a REAL Confluence page's ADF in place. The invariant that matters is that
// everything which is not a requirement survives untouched — including the layout/panel structure
// wrapping it. Getting the splice depth wrong doesn't fail loudly, it silently deletes a chunk of
// someone's page, so the nesting cases below are the important ones.

const text = (value: string) => ({ type: "text", text: value })
const para = (...values: string[]) => ({ type: "paragraph", content: values.map(text) })
const doc = (...content: any[]) => ({ type: "doc", content })
const newBlock = { type: "paragraph", content: [text("NEW")] }
const macroKeyOf = (node: any) => node?.attrs?.parameters?.guestParams?.reqKey

describe("blockText", () => {
  it("concatenates the text of a whole subtree", () => {
    expect(blockText(para("Hello ", "world"))).toBe("Hello world")
    expect(blockText(doc(para("A"), { type: "panel", content: [para("B")] }))).toBe("AB")
  })

  it("returns an empty string for a node carrying no text", () => {
    expect(blockText({ type: "rule" })).toBe("")
  })
})

describe("anchoredInject", () => {
  it("replaces the anchor text with a macro and keeps what surrounds it", () => {
    const state = { done: false }
    const result: any = anchoredInject(doc(para("F-01 must log in.")), "F-01", "F-01", state)
    expect(state.done).toBe(true)
    const [macro, rest] = result.content[0].content
    expect(macroKeyOf(macro)).toBe("F-01")
    expect(rest).toEqual(text(" must log in."))
  })

  it("keeps the text before the anchor", () => {
    const result: any = anchoredInject(doc(para("See F-01 for details")), "F-01", "F-01", { done: false })
    const [before, macro, after] = result.content[0].content
    expect(before).toEqual(text("See "))
    expect(macroKeyOf(macro)).toBe("F-01")
    expect(after).toEqual(text(" for details"))
  })

  it("preserves the marks of the text it splits", () => {
    const bold = { type: "paragraph", content: [{ type: "text", text: "F-01 rules", marks: [{ type: "strong" }] }] }
    const result: any = anchoredInject(doc(bold), "F-01", "F-01", { done: false })
    expect(result.content[0].content[1].marks).toEqual([{ type: "strong" }])
  })

  it("works inside a heading too (a valid RY context)", () => {
    const heading = { type: "heading", attrs: { level: 2 }, content: [text("F-01")] }
    const result: any = anchoredInject(doc(heading), "F-01", "F-01", { done: false })
    expect(macroKeyOf(result.content[0].content[0])).toBe("F-01")
    expect(result.content[0].attrs).toEqual({ level: 2 })
  })

  it("injects into the first matching block only — a key is indexed once", () => {
    const result: any = anchoredInject(doc(para("F-01 here"), para("F-01 again")), "F-01", "F-01", { done: false })
    expect(macroKeyOf(result.content[0].content[0])).toBe("F-01")
    expect(result.content[1]).toEqual(para("F-01 again"))
  })

  it("reaches a paragraph nested in a panel", () => {
    const state = { done: false }
    const result: any = anchoredInject(doc({ type: "panel", content: [para("F-01 x")] }), "F-01", "F-01", state)
    expect(state.done).toBe(true)
    expect(result.content[0].type).toBe("panel")
    expect(macroKeyOf(result.content[0].content[0].content[0])).toBe("F-01")
  })

  it("leaves the document untouched when the anchor is absent", () => {
    const original = doc(para("nothing here"))
    const state = { done: false }
    expect(anchoredInject(original, "F-01", "MISSING", state)).toEqual(original)
    expect(state.done).toBe(false)
  })
})

describe("applyReplace", () => {
  it("swaps the matched block for the new one, in place", () => {
    const state = { done: false }
    const result: any = applyReplace(doc(para("keep"), para("drop me"), para("keep2")), ["drop me"], [newBlock], state)
    expect(state.done).toBe(true)
    expect(result.content.map(blockText)).toEqual(["keep", "NEW", "keep2"])
  })

  it("removes every matched block but splices the result at the first one", () => {
    const result: any = applyReplace(
      doc(para("first"), para("middle"), para("second")),
      ["first", "second"],
      [newBlock],
      { done: false }
    )
    expect(result.content.map(blockText)).toEqual(["NEW", "middle"])
  })

  it("splices at the DEEPEST container — a wrapping panel is never replaced wholesale", () => {
    const page = doc(para("intro"), { type: "panel", attrs: { panelType: "info" }, content: [para("drop me"), para("keep")] })
    const result: any = applyReplace(page, ["drop me"], [newBlock], { done: false })
    expect(result.content[0]).toEqual(para("intro"))
    expect(result.content[1].type).toBe("panel")
    expect(result.content[1].attrs).toEqual({ panelType: "info" })
    expect(result.content[1].content.map(blockText)).toEqual(["NEW", "keep"])
  })

  it("stops after the first splice so a later identical block survives", () => {
    const result: any = applyReplace(
      doc({ type: "panel", content: [para("dup")] }, para("dup")),
      ["dup"],
      [newBlock],
      { done: false }
    )
    expect(result.content[0].content.map(blockText)).toEqual(["NEW"])
    expect(result.content[1]).toEqual(para("dup"))
  })

  it("can splice several blocks at once (a table plus its intro, say)", () => {
    const second = { type: "paragraph", content: [text("NEW2")] }
    const result: any = applyReplace(doc(para("drop")), ["drop"], [newBlock, second], { done: false })
    expect(result.content.map(blockText)).toEqual(["NEW", "NEW2"])
  })

  it("leaves the document untouched when no anchor matches", () => {
    const original = doc(para("a"), para("b"))
    const state = { done: false }
    expect(applyReplace(original, ["missing"], [newBlock], state)).toEqual(original)
    expect(state.done).toBe(false)
  })
})

describe("applyInsertAfter", () => {
  it("inserts right after the matched block", () => {
    const state = { done: false }
    const result: any = applyInsertAfter(doc(para("a"), para("b")), "a", [newBlock], state)
    expect(state.done).toBe(true)
    expect(result.content.map(blockText)).toEqual(["a", "NEW", "b"])
  })

  it("inserts inside the deepest container holding the anchor", () => {
    const page = doc({ type: "panel", content: [para("a")] }, para("tail"))
    const result: any = applyInsertAfter(page, "a", [newBlock], { done: false })
    expect(result.content[0].content.map(blockText)).toEqual(["a", "NEW"])
    expect(result.content[1]).toEqual(para("tail"))
  })

  it("inserts only once", () => {
    const result: any = applyInsertAfter(doc(para("a"), para("a")), "a", [newBlock], { done: false })
    expect(result.content.map(blockText)).toEqual(["a", "NEW", "a"])
  })

  it("leaves the document untouched when the anchor is absent", () => {
    const original = doc(para("a"))
    const state = { done: false }
    expect(applyInsertAfter(original, "missing", [newBlock], state)).toEqual(original)
    expect(state.done).toBe(false)
  })
})
