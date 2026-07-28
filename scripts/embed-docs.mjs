// Build-time codegen: embeds the tool descriptions (src/prompts/**/*.md) into a TypeScript module
// so they can be imported by both build paths — `tsc` → dist/ and the esbuild self-contained
// bundle — from a SINGLE source of truth.
//
// Why prompts live in markdown rather than in the tool files: a tool description IS prompt
// content, not code. Keeping it in .md means tuning what the model reads never touches a file
// that holds logic, and the shared fragments (the Jira workflow, the indexing rules, the RQL
// reference) are written once and included where needed instead of being copy-pasted.
//
// Why codegen rather than a runtime readFileSync: the esbuild bundle must stay a self-contained
// single .mjs (no sibling files to ship), and `tsc` cannot import a .md file. Embedding the text
// at build time satisfies both. The generated file is git-ignored (see .gitignore).
//
// The same mechanism bakes package.json's version into src/version.generated.ts so the running
// server knows its own version (for the update check) without reading package.json at runtime —
// which the self-contained .mjs bundle can't do. package.json stays the single source of truth
// for the version (already synced to mcpb/manifest.json by scripts/build-mcpb.mjs).

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, resolve, relative, basename } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// One .md per MCP tool; the file's basename IS the tool name (checked against TOOL_NAMES at
// compile time by src/prompts/descriptions.ts).
const TOOLS_DIR = resolve(root, "src/prompts/tools")
const PROMPTS_OUT = resolve(root, "src/prompts/index.generated.ts")

const INCLUDE_PATTERN = /^[ \t]*\{\{include:\s*([^}\s]+)\s*\}\}[ \t]*$/gm
const MAX_INCLUDE_DEPTH = 10

// Resolves `{{include:relative/path.md}}` directives against the INCLUDING file's directory, so a
// fragment can itself include another one (e.g. the RQL preamble includes the authoritative
// grammar reference in src/docs/). `stack` guards against include cycles.
function renderPrompt(file, stack = []) {
  if (stack.includes(file)) {
    throw new Error(`Include cycle detected: ${[...stack, file].map((f) => relative(root, f)).join(" → ")}`)
  }
  if (stack.length > MAX_INCLUDE_DEPTH) {
    throw new Error(`Include nesting deeper than ${MAX_INCLUDE_DEPTH} at ${relative(root, file)}`)
  }

  let content
  try {
    content = readFileSync(file, "utf8")
  } catch {
    const from = stack.length ? ` (included from ${relative(root, stack[stack.length - 1])})` : ""
    throw new Error(`Prompt file not found: ${relative(root, file)}${from}`)
  }

  return content.replace(INCLUDE_PATTERN, (_match, includePath) =>
    renderPrompt(resolve(dirname(file), includePath), [...stack, file])
  )
}

// Maintainer-facing HTML comments (e.g. "do NOT reintroduce excel/isModified…") are noise for the
// model — strip them from the final prompt, keep everything else verbatim.
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "")
}

// Collapse the blank-line runs an include can leave behind (a fragment ends with a newline and the
// directive line sat on its own), so the model never sees ragged spacing.
function tidy(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim()
}

const toolFiles = readdirSync(TOOLS_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort()

if (toolFiles.length === 0) {
  throw new Error(`No tool prompts found in ${relative(root, TOOLS_DIR)}`)
}

const entries = toolFiles.map((name) => {
  const toolName = basename(name, ".md")
  const rendered = tidy(stripComments(renderPrompt(resolve(TOOLS_DIR, name))))
  if (!rendered) throw new Error(`Prompt for tool "${toolName}" is empty`)
  return [toolName, rendered]
})

const promptsBanner =
  `// AUTO-GENERATED from src/prompts/**/*.md by scripts/embed-docs.mjs — DO NOT EDIT.\n` +
  `// Edit the markdown sources and re-run \`npm run generate:docs\` (or any build).\n`
const promptsBody = entries.map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`).join("\n")
writeFileSync(PROMPTS_OUT, `${promptsBanner}export const TOOL_DESCRIPTIONS = {\n${promptsBody}\n} as const\n`)
console.log(
  `embed-docs: ${entries.length} tool prompt(s) → src/prompts/index.generated.ts ` +
    `(${entries.reduce((total, [, text]) => total + text.length, 0)} chars)`
)

// Bake the version from package.json so the server can report it at runtime in both builds.
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version
const versionOut = resolve(root, "src/version.generated.ts")
const versionBanner =
  `// AUTO-GENERATED from package.json by scripts/embed-docs.mjs — DO NOT EDIT.\n` +
  `// Bump the version in package.json and re-run \`npm run generate:docs\` (or any build).\n`
writeFileSync(versionOut, `${versionBanner}export const VERSION = ${JSON.stringify(version)}\n`)
console.log(`embed-docs: package.json version → src/version.generated.ts (${version})`)
