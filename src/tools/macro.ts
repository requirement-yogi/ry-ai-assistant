// Shared Requirement Yogi inline macro builder — single source of truth for both
// the from-scratch builder (build_requirements_adf) and the in-place editor
// (inject_requirement_keys).

import { isDevEnv, requireDevValue } from "../env.js"

const EXTENSION_TYPE = "com.atlassian.ecosystem"

// The extension key is application_id/environment_id/static/requirement-yogi.
//   - application_id is the Forge app id: stable across environments (dev and prod are two
//     environments of the same app), so it is a plain constant.
//   - environment_id is the Forge environment id: prod is a single fixed environment (this
//     constant), but each developer has their own dev environment, so the dev build bakes it from
//     RY_DEV_FORGE_ENV_ID (that developer's .env.dev).
const APP_ID = "2237ccc1-3339-4360-9e41-d8b594746224"
const PROD_ENVIRONMENT_ID = "126ed95b-265f-4505-988f-39c68147fb29"

function environmentId(): string {
  return isDevEnv()
    ? requireDevValue(
        "RY_DEV_FORGE_ENV_ID",
        process.env.RY_DEV_FORGE_ENV_ID,
        "It is your personal Forge dev environment id (the middle UUID of the requirement-yogi extension key)."
      )
    : PROD_ENVIRONMENT_ID
}

// application_id/environment_id/static/requirement-yogi — the shared suffix of both the
// extensionKey and the extensionId ARI.
function extensionPath(): string {
  return `${APP_ID}/${environmentId()}/static/requirement-yogi`
}

export function buildInlineExtension(reqKey: string) {
  const path = extensionPath()
  return {
    type: "inlineExtension",
    attrs: {
      extensionType: EXTENSION_TYPE,
      extensionKey: path,
      parameters: {
        guestParams: { reqKey },
        extensionId: `ari:cloud:ecosystem::extension/${path}`,
        render: "native",
        extensionTitle: "Requirement Yogi definition",
      },
    },
  }
}
