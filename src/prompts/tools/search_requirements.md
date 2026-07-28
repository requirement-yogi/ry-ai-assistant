USE THIS TOOL when the user wants to find their Requirement Yogi requirements, typically as the first step of linking them to Jira issues.

Searches the requirements through the Requirement Yogi API. Returns { total_count, returned, requirements: [...first page...] } — never a raw list. total_count is the FULL number of matches (the requirements array is just the current page): use it to judge whether the query is too broad (refine/add conditions) or too narrow (loosen it) before drilling in. Discovery is iterative — expect to run several queries. Each requirement is trimmed to the linking essentials: id, key, text, applicationId, containerId, variantId, status, canonicalURL, properties. Keep the id and the containerId/variantId: link_requirements_to_jira needs them. The response also echoes how the server understood the query (humanReadable) and any warnings (messageBean).

YOU write the query: translate the user's request into the Requirement Yogi RQL search syntax using the reference below. Results are paginated by 200: if hasNext is true, call again with offset = offset + limit.

GROUNDING: to avoid inventing field/property/relationship/variant names, call list_searchable_fields(space) FIRST whenever you are not certain which identifiers a space actually has.

SELF-CORRECTION: if the query has a syntax error the tool returns the server's RQL parse error verbatim (e.g. "Syntax error at position N: ..."). Read it, fix the query, and resubmit.

CRITICAL: the query is a structured "field operator value" expression, never a free-text search box. A bare key or word is invalid — e.g. to find requirement BREW-F-01 send key = 'BREW-F-01', NOT BREW-F-01 on its own. When no field is specified, default to `key`.

{{include:../fragments/search-syntax.md}}

{{include:../fragments/jira-workflow.md}}
