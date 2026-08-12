<!--
THE column glossary — the single source of truth for what each traceability column type MEANS.

Why this file exists: a step type like ORIGINAL_LINKS tells the model nothing, so when a user asks
"add the pages where the requirements are written" the model concludes it cannot do it — even though
the column is right there in the suggestions. Names are not semantics; this file supplies them.

It is used TWICE, from this one source:
  - included in the discover_matrix_columns description (below), so the model knows what exists
    BEFORE it calls anything;
  - parsed by scripts/embed-docs.mjs into COLUMN_MEANINGS, so every discovery response carries a
    `legend` explaining the types it actually returned.

FORMAT, and it is load-bearing: one `## STEP_TYPE` section per column type, the heading being the
exact enum value. The text under it is what the model reads. A missing or extra type is a COMPILE
error in src/prompts/descriptions.ts, so this file cannot drift from the enum.

To add or reword a meaning: edit here, nothing else. No code change.
-->
WHAT THE COLUMN TYPES MEAN. A column type is an enum name, not an explanation — match what the user
asked for against the meanings below, then use the type discover_matrix_columns offers for it.

Common requests, and the column that answers them:

- "the page / document where the requirement is written", "where does this requirement come from",
  "in which document is it specified" → **ORIGINAL_LINKS** (the source page), and **LINKS** if they
  also want every page that references the requirement.
- "the linked Jira tickets", "which issues implement it" → **JIRA** (and JIRA_TYPE,
  JIRA_PROJECT_KEY, JIRA_PROJECT_NAME, JIRAFIELD for a specific field of those issues).
- "its priority / category / owner / any attribute of the requirement" → **PROPERTY** with that
  property name (or **EXTERNAL_PROPERTY** for a typed one), **ALL_PROPERTIES** for every one at once.
- "the requirements it depends on", "what covers it", "the linked requirements" → **TO** or **FROM**
  with a relationship name, **ALL_DEPENDENCIES** for every relationship at once.
- "the text of the requirement" → **DESCRIPTION**.
- "the test cases / test executions" → **ZEPHYR_SCALE** or **XRAY** (depending on which tool the
  space uses), **TEST_CASE_VERSION** for the tested version.
- "a computed column", "a count", "a percentage" → **CALCULATION** with a formula the USER provides.

If nothing here matches what the user asked for, say so plainly instead of substituting a column
that looks close: a wrong column renders content that answers a different question.

## FIRST_COLUMN

Column 0, the requirements themselves — the ones the query returned. Always present, added
automatically, and every other column hangs off it.

## ORIGINAL_LINKS

The Confluence page where the requirement is WRITTEN — its source document, the page whose text
defines it. This is the column for "which page/document does this requirement come from".

## LINKS

The Confluence pages LINKED to the requirement: where it is referenced or reused, beyond the page it
is written on. Use it for "everywhere this requirement appears"; use ORIGINAL_LINKS for "where it is
written".

## DESCRIPTION

The text of the requirement itself, as indexed by Requirement Yogi.

## PROPERTY

One property of the requirement, by name (`value` is the property key): the attributes the team put
on their requirements — Priority, Category, Owner, Status… Only names the suggestions returned exist.

## ALL_PROPERTIES

Every property of the requirement in a single column, instead of one column per property. Useful when
the user wants "all the attributes" without naming them.

## EXTERNAL_PROPERTY

Like PROPERTY, but a TYPED property (number, date, enum…), which is what makes range comparisons
possible. `value` is the property key; the column carries its enum values automatically.

## ALL_EXTERNAL_PROPERTIES

Every typed property of the requirement in a single column, instead of one column per typed property.

## TO

Follows a relationship (its name is `value`) and shows the requirements reached that way — one
direction of a dependency such as "implements", "is tested by", "covers".

Do NOT choose between TO and FROM yourself: discover_matrix_columns tells you which of the two
reaches a given relationship, and the two are mirror images. Take the type it gives you for a
relationship and never swap it — a swapped direction is a valid column that matches nothing.

## FROM

The other direction of a relationship (its name is `value`). Same warning as TO: use the type
discover_matrix_columns returned for that relationship, never the one whose name sounds right.

## ALL_DEPENDENCIES

Every dependency of the requirement in one column, whatever the relationship — instead of one column
per relationship.

## JIRA

The Jira issues linked to the requirement. The column for "which tickets implement / cover this
requirement".

## JIRA_RELATIONSHIP

The Jira issues linked through ONE named Jira relationship (`value` is the relationship name),
instead of all of them. The suggestions do not list those names, so confirm the name with the user.

## JIRA_TYPE

The issue TYPE of the linked Jira issues (Bug, Story, Task…).

## JIRA_PROJECT_KEY

The project key of the linked Jira issues (e.g. SCB).

## JIRA_PROJECT_NAME

The project name of the linked Jira issues.

## JIRAFIELD

One field of the linked Jira issues, by field key (`value`, e.g. `issuetype`, `status`, or a
`customfield_…`). Use it when the user wants a specific Jira field rather than the issues themselves.

## VARIANT

The variant the requirement belongs to. Useful when a space uses variants and the user wants to see
which one each requirement comes from.

## SPACE_KEY

The Confluence space the requirement belongs to — worth a column only when the matrix spans several
spaces.

## TEST_CASE_VERSION

The version of the requirement that was tested, for requirements linked to test cases.

## ZEPHYR_SCALE

Zephyr Scale test objects linked to the requirement (`value` is the object type). For a space that
manages its tests with Zephyr Scale.

## XRAY

Xray test objects linked to the requirement. For a space that manages its tests with Xray.

## CALCULATION

A computed column: `value` is the formula. The formula comes from the USER — it is never suggested,
so ask for it rather than inventing one.
