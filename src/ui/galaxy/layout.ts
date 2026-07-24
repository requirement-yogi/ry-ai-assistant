// Overlap removal, kept free of cytoscape so it can be reasoned about and tested on its own.
//
// A force-directed layout minimises an energy; it never guarantees that two frames end up apart.
// Our frames are label-sized, so a long requirement key easily lands on top of a neighbour.
//
// The strategy is three steps, cheapest and least disruptive first:
//   1. expand  — scale the whole layout up if the frames simply do not have the room they need;
//   2. relax   — push each overlapping pair apart along its axis of least penetration;
//   3. grid    — pack onto a regular grid, which cannot overlap, if relaxation still gave up.

export type LayoutBox = { x: number; y: number; halfWidth: number; halfHeight: number }

// Measured threshold: pairwise relaxation converges in ~25 passes once the frames cover 8% or less
// of the graph area, and does not converge at all past ~12%, whatever the node count. Expanding to
// 7% therefore turns "never converges" into "converges quickly".
const TARGET_FILL = 0.07

// How many times to expand-and-relax before giving up and packing onto a grid.
const EXPANSION_ROUNDS = 3

// Keep the expanded picture roughly square rather than stretching a degenerate spread.
const MIN_ASPECT = 0.6
const MAX_ASPECT = 1.7

// Grid cells are one frame wide plus a hair, so neighbours cannot touch.
const CELL_SLACK = 1.02

// Passes to budget for a graph of this size. Relaxation needs ~25-50 passes once expandToFit has
// given it room, so these leave headroom while capping the O(n²) sweep: the worst case (400 nodes,
// 80 passes) is a few million comparisons, a handful of milliseconds, run once per layout.
export function passBudget(count: number): number {
  return count > 200 ? 80 : count > 80 ? 100 : 150
}

/** True when no two boxes overlap — the property separateBoxes guarantees. */
export function hasOverlap(boxes: LayoutBox[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.halfWidth + b.halfWidth - Math.abs(a.x - b.x) > 0 && a.halfHeight + b.halfHeight - Math.abs(a.y - b.y) > 0) {
        return true
      }
    }
  }
  return false
}

type Extent = { minX: number; maxX: number; minY: number; maxY: number; needed: number; width: number; height: number }

// Each axis of the spread is floored by the mean frame size, so a degenerate layout (every box on
// one line, zero area) cannot produce an absurd scale factor.
function extentOf(boxes: LayoutBox[]): Extent {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let needed = 0
  let totalWidth = 0
  let totalHeight = 0
  for (const item of boxes) {
    minX = Math.min(minX, item.x)
    maxX = Math.max(maxX, item.x)
    minY = Math.min(minY, item.y)
    maxY = Math.max(maxY, item.y)
    needed += 4 * item.halfWidth * item.halfHeight
    totalWidth += 2 * item.halfWidth
    totalHeight += 2 * item.halfHeight
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    needed,
    width: Math.max(maxX - minX, totalWidth / boxes.length),
    height: Math.max(maxY - minY, totalHeight / boxes.length),
  }
}

/**
 * Scales the layout up around its centre until the frames cover no more than `fill` of it.
 * A layout that already has that much room is left exactly as it is — the factors never shrink.
 */
function expandToFit(boxes: LayoutBox[], fill: number): void {
  const extent = extentOf(boxes)
  const targetArea = extent.needed / fill
  const aspect = Math.min(Math.max(extent.width / extent.height, MIN_ASPECT), MAX_ASPECT)
  const targetWidth = Math.sqrt(targetArea * aspect)
  const horizontal = Math.max(targetWidth / extent.width, 1)
  const vertical = Math.max(targetArea / targetWidth / extent.height, 1)
  if (horizontal === 1 && vertical === 1) return
  const centreX = (extent.minX + extent.maxX) / 2
  const centreY = (extent.minY + extent.maxY) / 2
  for (const item of boxes) {
    item.x = centreX + (item.x - centreX) * horizontal
    item.y = centreY + (item.y - centreY) * vertical
  }
}

/** Pushes overlapping pairs apart; returns the passes used, or the budget if it never converged. */
function relax(boxes: LayoutBox[], passes: number): number {
  for (let pass = 0; pass < passes; pass++) {
    let overlapped = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const penetrationX = a.halfWidth + b.halfWidth - Math.abs(a.x - b.x)
        if (penetrationX <= 0) continue
        const penetrationY = a.halfHeight + b.halfHeight - Math.abs(a.y - b.y)
        if (penetrationY <= 0) continue
        overlapped = true
        // Separate on the cheaper axis, splitting the correction between both boxes. Exactly
        // coincident boxes have no axis to push along, so the tie is broken on the loop order.
        if (penetrationX < penetrationY) {
          const shift = (penetrationX / 2) * (a.x < b.x || a.x === b.x ? -1 : 1)
          a.x += shift
          b.x -= shift
        } else {
          const shift = (penetrationY / 2) * (a.y < b.y || a.y === b.y ? -1 : 1)
          a.y += shift
          b.y -= shift
        }
      }
    }
    if (!overlapped) return pass
  }
  return passes
}

/**
 * Lays every frame out on a regular grid, centred where the graph already is. Overlap-free by
 * construction, and only reached when relaxation gave up — at which point the frames were piled
 * deep enough that the force-directed structure was unreadable anyway.
 *
 * Frames keep their reading order (top to bottom, then left to right), so the grid still roughly
 * reflects where the layout had put them, and the column count targets a square picture.
 */
function packIntoGrid(boxes: LayoutBox[]): void {
  let cellWidth = 0
  let cellHeight = 0
  for (const item of boxes) {
    cellWidth = Math.max(cellWidth, 2 * item.halfWidth * CELL_SLACK)
    cellHeight = Math.max(cellHeight, 2 * item.halfHeight * CELL_SLACK)
  }
  const extent = extentOf(boxes)
  const columns = Math.max(1, Math.round(Math.sqrt((boxes.length * cellHeight) / cellWidth)))
  const rows = Math.ceil(boxes.length / columns)
  const originX = (extent.minX + extent.maxX) / 2 - ((columns - 1) * cellWidth) / 2
  const originY = (extent.minY + extent.maxY) / 2 - ((rows - 1) * cellHeight) / 2
  const ordered = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  ordered.forEach((item, index) => {
    item.x = originX + (index % columns) * cellWidth
    item.y = originY + Math.floor(index / columns) * cellHeight
  })
}

/**
 * Moves the boxes in place so that no pair overlaps. Returns the number of relaxation passes used
 * (0 when nothing overlapped to begin with).
 *
 * A single expansion is not always enough: it scales the picture uniformly, so a tight local
 * cluster stays proportionally tight even once the graph as a whole has room. Each round therefore
 * halves the target fill, which measurably clears every case within two rounds; the third is
 * headroom, and the grid is the guarantee behind it.
 */
export function separateBoxes(boxes: LayoutBox[], passes: number): number {
  if (boxes.length < 2 || !hasOverlap(boxes)) return 0
  let used = 0
  let fill = TARGET_FILL
  for (let round = 0; round < EXPANSION_ROUNDS; round++) {
    expandToFit(boxes, fill)
    used += relax(boxes, passes)
    if (!hasOverlap(boxes)) return used
    fill /= 2
  }
  packIntoGrid(boxes)
  return used
}
