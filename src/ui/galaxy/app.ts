import cytoscape from "cytoscape"
import { App } from "@modelcontextprotocol/ext-apps"
import type { GalaxyPayload } from "./model.js"
import { passBudget, separateBoxes } from "./layout.js"
import "./styles.css"

const TOOL_NAME = "explore_requirement_galaxy"
// #739CEB is the requirement colour used by the Requirement Yogi application; keep the graph on it.
const NODE_COLOURS: Record<string, string> = { requirement: "#739CEB", page: "#5BC8A8", jira: "#FFB86C" }
const root = document.querySelector<HTMLDivElement>("#app")!
let galaxy: GalaxyPayload | undefined
let cy: cytoscape.Core | undefined
// The host announces the arguments before the tool runs; keeping them lets the retry button
// re-issue the very same call from the app instead of asking the user to re-prompt.
let toolArguments: Record<string, unknown> | undefined

type ResultBlock = { type: string; text?: string; _meta?: Record<string, unknown> }
type ToolResult = { content?: ResultBlock[]; structuredContent?: unknown; isError?: boolean; _meta?: Record<string, unknown> }

function message(title: string, body: string, extra = "") {
  root.innerHTML = `<aside id="detail" style="grid-column: 1 / -1; border: 0; display: grid; place-content: center; text-align: center"><div><div class="eyebrow">Requirement Galaxy</div><h1>${title}</h1><p class="muted">${body}</p>${extra}</div></aside>`
}

function showLoading() {
  message("Waiting for Requirement Yogi data…", "The graph will appear here as soon as the tool result is delivered to the iframe.")
}

function block(content: string): string {
  return `<pre style="max-width:620px;white-space:pre-wrap;text-align:left;padding:12px;background:#11182d;border:1px solid #293453;border-radius:8px;color:#b8c5e8;font-size:11px">${escapeHtml(content)}</pre>`
}

function retryButton(): string {
  return toolArguments ? `<div class="row" style="justify-content:center"><button id="retry">Retry</button></div>` : ""
}

// Calling the tool ourselves returns the raw CallToolResult. The tool-result notification does
// not: hosts are free to hand the app the same normalized rendition they give the model, which
// (on Claude Desktop) drops structuredContent and every _meta and appends a "rendered a widget"
// block — so the graph payload can never survive that path there.
function fetchFromServer() {
  showLoading()
  void app
    .callServerTool({ name: TOOL_NAME, arguments: toolArguments })
    .then((result) => handleResult(result as ToolResult, false))
    .catch((error: unknown) => showFailure(`Could not reach the Requirement Yogi MCP server.\n\n${error instanceof Error ? error.message : String(error)}`))
}

function bindRetry() {
  document.querySelector("#retry")?.addEventListener("click", fetchFromServer)
}

// The tool reports Requirement Yogi failures as an error result whose text carries the actionable
// message (bad RQL, ambiguous instance, expired token…). Showing that text is the whole point:
// without it the app looks like a delivery problem when the server actually told us what was wrong.
function showFailure(details: string) {
  message("Requirement Yogi could not build the graph", "The tool call failed. The server reported:", `${block(details)}${retryButton()}`)
  bindRetry()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!)
}

