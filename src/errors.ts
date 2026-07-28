// Typed failures, so the LLM (and a human reading a trace) can tell WHAT kind of thing went wrong
// and what to do about it, instead of getting one undifferentiated `Error`.
//
// Every tool funnels through registry.ts, which turns these into a tool result carrying both the
// message and the class's `guidance` — the actionable next step. That is the whole point of the
// taxonomy: the guidance is a property of the failure kind, so it is written once here rather than
// copy-pasted into every tool's catch block.
//
// Five kinds, matching the five distinct reactions available:
//   RyConfigError     → the MCP server config is wrong; retrying can never help.
//   RyAmbiguityError  → several candidates exist; the LLM must ask the user and pass an explicit id.
//   RyConnectionError → the API host was never reached (DNS, refused, TLS, timeout).
//   RyApiError        → the API answered, with a status; the reaction depends on that status.
//   RyResponseError   → the API answered 2xx but not in the shape this MCP expects.

export abstract class RyError extends Error {
  // What the caller should DO about it — surfaced to the LLM alongside the message.
  abstract readonly guidance: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

// A required environment value is missing or invalid (token, data residency, a baked dev value).
// Not retryable: the user must fix the `env` section of their MCP config (or rebuild the dev bundle).
export class RyConfigError extends RyError {
  readonly guidance =
    "This is a configuration problem, not a transient one — retrying will not help. Tell the user what to fix in the env section of their MCP server configuration, then have them restart the client."
}

// Several organizations / Confluence instances match, and only the user can say which one to use.
export class RyAmbiguityError extends RyError {
  readonly guidance =
    "Ask the user which one to use, then call the tool again passing the explicit identifier (organization_id, application_id or base_url)."
}

// The request never reached the server (DNS, connection refused, TLS, timeout).
export class RyConnectionError extends RyError {
  constructor(
    message: string,
    readonly url: string
  ) {
    super(message)
  }

  readonly guidance =
    "The Requirement Yogi API was never reached, so nothing was changed. Check the host is correct and reachable (a VPN, proxy or locally-running server may be required), then retry."
}

// The API answered with a non-2xx status. `status` is what drives the reaction, so it is a field
// rather than something to re-extract from the message with a regex.
export class RyApiError extends RyError {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string
  ) {
    super(message)
  }

  get guidance(): string {
    if (this.status === 400) {
      // The RY API answers a malformed RQL query with 400 + "Syntax error at position N: ...".
      // The message above relays that verbatim, so the model can self-correct and resubmit.
      return "The API rejected the request as invalid. Read the error message above — it comes straight from the server — fix the input, and call the tool again."
    }
    if (this.status === 401 || this.status === 403) {
      return "Authentication or authorisation failed. Check the Requirement Yogi personal access token is valid and has access to this instance; the user may need to issue a new one."
    }
    if (this.status === 404) {
      return "The endpoint or the resource does not exist. Check the identifiers you passed came from a discovery tool (list_applications, search_requirements) rather than being guessed."
    }
    if (this.status === 429) {
      return "The API is rate-limiting these calls. Wait before retrying, and reduce how many requests the plan needs."
    }
    if (this.status >= 500) {
      return "The Requirement Yogi API failed on its side. This is usually transient — retry shortly, and tell the user if it persists."
    }
    return "The API rejected the request. Read the message above and correct the call before retrying."
  }
}

// The call succeeded but the payload doesn't match the schema in src/api/dto.ts. Almost always
// means the RY API changed and this MCP is behind — which is exactly what the update check exists
// to fix, hence the guidance.
export class RyResponseError extends RyError {
  constructor(
    message: string,
    readonly endpoint: string
  ) {
    super(message)
  }

  readonly guidance =
    "The Requirement Yogi API answered with a payload this version of the MCP doesn't recognise, so the result was not trusted. Tell the user, and suggest they run check_for_updates — a newer release may already handle it."
}

// Renders a failure as the text of an `isError` tool result: what failed, why, and what to do.
// `extraGuidance` is the tool-specific advice a generic taxonomy can't know (e.g. "call
// list_searchable_fields first"); it is appended, never replaces the class guidance.
export function formatToolFailure(toolName: string, error: unknown, extraGuidance?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const guidance = error instanceof RyError ? error.guidance : undefined
  return [`${toolName} failed: ${message}`, guidance, extraGuidance].filter(Boolean).join("\n\n")
}
