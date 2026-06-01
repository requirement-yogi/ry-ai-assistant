const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8082"
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN ?? ""

// Hardcoded for now — will be provided by the user in a future iteration
const APPLICATION_ID = "1"
const SPACE_ID = "432078852"
const PARENT_ID = "432079686"

/** Extracts the H1 title from a Markdown string. */
function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : "Requirements"
}

export const SUBMIT_TOOL = {
  name: "submit_requirements",
  description: `Sends the final Markdown document to the backend API to generate the specification page.

Only call this tool once the user has confirmed they are satisfied with the Markdown preview.
Pass the Markdown content produced by render_requirements (optionally enriched).`,
} as const

export async function submitMarkdown(markdown: string): Promise<{ success: boolean; message: string }> {
  const token = API_ACCESS_TOKEN
  const title = extractTitle(markdown)

  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    spaceId: SPACE_ID,
    parentId: PARENT_ID,
    title,
  })

  const url = `${API_BASE_URL}/api/confluence/pages/from-markdown?${params}`

  // Logs available at: ~/Library/Logs/Claude/mcp-server-prompt2requirements.log
  console.error("[submit] URL →", url)
  console.error("[submit] Token present →", token ? `yes (${token.slice(0, 8)}...)` : "NO — check API_ACCESS_TOKEN in claude_desktop_config.json")

  const formData = new FormData()
  const blob = new Blob([markdown], { type: "text/markdown" })
  formData.append("file", blob, "requirements.md")

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    console.error("[submit] Status →", response.status)

    if (!response.ok) {
      const text = await response.text()
      console.error("[submit] Error response →", text)
      return { success: false, message: `Error ${response.status}: ${text}` }
    }

    const data = (await response.json()) as Record<string, unknown>
    return {
      success: true,
      message: `✅ Page created successfully.\n${JSON.stringify(data, null, 2)}`,
    }
  } catch (err) {
    console.error("[submit] Network error →", err)
    return {
      success: false,
      message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
