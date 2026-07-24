// Update check: compares the running server's version against the latest GitHub release of
// requirement-yogi/ry-ai-assistant. Unlike ryClient.ts (the Requirement Yogi APIs), this talks to
// the public GitHub REST API — no auth, no residency. It is best-effort: any failure (offline,
// rate-limited, no release yet) yields a "couldn't check" result instead of throwing, so the
// update check never disrupts a session.

const LATEST_RELEASE_URL = "https://api.github.com/repos/requirement-yogi/ry-ai-assistant/releases/latest"

// GitHub requires a User-Agent on every request and rejects requests without one.
const USER_AGENT = "ry-ai-assistant-update-check"

// Don't let a slow/unreachable GitHub hang the tool call.
const REQUEST_TIMEOUT_MS = 4000

// The release page body can be long; keep the notes surfaced to the model bounded.
const MAX_NOTES_CHARS = 4000

export type UpdateCheck = {
  current_version: string
  // The following are absent when the check couldn't complete (see `checked`).
  latest_version?: string
  update_available?: boolean
  release_name?: string
  release_url?: string
  published_at?: string
  release_notes?: string
  // false when GitHub couldn't be reached / has no release yet; `note` explains why.
  checked: boolean
  note?: string
}

type GithubRelease = {
  tag_name?: string
  name?: string
  html_url?: string
  body?: string
  published_at?: string
}

// Parse "1.2.3", "v1.2.3", "1.2.3-beta.1" into { core: [major, minor, patch], prerelease }.
// Returns null for anything unparseable (so we degrade gracefully rather than mis-compare).
export function parseSemver(raw: string): { core: [number, number, number]; prerelease: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

// Compare two prerelease identifier lists per semver §11: numeric < alphanumeric, field-by-field,
// and a shorter prefix loses only when all its fields are equal.
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

// Returns -1 if a < b, 0 if equal, 1 if a > b. Unparseable versions compare as equal (0), which
// makes the caller treat them as "no known update" rather than crying wolf.
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1
  }
  // Equal core: a version WITHOUT a prerelease outranks one WITH (1.0.0 > 1.0.0-beta).
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

// Shape a raw GitHub release + the current version into an UpdateCheck. Pure (no I/O) so it's
// unit-testable; fetchLatestRelease handles the network side.
export function buildUpdateCheck(currentVersion: string, release: GithubRelease): UpdateCheck {
  const latest = (release.tag_name ?? "").trim()
  if (!latest) {
    return { current_version: currentVersion, checked: false, note: "The latest GitHub release has no tag." }
  }
  const updateAvailable = compareSemver(currentVersion, latest) < 0
  const notes = (release.body ?? "").trim()
  return {
    current_version: currentVersion,
    latest_version: latest,
    update_available: updateAvailable,
    release_name: release.name?.trim() || undefined,
    release_url: release.html_url?.trim() || undefined,
    published_at: release.published_at?.trim() || undefined,
    release_notes: notes ? (notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}\n…(truncated)` : notes) : undefined,
    checked: true,
  }
}

// GET the latest release from GitHub and compare it to the current version. Never throws: any
// error becomes a { checked: false } result carrying a human-readable note.
export async function fetchLatestRelease(currentVersion: string): Promise<UpdateCheck> {
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) {
      return { current_version: currentVersion, checked: false, note: "No published release found on GitHub yet." }
    }
    if (!response.ok) {
      const detail = response.status === 403 ? " (GitHub API rate limit — try again later)" : ""
      return {
        current_version: currentVersion,
        checked: false,
        note: `GitHub returned ${response.status} ${response.statusText}${detail}.`,
      }
    }
    const release = (await response.json()) as GithubRelease
    return buildUpdateCheck(currentVersion, release)
  } catch (error) {
    return {
      current_version: currentVersion,
      checked: false,
      note: `Could not reach GitHub to check for updates: ${(error as Error).message}`,
    }
  }
}