function detail(nodeId?: string) {
  const node = galaxy?.nodes.find((item) => item.id === nodeId)
  const panel = document.querySelector<HTMLDivElement>("#detail")!
  if (!node) {
    const notes = (galaxy?.notes ?? []).map((note) => `<div class="property">${escapeHtml(note)}</div>`).join("")
    panel.innerHTML = `<div class="eyebrow">Requirement Galaxy</div><h1>Explore the graph</h1><p>Click a requirement or Jira issue to inspect it. Drag the canvas, scroll to zoom, or use the buttons below.</p><div class="row"><span class="badge">${galaxy?.nodes.length ?? 0} nodes</span><span class="badge">${galaxy?.edges.length ?? 0} connections</span></div><div class="row"><button id="fit">Fit graph</button><button id="center" class="secondary">Center focus</button><button id="relayout" class="secondary">Re-arrange</button></div>${notes}`
    document.querySelector("#fit")?.addEventListener("click", () => cy?.fit(undefined, 36))
    // The layout starts from a random seed, so a second run is a cheap way out of a cramped result.
    document.querySelector("#relayout")?.addEventListener("click", () => cy && runLayout(cy))
    document.querySelector("#center")?.addEventListener("click", () => {
      const focus = cy?.getElementById(galaxy?.focusNodeId ?? "")
      if (focus?.length) cy?.fit(focus, 90)
    })
    return
  }
  const properties = Object.entries(node.properties ?? {}).map(([name, value]) => `<div class="property"><b>${escapeHtml(name)}</b>${escapeHtml(value)}</div>`).join("")
  const url = node.confluenceUrl ?? node.jiraUrl
  panel.innerHTML = `<div class="eyebrow">${node.type === "jira" ? "Jira issue" : "Requirement"}</div><h1>${escapeHtml(node.key ?? node.label)}</h1>${node.text ? `<p>${escapeHtml(node.text)}</p>` : ""}<div class="row">${node.status ? `<span class="badge status">${escapeHtml(node.status)}</span>` : ""}<span class="badge">${escapeHtml(node.rawId?.toString() ?? node.id)}</span></div>${properties}${url ? `<div class="row"><button id="open">Open source</button><button id="ask" class="secondary">Use in chat</button></div>` : `<div class="row"><button id="ask">Use in chat</button></div>`}`
  document.querySelector("#open")?.addEventListener("click", () => void app.openLink({ url: url! }))
  document.querySelector("#ask")?.addEventListener("click", () => void app.sendMessage({ role: "user", content: [{ type: "text", text: `Show me more details and adjacent requirements for ${node.key ?? node.label} (Requirement Yogi id ${node.rawId ?? node.id}).` }] }))
}

// Minimum empty space kept between two node frames, in model units.
const NODE_GAP = 28

// Node sizes are measured once — they never change, only positions move — then the pure
// separation pass in layout.ts does the work and the result is written back.
function separateNodes(cy: cytoscape.Core) {
  const nodes = cy.nodes()
  const boxes = nodes.map((node) => {
    const box = node.boundingBox()
    const position = node.position()
    return { x: position.x, y: position.y, halfWidth: box.w / 2 + NODE_GAP / 2, halfHeight: box.h / 2 + NODE_GAP / 2 }
  })
  separateBoxes(boxes, passBudget(boxes.length))
  nodes.forEach((node, index) => {
    node.position({ x: boxes[index].x, y: boxes[index].y })
  })
}

// cose spends its effort on edges; with no edge at all it just packs everything into a blob, so an
// edgeless result is laid out on a grid instead — rows never overlap by construction.
function layoutOptions(cy: cytoscape.Core): cytoscape.LayoutOptions {
  if (cy.edges().length === 0) {
    return { name: "grid", fit: true, padding: 60, avoidOverlap: true, avoidOverlapPadding: NODE_GAP, spacingFactor: 1.3, condense: false }
  }
  return {
    name: "cose",
    animate: false,
    randomize: true,
    padding: 70,
    componentSpacing: 220,
    nodeOverlap: 60,
    gravity: 20,
    numIter: 2500,
    nodeRepulsion: () => 90000,
    idealEdgeLength: () => 260,
    edgeElasticity: () => 120,
  }
}

function runLayout(cy: cytoscape.Core) {
  const layout = cy.layout(layoutOptions(cy))
  layout.one("layoutstop", () => {
    separateNodes(cy)
    cy.fit(undefined, 40)
  })
  layout.run()
}

