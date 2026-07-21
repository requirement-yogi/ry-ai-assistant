// Session-level update check state, shared by the check_for_updates tool (on-demand) and the
// automatic once-per-session banner injected through withTelemetry (src/tools/telemetry.ts).
//
// Why a standalone module: telemetry.ts needs the banner and updates.ts needs the full summary,
// but updates.ts already imports telemetry.ts (registerTool) — putting the state in either would
// create an import cycle. This module imports neither, so both can depend on it cleanly.
//
// The GitHub round-trip runs ONCE per process (≈ once per session for a stdio server) and its
// result is cached. The banner is surfaced at most once, and only when an update is actually
// available — so it costs nothing on every subsequent tool call.

import { fetchLatestRelease, type UpdateCheck } from "./api/githubReleases.js"
import { VERSION } from "./version.generated.js"

let checkPromise: Promise<UpdateCheck> | undefined
let resolved: UpdateCheck | undefined
let noticeConsumed = false

// Start the check as early as possible (called at server startup in index.ts) so its result is
// ready by the time the user triggers their first tool. Idempotent: the promise is created once.
export function startUpdateCheck(): Promise<UpdateCheck> {
  if (!checkPromise) {
    checkPromise = fetchLatestRelease(VERSION)
    // Mirror the resolved value into a plain variable so takeReadyUpdateNotice can read it
    // synchronously (no await → zero latency added to the tool call).
    void checkPromise.then((check) => {
      resolved = check
    })
  }
  return checkPromise
}

// Awaited result — used by the on-demand check_for_updates tool.
export function getUpdateCheck(): Promise<UpdateCheck> {
  return startUpdateCheck()
}

// One-shot, NON-blocking banner for the automatic path. Returns the notice the first time it's
// called AFTER the check has resolved AND an update is available; undefined otherwise (not ready
// yet → try again on the next tool call; up to date / failed / already shown → stay silent). It
// never awaits, so it adds no latency to the tool call it piggy-backs on.
export function takeReadyUpdateNotice(): string | undefined {
  if (noticeConsumed || !resolved) return undefined
  noticeConsumed = true // consume even when up to date, so we check at most once per session
  return resolved.checked && resolved.update_available ? formatUpdateBanner(resolved) : undefined
}

// Concise, clearly-delimited system notice prepended to the first tool result. Only ever built
// when an update is available.
export function formatUpdateBanner(check: UpdateCheck): string {
  const lines = [
    `[Requirement Yogi AI Assistant — update available]`,
    `You are running version ${check.current_version}; the latest release is ${check.latest_version}${
      check.release_name ? ` ("${check.release_name}")` : ""
    }.`,
    `Briefly tell the user an update is available and summarize what's new from the notes below, then continue with their request. To update: download the latest .mcpb (Claude Desktop) or reinstall from the release page${
      check.release_url ? ` (${check.release_url})` : ""
    }.`,
  ]
  if (check.release_notes) lines.push(`What's new:\n${check.release_notes}`)
  return lines.join("\n")
}

// Full summary for the explicit check_for_updates tool (covers up-to-date and failed cases too).
export function formatUpdateSummary(check: UpdateCheck): string {
  if (!check.checked) {
    return `Could not check for updates (running version ${check.current_version}).${
      check.note ? ` ${check.note}` : ""
    } No action needed — this does not affect the tools.`
  }
  if (!check.update_available) {
    return `The Requirement Yogi AI Assistant MCP is up to date (version ${check.current_version}, latest release ${check.latest_version}). No need to mention this to the user unless they ask.`
  }
  return formatUpdateBanner(check)
}
