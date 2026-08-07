import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { structuralProblems } from "../../shared/traceability/matrixColumns.js"
import { discoverMatrixColumns } from "../../shared/traceability/matrix.js"
import { ColumnInputSchema, MATRIX_INPUT, matrixErrorGuidance, toColumnRequests } from "../../shared/traceability/toolInputs.js"
import { registerTool, toolError, TOOL_NAMES, READS_REMOTE_STATE } from "../../core/mcp/registry.js"

// Use case 4, step 1: what can be attached to the columns picked so far. This is a LOOP, not a
// single call — one round trip per level of depth, since level N+1 is unknowable before level N
// exists. The LLM walks it by calling this tool again with the columns it kept.
export function registerDiscoverMatrixColumnsTool(server: McpServer) {
  registerTool(
    server,
    TOOL_NAMES.discoverMatrixColumns,
    {
      annotations: READS_REMOTE_STATE,
      errorGuidance: matrixErrorGuidance,
      // No outputSchema: the candidate vocabulary of a rich space (every property, every
      // relationship, every Jira field, per column) is unbounded by the data, and the spec would
      // have us serialise it into a text block as well — sending it twice for no gain. Same call as
      // search_requirements.
      inputSchema: {
        ...MATRIX_INPUT,
        columns: z
          .array(ColumnInputSchema)
          .optional()
          .describe(
            "The columns already picked, in definition order (column 0 is implicit). Leave empty on the first call; pass what you kept to discover what can be attached UNDER them"
          ),
      },
    },
    async ({ space, query, columns, variants, variable_values, base_url }) => {
      const chosen = toColumnRequests(columns ?? [])
      // Structural nonsense (a parent that doesn't exist yet) is caught without paying for a matrix
      // generation, and reads better than whatever the API would answer.
      const problems = structuralProblems(chosen)
      if (problems.length) {
        return toolError(`The columns you passed do not form a valid column tree:\n${problems.join("\n")}`)
      }

      // `chosen` is what makes this a LOOP: the probe must carry the columns already picked, or the
      // response describes column 0 again and the caller can never see one level deeper.
      const discovery = await discoverMatrixColumns(
        {
          spaceKey: space,
          query,
          variants,
          variableValues: variable_values,
          instanceBaseUrl: base_url,
        },
        chosen
      )

      return {
        content: [
          {
            type: "text",
            text: `Columns available for this matrix (derived from the requirements the query actually returns):
${JSON.stringify(discovery)}

Each entry of "columns" is one column of the matrix as it stands; its "candidates" are what you can attach UNDER it, ready to be passed back in \`columns\` (keep type, value and parent_column_index as they are).
"legend" says what each column type MEANS — use it to match the user's request to a type instead of guessing from the enum name (e.g. the page a requirement is written on is ORIGINAL_LINKS).
To go one level deeper, add the candidate you want to \`columns\` and call this tool again — the suggestions for a new column cannot exist before the column does.
Read the "notes": a false all* flag means such a column is ALREADY attached there, NOT that the data does not support it.
There is no global list of available columns: this vocabulary is specific to this query's requirements.`,
          },
        ],
      }
    }
  )
}