function render(payload: GalaxyPayload) {
  galaxy = payload
  // Only legend what the graph actually contains, so an absent kind never looks like a missing node.
  const kinds: Array<[string, string]> = [["requirement", "Requirement"], ["page", "Page"], ["jira", "Jira issue"]]
  const present = new Set(payload.nodes.map((node) => node.type as string))
  const legend = kinds.filter(([type]) => present.has(type)).map(([type, title]) => `<span class="${type}">${title}</span>`).join("")
  root.innerHTML = `<div id="graph"></div><aside id="detail"></aside><div class="legend">${legend}</div>`
  cy?.destroy()
  cy = cytoscape({
    container: document.querySelector("#graph")!,
    elements: [
      ...payload.nodes.map((node) => ({ data: { id: node.id, label: node.label, type: node.type, key: node.key ?? "" } })),
      ...payload.edges.map((edge) => ({ data: { id: edge.id, source: edge.source, target: edge.target, type: edge.type, label: edge.label ?? "" } })),
    ],
    style: [
      // A node reads like a Requirement Yogi macro: the key alone, in a rounded frame tinted with
      // the type colour. width/height "label" makes the frame hug the key the way the macro does.
      {
        selector: "node",
        style: {
          shape: "round-rectangle",
          label: "data(label)",
          width: "label",
          height: "label",
          padding: "10px",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": "150px",
          "font-size": "11px",
          "font-weight": 600,
          color: "#eef3ff",
          "background-color": NODE_COLOURS.requirement,
          "background-opacity": 0.18,
          "border-width": "1.5px",
          "border-color": NODE_COLOURS.requirement,
        },
      },
      { selector: "node[type = 'page']", style: { "background-color": NODE_COLOURS.page, "border-color": NODE_COLOURS.page } },
      { selector: "node[type = 'jira']", style: { "background-color": NODE_COLOURS.jira, "border-color": NODE_COLOURS.jira } },
      { selector: "node:selected", style: { "background-opacity": 0.42, "border-width": "3px" } },
      {
        selector: "edge",
        style: {
          width: "1.4px",
          "line-color": "#5d6da6",
          "target-arrow-color": "#5d6da6",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.9,
          "curve-style": "bezier",
          label: "data(label)",
          color: "#d3ddf7",
          "font-size": "10px",
          "text-rotation": "autorotate",
          "text-background-color": "#090d1a",
          "text-background-opacity": 0.9,
          "text-background-shape": "roundrectangle",
          "text-background-padding": "3px",
        },
      },
      { selector: "edge[type = 'hierarchy']", style: { "line-color": NODE_COLOURS.page, "target-arrow-color": NODE_COLOURS.page } },
      { selector: "edge[type = 'dependency'], edge[type = 'relationship']", style: { "line-style": "dashed" } },
      { selector: "edge[type = 'jira']", style: { "line-color": NODE_COLOURS.jira, "target-arrow-color": NODE_COLOURS.jira } },
    ],
  })
  runLayout(cy)
  cy.on("tap", "node", (event) => detail(event.target.id()))
  detail(payload.focusNodeId)
}

function payloadOf(result: ToolResult): GalaxyPayload | undefined {
  const payload = result.structuredContent as GalaxyPayload | undefined
  return payload && Array.isArray(payload.nodes) && Array.isArray(payload.edges) ? payload : undefined
}

function handleResult(result: ToolResult, mayRefetch: boolean) {
  const payload = payloadOf(result)
  if (payload) {
    render(payload)
    return
  }
  if (result.isError) {
    const errorText = (result.content ?? []).filter((item) => item.text).map((item) => item.text!).join("\n\n")
    showFailure(errorText || "The tool returned an error without any message.")
    return
  }
  // The tool succeeded but its payload did not survive the host's rendition of the result. Ask the
  // server for it directly — that call is not normalized, so it carries the graph.
  if (mayRefetch && toolArguments) {
    fetchFromServer()
    return
  }
  message("The graph data was not received", "The tool succeeded but no graph payload reached the app.", retryButton())
  bindRetry()
}

const app = new App({ name: "Requirement Galaxy", version: "0.1.0" }, {})
app.addEventListener("toolinput", (params) => {
  toolArguments = params.arguments
})
app.ontoolresult = (result) => handleResult(result as ToolResult, true)
showLoading()
void app.connect()
