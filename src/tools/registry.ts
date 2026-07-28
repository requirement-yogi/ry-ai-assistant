// The single choke point every MCP tool passes through. Registering a tool here wires, in ONE
// call and from the tool name alone:
//   - the description, resolved from src/prompts/tools/<name>.md (see src/prompts/descriptions.ts);
//   - the best-effort telemetry ping (feature = the tool name);
//   - the once-per-session "update available" banner;
//   - the failure handling: a thrown error becomes an `isError` result carrying the message AND
//     the actionable guidance of its error class (see src/errors.ts);
//   - the dev trace: which tool ran, how long it took, and how it ended.
// Because the name is given once, the registered name, its telemetry `feature` and its prompt file
// can never disagree. Because failures are handled here, tool handlers contain no catch blocks:
// they do their job and throw, which is what keeps them readable.

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ZodRawShapeCompat, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js"
import type { ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { sendTelemetry } from "../api/ryClient.js"
import { takeReadyUpdateNotice } from "../updateCheck.js"
import { toolDescription } from "../prompts/descriptions.js"
import { formatToolFailure } from "../errors.js"
import { logDev } from "../log.js"
import { TOOL_NAMES, type ToolName } from "./toolNames.js"

export { TOOL_NAMES, type ToolName }

// An `isError` tool result carrying a plain explanatory message. Used for the non-exception
// failure path — input that fails validation (safeParse) or parsing (JSON.parse) returns one of
// these directly rather than throwing. Shared so the `{ content, isError }` shape isn't restated
// in every tool. (A THROWN error takes the other path: withTelemetry renders it via
// formatToolFailure, which also adds the error class's guidance.)
export function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

// MCP tool annotations, declared once so the intent is stated rather than re-derived per tool.
// Clients use them to decide what may run without asking the user, so they are worth getting right.
//
// Idempotence deserves a note, since it's usually where a tool API gets it wrong: nothing here
// needs an idempotency key. The two ADF tools are pure functions of their input, the discovery
// tools only read, and link_requirements_to_jira is idempotent server-side — the RY link service
// reports an already-existing link as `skippedCount` instead of duplicating it.

// Reads remote state through the RY (or GitHub) API. Safe to re-run.
export const READS_REMOTE_STATE = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const

// Pure computation: takes ADF in, returns ADF out. Touches nothing outside the request.
export const PURE_COMPUTATION = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const

// Creates links in Requirement Yogi. Additive and de-duplicated server-side, so re-running it
// cannot double up or destroy anything — but it does write, so a client should still confirm it.
export const CREATES_LINKS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

// Mirrors the config object of McpServer.registerTool, kept generic over InputArgs so the
// inputSchema flows straight into the handler's parsed-args type. `description` is absent on
// purpose: it is owned by the prompt file and injected from the tool name.
type ToolConfig<InputArgs extends undefined | ZodRawShapeCompat | AnySchema> = {
  title?: string
  inputSchema?: InputArgs
  outputSchema?: ZodRawShapeCompat | AnySchema
  annotations?: ToolAnnotations
  _meta?: Record<string, unknown>
  // Tool-specific advice appended to a failure, for what the generic error taxonomy can't know
  // (e.g. "call list_searchable_fields first" when an RQL query is rejected). Returning undefined
  // leaves the class guidance alone.
  errorGuidance?: (error: unknown) => string | undefined
}

export function registerTool<InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
  server: McpServer,
  name: ToolName,
  config: ToolConfig<InputArgs>,
  cb: ToolCallback<InputArgs>
) {
  const { errorGuidance, ...sdkConfig } = config
  return server.registerTool(
    name,
    { ...sdkConfig, description: toolDescription(name) },
    withTelemetry(name, cb, errorGuidance)
  )
}

// Wraps a tool callback so every invocation:
//   1. fires a best-effort telemetry ping (feature = the tool name) — NOT awaited, never throws,
//      so it adds no latency and can't break the tool;
//   2. is traced in dev with its duration and outcome (never its arguments — see src/log.ts);
//   3. turns a thrown error into an `isError` result instead of a protocol-level failure, so the
//      LLM receives the message plus its guidance and can react rather than just stop. (The SDK
//      skips outputSchema validation on `isError` results, so this stays compatible with tools
//      that declare one.)
//   4. prepends the once-per-session "update available" banner to the FIRST tool result of the
//      session (via takeReadyUpdateNotice), so the user is told about a new version WITHOUT relying
//      on the LLM calling check_for_updates. It's non-blocking (returns undefined until the startup
//      GitHub check has resolved) and one-shot, so it never fires on more than one tool call — and
//      is skipped for check_for_updates itself to avoid duplicating its own report.
export function withTelemetry<Args extends undefined | ZodRawShapeCompat | AnySchema>(
  feature: ToolName,
  cb: ToolCallback<Args>,
  errorGuidance?: (error: unknown) => string | undefined
): ToolCallback<Args> {
  return (async (...args: unknown[]) => {
    void sendTelemetry(feature)
    logDev(`▶ ${feature}`)
    const startedAt = Date.now()

    let result: CallToolResult
    try {
      result = (await (cb as (...callbackArgs: unknown[]) => unknown)(...args)) as CallToolResult
      logDev(`◀ ${feature} ${result?.isError ? "rejected" : "ok"} (${Date.now() - startedAt}ms)`)
    } catch (error) {
      logDev(`✗ ${feature} threw after ${Date.now() - startedAt}ms: ${(error as Error).message}`)
      result = toolError(formatToolFailure(feature, error, errorGuidance?.(error)))
    }

    // Surface (and thereby CONSUME) the one-shot notice only on a SUCCESSFUL result. An isError
    // result may be suppressed or truncated by the client, so spending the single banner on one
    // would waste it — leave the notice pending and let the next successful call carry it. On a
    // success we DO consume even for check_for_updates (which reports the update itself, so we skip
    // the prepend there), otherwise the next tool would re-show a banner the user was just handed.
    if (!result?.isError) {
      const notice = takeReadyUpdateNotice()
      if (notice && feature !== TOOL_NAMES.checkForUpdates && Array.isArray(result?.content)) {
        return { ...result, content: [{ type: "text", text: notice }, ...result.content] }
      }
    }
    return result
  }) as unknown as ToolCallback<Args>
}
