// Build-time codegen: embeds the authoritative RQL reference (search-syntax-prompt-v3.md)
// into a TypeScript module so it can be imported by both build paths — `tsc` → dist/ and the
// esbuild self-contained bundle — from a SINGLE source of truth. The markdown file stays the
// only place the syntax is written; this regenerates on every build, so it can never drift.
//
// Why codegen rather than a runtime readFileSync: the esbuild bundle must stay a self-contained
// single .mjs (no sibling files to ship), and `tsc` cannot import a .md file. Embedding the text
// at build time satisfies both. The generated file is git-ignored (see .gitignore).

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// [source markdown, generated module, exported constant name]
const DOCS = [
  ["src/docs/search-syntax-prompt-v3.md", "src/docs/searchSyntaxReference.generated.ts", "SEARCH_SYNTAX_REFERENCE"],
]

for (const [srcRel, outRel, exportName] of DOCS) {
  const src = resolve(root, srcRel)
  const out = resolve(root, outRel)
  const content = readFileSync(src, "utf8")
  const banner =
    `// AUTO-GENERATED from ${srcRel} by scripts/embed-docs.mjs — DO NOT EDIT.\n` +
    `// Edit the markdown source and re-run \`npm run generate:docs\` (or any build).\n`
  writeFileSync(out, `${banner}export const ${exportName} = ${JSON.stringify(content)}\n`)
  console.log(`embed-docs: ${srcRel} → ${outRel} (${content.length} chars)`)
}
