// Builds a self-contained esbuild bundle with every environment-specific value BAKED at build
// time (esbuild `define`), so the runtime MCP config is identical for dev and prod — the only
// difference is which .mjs you point at.
//
//   node scripts/build-bundle.mjs prod   → standalone/ry-ai-assistant.mjs     (fixed values baked)
//   node scripts/build-bundle.mjs dev    → standalone/ry-ai-assistant-dev.mjs (this dev's .env.dev)
//
// Prod bakes only RY_ENV=prod; the fixed prod values live as constants in the source. Dev bakes
// RY_ENV=dev plus this developer's unique values, loaded from .env.dev (git-ignored; copy
// .env.dev.example). Only accesses written as a static process.env.<NAME> in the source get
// substituted, so BAKED_KEYS must match those reads exactly.

// esbuild-wasm (not the native "esbuild"): a WASM engine that runs identically on every platform,
// so `npm run build` works on macOS and in the Linux sandbox from one shared node_modules — no
// per-platform native binary to reinstall. Same API/`define` as native esbuild; slightly slower.
import { build } from "esbuild-wasm"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const target = process.argv[2]
if (target !== "dev" && target !== "prod") {
  console.error("Usage: node scripts/build-bundle.mjs <dev|prod>")
  process.exit(1)
}

// Minimal KEY=VALUE parser (comments with #, optional surrounding quotes). No dependency so the
// build stays dependency-light like scripts/embed-docs.mjs.
function loadEnvFile(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// The dev-only values baked from .env.dev (must match the static reads in src/). RY_ENV is always
// baked; RY_DEV_STANDALONE_URL is optional (the source falls back to the local default).
const REQUIRED_DEV_KEYS = ["RY_DEV_FORGE_ENV_ID", "RY_DEV_CONFLUENCE_URL"]
const OPTIONAL_DEV_KEYS = ["RY_DEV_STANDALONE_URL"]

const values = { RY_ENV: target }
if (target === "dev") {
  const envFile = resolve(root, ".env.dev")
  if (!existsSync(envFile)) {
    console.error("Missing .env.dev for the dev build. Copy .env.dev.example to .env.dev and fill in your values.")
    process.exit(1)
  }
  const parsed = loadEnvFile(envFile)
  const missing = REQUIRED_DEV_KEYS.filter((key) => !parsed[key]?.trim())
  if (missing.length) {
    console.error(`.env.dev is missing required value(s): ${missing.join(", ")}. See .env.dev.example.`)
    process.exit(1)
  }
  for (const key of [...REQUIRED_DEV_KEYS, ...OPTIONAL_DEV_KEYS]) {
    if (parsed[key]?.trim()) values[key] = parsed[key].trim()
  }
}

const define = {}
for (const [key, value] of Object.entries(values)) {
  define[`process.env.${key}`] = JSON.stringify(value)
}

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  define,
  outfile: resolve(root, target === "dev" ? "standalone/ry-ai-assistant-dev.mjs" : "standalone/ry-ai-assistant.mjs"),
})

console.log(`Built ${target} bundle → standalone/ry-ai-assistant${target === "dev" ? "-dev" : ""}.mjs`)
