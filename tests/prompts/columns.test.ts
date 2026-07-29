import { describe, it, expect } from "vitest"
import { columnMeaning } from "../../src/prompts/descriptions.js"
import { toolDescription } from "../../src/prompts/descriptions.js"
import { STEP_TYPES } from "../../src/api/traceabilityDto.js"
import { TOOL_NAMES } from "../../src/tools/toolNames.js"

// src/prompts/matrix_columns.md is what turns an enum name into something a model can act on. The failure it
// exists to prevent is real and was observed: asked to "add the pages where the requirements are
// written", the model answered that it could not — while ORIGINAL_LINKS sat in the suggestions.
//
// Completeness against StepType is already a COMPILE error (see descriptions.ts). What is worth
// testing is that the glossary says something usable, and that it reaches the model.

describe("the column glossary", () => {
  it("explains every step type, with real prose", () => {
    for (const type of STEP_TYPES) {
      const meaning = columnMeaning(type)
      expect(meaning, type).toBeTruthy()
      // Long enough to be an explanation rather than a restated name.
      expect(meaning.length, type).toBeGreaterThan(40)
      expect(meaning, type).not.toBe(type)
    }
  })

  it("answers the question that made the model give up: where is a requirement written", () => {
    expect(columnMeaning("ORIGINAL_LINKS")).toMatch(/page/i)
    expect(columnMeaning("ORIGINAL_LINKS")).toMatch(/written|source document/i)
    // And it distinguishes the neighbouring column, so the two are not used interchangeably.
    expect(columnMeaning("LINKS")).toMatch(/referenced|reused/i)
  })

  it("keeps the FROM/TO warning in the glossary too", () => {
    // The inversion is the one trap a model can hit while reading the glossary alone, without the
    // workflow fragment in front of it.
    expect(columnMeaning("TO")).toMatch(/never swap|discover_matrix_columns tells you/i)
    expect(columnMeaning("FROM")).toMatch(/never the one whose name sounds right|discover_matrix_columns/i)
  })

  it("reaches the model through the discovery tool description", () => {
    // Included there so the capability is known BEFORE any call — a model that thinks a column type
    // does not exist never calls discovery to find out.
    const description = toolDescription(TOOL_NAMES.discoverMatrixColumns)
    expect(description).toContain("## ORIGINAL_LINKS")
    expect(description).toContain("the page / document where the requirement is written")
    // The maintainer-facing header of columns.md is an HTML comment and must not leak into it.
    expect(description).not.toContain("load-bearing")
  })
})
