import { describe, expect, it } from "vitest"
import { hasOverlap, passBudget, separateBoxes, type LayoutBox } from "./layout.js"

const box = (x: number, y: number, halfWidth = 50, halfHeight = 16): LayoutBox => ({ x, y, halfWidth, halfHeight })

// Deterministic generator: the layouts must come out clean whatever the starting positions, and a
// failure has to be reproducible.
function scatter(count: number, width: number, height: number, seed = 7): LayoutBox[] {
  let state = seed
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
  return Array.from({ length: count }, () => box(random() * width, random() * height, 45 + random() * 40, 17))
}

describe("separateBoxes", () => {
  it("leaves a layout that already has room untouched", () => {
    const boxes = [box(0, 0), box(400, 0), box(0, 300)]
    const before = boxes.map((item) => ({ ...item }))

    expect(separateBoxes(boxes, 100)).toBe(0)
    expect(boxes).toEqual(before)
  })

  it("does nothing with fewer than two boxes", () => {
    const single = [box(5, 5)]

    expect(separateBoxes(single, 100)).toBe(0)
    expect(separateBoxes([], 100)).toBe(0)
    expect(single).toEqual([box(5, 5)])
  })

  it("separates a near-coincident pair", () => {
    const boxes = [box(0, 0), box(10, 0)]

    separateBoxes(boxes, 100)

    expect(hasOverlap(boxes)).toBe(false)
  })

  it("separates exactly coincident frames instead of deadlocking on them", () => {
    const boxes = Array.from({ length: 20 }, () => box(0, 0))

    separateBoxes(boxes, passBudget(20))

    expect(hasOverlap(boxes)).toBe(false)
  })

  it("clears a dense pile of wide frames", () => {
    const boxes = Array.from({ length: 40 }, (_, index) => box((index % 7) * 12, Math.floor(index / 7) * 9, 60, 18))
    expect(hasOverlap(boxes)).toBe(true)

    separateBoxes(boxes, passBudget(boxes.length))

    expect(hasOverlap(boxes)).toBe(false)
  })

  it("clears frames of very different sizes", () => {
    const boxes = Array.from({ length: 25 }, (_, index) => box(index * 3, index * 2, 30 + (index % 5) * 25, 14 + (index % 3) * 8))
    expect(hasOverlap(boxes)).toBe(true)

    separateBoxes(boxes, passBudget(boxes.length))

    expect(hasOverlap(boxes)).toBe(false)
  })

  it.each([21, 60, 200, 400])("clears every overlap for %i scattered frames", (count) => {
    for (let seed = 1; seed <= 5; seed++) {
      const boxes = scatter(count, count * 6, count * 4, seed)

      separateBoxes(boxes, passBudget(count))

      expect(hasOverlap(boxes)).toBe(false)
    }
  })
})

describe("passBudget", () => {
  it("scales down as the O(n²) sweep gets more expensive", () => {
    expect(passBudget(20)).toBe(150)
    expect(passBudget(120)).toBe(100)
    expect(passBudget(400)).toBe(80)
  })
})
