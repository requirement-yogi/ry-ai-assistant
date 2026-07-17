// Build-time packaging: assemble the .mcpb one-click bundle for Claude Desktop.
//
// A .mcpb is just a zip of `manifest.json` + the server code. Because the server is already
// an esbuild single-file bundle (standalone/ry-ai-assistant.mjs, no runtime deps), the bundle
// only needs that one file — no node_modules to embed.
//
// Steps: stage manifest.json (version synced from package.json) + the prod .mjs into
// build/mcpb/, then run `mcpb pack` to produce standalone/ry-ai-assistant.mcpb.
//
// Prereq: run `npm run build:prod` first so standalone/ry-ai-assistant.mjs exists.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const bundlePath = join(root, "standalone", "ry-ai-assistant.mjs")
const manifestSrc = join(root, "mcpb", "manifest.json")
const stageDir = join(root, "build", "mcpb")
const outFile = join(root, "standalone", "ry-ai-assistant.mcpb")

if (!existsSync(bundlePath)) {
  console.error(
    `Missing ${bundlePath}.\nRun \`npm run build:prod\` first — the .mcpb wraps that bundle.`,
  )
  process.exit(1)
}

// Sync the manifest version from package.json so the two never drift.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const manifest = JSON.parse(readFileSync(manifestSrc, "utf8"))
manifest.version = pkg.version

// Fresh staging dir.
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(join(stageDir, "server"), { recursive: true })

writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
cpSync(bundlePath, join(stageDir, "server", "ry-ai-assistant.mjs"))
cpSync(join(root, "mcpb", "icon.png"), join(stageDir, "icon.png"))

// Pack. `mcpb pack <dir> <outfile>` zips the staging dir into the .mcpb.
execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stageDir, outFile], {
  stdio: "inherit",
})

console.log(`\nBuilt ${outFile}`)
