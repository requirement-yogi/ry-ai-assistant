const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8082"
const API_ACCESS_TOKEN = process.env.API_ACCESS_TOKEN ?? ""

// Hardcodés pour l'instant — seront fournis par l'utilisateur plus tard
const APPLICATION_ID = "1"
const SPACE_ID = "432078852"
const PARENT_ID = "432079686"

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : "Requirements"
}

export const SUBMIT_TOOL = {
  name: "submit_requirements",
  description: `Envoie le document Markdown final à l'API backend pour générer la page de spécifications.

Appelle ce tool uniquement quand l'utilisateur a confirmé qu'il est satisfait du rendu Markdown.
Passe le contenu Markdown produit par render_requirements (éventuellement retouché).`,
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

  // Logs visibles dans : ~/Library/Logs/Claude/mcp-server-prompt2requirements.log
  console.error("[submit] URL →", url)
  console.error("[submit] Token présent →", token ? `oui (${token.slice(0, 8)}...)` : "NON — vérifier API_ACCESS_TOKEN dans claude_desktop_config.json")

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
      console.error("[submit] Réponse erreur →", text)
      return { success: false, message: `Erreur ${response.status} : ${text}` }
    }

    const data = (await response.json()) as Record<string, unknown>
    return {
      success: true,
      message: `✅ Page créée avec succès.\n${JSON.stringify(data, null, 2)}`,
    }
  } catch (err) {
    console.error("[submit] Erreur réseau →", err)
    return {
      success: false,
      message: `Erreur réseau : ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
