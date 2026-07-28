// Dev-only tracing, shared by the HTTP client and the tool registry.
//
// CRITICAL: a stdio MCP server reserves STDOUT for the JSON-RPC stream, so logs MUST go to STDERR
// (console.error) or they corrupt the protocol. Gated on RY_ENV=dev (baked at build time), so the
// prod bundle is silent and pays nothing.
//
// Secrets are NEVER logged: no Authorization / X-Api-Key header, no token, no tool arguments (a
// requirements tree or an ADF page can carry customer content). What is logged is the shape of the
// call — which tool/endpoint, how long, and how it ended — which is what you actually need when
// debugging a session.

import { isDevEnv } from "./env.js"

export function logDev(...parts: unknown[]): void {
  if (isDevEnv()) console.error("[ry-dev]", ...parts)
}
