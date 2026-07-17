// Shared environment-mode helpers.
//
// Every environment-specific value is baked into its bundle at build time via esbuild --define
// (see scripts/build-bundle.mjs, driven by build:dev / build:prod). Nothing environment-specific
// lives in the runtime MCP config, so the MCP setup is identical for dev and prod — the only
// difference is which bundle you point at.
//
//   - prod: RY_ENV="prod" and the fixed prod values are baked. (RY_DATA_RESIDENCY stays a runtime
//     choice because a single prod bundle serves both EU and US.)
//   - dev: RY_ENV="dev" and the per-developer values (Confluence dev host, Forge environment id)
//     are baked from that developer's .env.dev.
//
// IMPORTANT: esbuild --define only substitutes STATIC accesses (process.env.RY_DEV_FORGE_ENV_ID),
// never a computed process.env[name]. So every baked var must be read as a literal member
// expression at the call site and the value passed in — hence requireDevValue takes the value.

export function isDevEnv(): boolean {
  return process.env.RY_ENV?.trim().toLowerCase() === "dev"
}

// Validates a dev-only value baked into the dev bundle at build time. Pass the value from a static
// process.env.<NAME> read at the call site (see note above); this only owns the guard + message.
export function requireDevValue(name: string, value: string | undefined, description: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(
      `${name} is not set. ${description} It is baked into the dev bundle at build time — add it to .env.dev (copy .env.dev.example) and rebuild with npm run build:dev.`
    )
  }
  return trimmed
}
