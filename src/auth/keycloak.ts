interface TokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

interface CachedToken {
  value: string
  expiresAt: number // timestamp ms
}

let cached: CachedToken | null = null

async function fetchToken(): Promise<string> {
  const url = process.env.KEYCLOAK_URL
  const realm = process.env.KEYCLOAK_REALM
  const clientId = process.env.KEYCLOAK_CLIENT_ID
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET

  if (!url || !realm || !clientId || !clientSecret) {
    throw new Error(
      "Variables Keycloak manquantes : KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET"
    )
  }

  const tokenEndpoint = `${url}/realms/${realm}/protocol/openid-connect/token`

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Keycloak a répondu ${response.status} : ${text}`)
  }

  const data = (await response.json()) as TokenResponse

  // Cache avec une marge de 30s avant l'expiration réelle
  cached = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  }

  return cached.value
}

/** Retourne un access token valide. Renouvelle automatiquement si expiré. */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value
  }
  return fetchToken()
}
