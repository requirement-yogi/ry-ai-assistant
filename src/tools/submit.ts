const EXTENSION_TYPE = "com.atlassian.ecosystem"
const EXTENSION_KEY =
  "2237ccc1-3339-4360-9e41-d8b594746224/d761c812-7ec0-41d2-a760-254783345820/static/requirement-yogi"
const EXTENSION_ID =
  "ari:cloud:ecosystem::extension/2237ccc1-3339-4360-9e41-d8b594746224/d761c812-7ec0-41d2-a760-254783345820/static/requirement-yogi"

export function buildInlineExtension(reqKey: string) {
  return {
    type: "inlineExtension",
    attrs: {
      extensionType: EXTENSION_TYPE,
      extensionKey: EXTENSION_KEY,
      parameters: {
        guestParams: { reqKey },
        extensionId: EXTENSION_ID,
        render: "native",
        extensionTitle: "Requirement Yogi definition",
      },
    },
  }
}
