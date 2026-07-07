// The Requirement Yogi search syntax, surfaced to the client LLM (same pattern as
// indexingRules.ts) so it can translate the user's request into valid queries for
// search_requirements. Adapted from the RY search-syntax prompt: the output-format
// section was dropped (the LLM passes the query string directly to the tool).

export const SEARCH_SYNTAX = `HOW TO WRITE THE QUERY — Requirement Yogi search syntax reference:

## THE #1 RULE: A QUERY IS ALWAYS "field operator value" — NEVER a bare term

This is a structured query language, NOT a free-text search box. Every condition MUST
name a field, an operator and (for text) a quoted value. A value on its own — a key, a
word, an ID — is NOT a valid query and will match nothing.

A requirement key such as "BREW-F-01" is a VALUE, not a query. To search for it you MUST
put it inside a field condition:
  - exact key   → key = 'BREW-F-01'
  - key prefix  → key ~ 'BREW-F-01%'   (or key ~ 'BREW-F-%' for the whole family)
NEVER send the key on its own as the query.

Rules of thumb:
- String values go in single quotes; use '%' as the wildcard with the '~' operator.
- When the user gives a key, an ID or a prefix WITHOUT naming a field, default to \`key\`
  (exact key → '='; a prefix or family of keys → '~' with a trailing '%').
- Combine several conditions with AND / OR / NOT and parentheses — but each side of a
  boolean is itself a full "field operator value" condition, never a bare term.

### By key

key = 'IG-1': the requirement with the exact key.
key ~ 'IG-%': all requirements starting with 'IG-'.

### By contents

text ~ '% something' : all requirements whose text ends with 'something'.

### By pages

page = 467382: requirements defined on the page with ID 467382.
page = 'a title': requirements on the page whose title matches
'a title' (CQL-based, partial match, not exact).
page ~ 'Partial title*': requirements on pages whose title starts with
'Partial title'. NOTE: for page titles, use
'*' (multiple chars) and '?' (single char) as
wildcards, NOT '%'.
link IS NOT NULL / link IS NULL: requirements that do or do not have links.
(Legacy/uncertain: older versions may also support \`links = <pageId>\` and
\`pageHistory = <pageId>\` to search across page versions. Use only if the
user explicitly needs this, and flag as best-effort.)

### By Jira issues

jira = 'JRA-21'              : requirements linked from the issue JRA-21.
jira IS NOT NULL / IS NULL   : requirements that are/aren't linked to Jira.
jira@implements = 'JRA-21'   : requirements linked from JRA-21 with the
relationship "implements" (relationship name
must be lowercase).
project = 'KEY'              : requirements linked to Jira issues in project
KEY (partial match, case-insensitive).
projectName = 'My project'   : same, but by project display name.

### By requirement properties

@Category = 'Functional'            : property 'Category' equals 'Functional'.
@Main\\ Category = 'Functional'      : property 'Main Category' (escape spaces
and special characters with '\\').
ext@Category = 'Functional'         : external property 'Category'.
ext@Estimate > 10                   : external properties are typed and
support comparison operators (typed as
string/float/integer/boolean...).
(@Category IS NULL) OR (@Prop = '') : property considered empty.
(@Category IS NOT NULL) AND (@Prop != '') : property considered filled.

### By Linear Documents properties

Requirements coming from Linear Documents expose two extra properties:
@Level = 'First'   : the first-level titles. Also 'Last', 'Intermediate',
'First and Last'.
@Section = 'Parent requirement title' : children requirements of that title.
(The Linear Documents relationship is named "Section", so the dependency syntax
also works: from@Section = 'REQ-001', to@Section ~ 'REQ-%', from@Section IS NULL.)

### By requirement dependencies

to = 'REQ-001'          : requirements which reference REQ-001.
from = 'REQ-001'        : requirements which are referenced by REQ-001.
from ~ 'REQ-%'          : requirements referenced by any requirement
starting with "REQ-".
from@refines = 'REQ-001': requirements "refined" by REQ-001.
parent = 'REQ-001'      : alias of \`to\` — requirements which reference REQ-001.
child = 'REQ-001'       : alias of \`from\` — requirements referenced by REQ-001.
key ~ 'REQ-%' AND child IS NULL : requirements with no children.
key ~ 'REQ-%' AND parent@Test\\ Result IS NULL : requirements with no parent
for the relationship "Test Result".

### Linked requirements (chained search)

Use \`relation->\` or \`relation→\` to search through a chain of linked
requirements (multi-hop conditions):
from->ext@Cost > 1000
: requirements with at least one child (any relationship) whose external
property 'Cost' > 1000.
to@relation1->ext@Man\\ days > 20
: requirements with at least one parent via 'relation1' whose external
property 'Man days' > 20.
to@relation1->from@relation2->@Author = 'John'
: requirements with a parent via 'relation1', which itself has a child via
'relation2', where property 'Author' = 'John'.
from@relation1->key ~ 'BR-%' AND from@relation2->@Assignee = 'Jane'
: two independent chained conditions combined with AND.
from@relation1->(text ~ '% something' AND from@relation2->@Delivered = 'true')
: grouped/nested chained conditions.

### By variants

variant = 1                              : requirements with variant id 1.
variant = 'Current'                      : requirements with variant name
'Current' (every space has a
default variant called 'Current').
variant = ('Current' in space 'ANOTHER') : variant 'Current' in another space.

### By baselines

baseline = 'My Baseline'  : requirements belonging to that baseline.
(Legacy/uncertain, keep only if explicitly requested: \`baseline = 3\`,
\`baseline was 3\`, \`baseline = 4 and baseline was 3\`, and the variable
\`$currentBaseline\` may still work in some versions but are no longer
documented — do not rely on them by default.)

### By validation rules

ruleStatus = true                  : requirements which respect all rules.
ruleStatus = 'warning'              : requirements with a warning.
ruleStatus = false                  : requirements in error.
ruleStatus@my\\ rule = false         : requirements failing the rule "my rule"
(exact name/label required).
ruleStatus@my\\ rule IS NOT NULL     : requirements submitted to "my rule".

### Special search (legacy, undocumented in current version — use with caution)

isModified('7') : requirements modified since baseline '7' of the current
space (accepts baseline number or name).
hasLastTest('%Success%') : checks the last test result. Syntax:
hasTest([relationship,] expectedResult [,page])
hasLastTest([relationship,] expectedResult [,page])

### By Excel (legacy, undocumented in current version — use with caution)

excel = '48496653' : requirements imported from Excel attachment ID 48496653.
excel ~ '%'         : requirements imported from any Excel file.

## OPERATORS

- Boolean: AND, OR, NOT, ( )
- Equality: = / ==  (strict)
- Soft equality: ~  or like — use '%' as wildcard (except page titles,
  which use '*' and '?', see above)
- Difference: !=
- Property reference: @...
- Null checks: IS NULL / IS NOT NULL
- List membership: IN (...) / NOT IN (...)
- Chained/linked search: relation-> or relation→

## FIELDS

key             : requirement key (unique per space).
spaceKey        : space key (case sensitive).
status          : internal status (ACTIVE, DELETED, MOVED). Default ACTIVE.
Rarely useful — prefer a user-defined "@status" property.
NEVER confuse \`status\` (internal) with \`@status\` (custom
property) — only use bare \`status\` if the user is clearly
asking about deletion/move state, not a custom workflow.
text            : requirement content (not properties).
page            : ID or title of the page where the requirement is defined.
link            : IS NULL / IS NOT NULL only.
jira            : linked Jira issue key.
jira@relationship : Jira issue linked with a given relationship.
project / projectName : Jira project key / name.
@property       : a requirement property.
ext@property    : an external (typed) property.
to@relationship / from@relationship / parent / child : dependencies.
variant         : requirement variant.
baseline        : baseline name (see legacy notes above).
ruleStatus      : validation rule status.

Note: cross-space search is not currently available — do not attempt to
combine \`spaceKey\` conditions to search multiple spaces at once beyond a
simple equality filter.

## GOOD PRACTICES / GOTCHAS

- NEVER pass a bare value as the query (see THE #1 RULE): \`BREW-F-01\` alone is invalid —
  write \`key = 'BREW-F-01'\` (exact) or \`key ~ 'BREW-F-01%'\` (prefix). If in doubt about
  which field, default to \`key\`.
- A requirement key can never be null — never write \`key IS NOT NULL\`.
- Never use the bare wildcard '%' or '*' alone (matches everything, useless).
- Escape spaces or special characters in property/relationship names with
  a backslash: \`@Main\\ Category\`, \`ruleStatus@my\\ rule\`.
- Jira relationship names in \`jira@relationship\` must be lowercase.
- If the field to search on isn't specified by the user, default to \`key\`.
- If the user's request is genuinely ambiguous between two valid
  interpretations, either ask the user, or run one search per interpretation.
- Never invent field or property names beyond what the user specifies or what
  is listed above.

## EXAMPLES

- "BREW-F-01" (a single key) → key = 'BREW-F-01'   (NOT the bare term BREW-F-01)
- "Find requirement BREW-F-01" → key = 'BREW-F-01'
- "Everything under BREW-F" → key ~ 'BREW-F-%'
- "Requirements starting with 'br-'" → key ~ 'br-%'
- "Requirements containing 'Momo'" → key ~ '%Momo%'
- "Requirements starting with 'FN-' with no dependency 'Covered' to 'HISTO'"
  → key ~ 'FN-%' AND NOT to@Covered = 'HISTO'
- "Requirements starting with ASS with Status property deleted"
  → key ~ 'ASS%' AND @Status = 'DELETED'
- "Requirements starting with XX.01- but not ending with -FUN-"
  → key ~ 'XX.01-%' AND NOT key ~ '%-FUN-%'
- "Requirements starting with 'FN' without parent starting with 'XX' and
  description not containing 'Reported'"
  → key ~ 'FN-%' AND NOT (parent ~ 'XX%') AND NOT (text ~ '%Reported%')
- "Requirements starting with BR, release version 1.2.1 or 1.2.3, lifecycle
  DONE or APPROVED"
  → (key ~ 'BR%') AND (@release\\ version = '1.2.1' OR @release\\ version = '1.2.3')
  AND (@Life\\ cycle = 'DONE' OR @Life\\ cycle = 'APPROVED')
- "Requirements containing 'XX' linked to Jira issue 'RYC-LEARN-128'"
  → jira = 'RYC-LEARN-128' AND key ~ '%-XX-%'
- "Requirements without a Jira issue" → jira IS NULL
- "Requirements in page 'Copy of Hello world!' with category 'E-Learning'"
  → page = 'Copy of Hello world !' AND @Category = 'E-Learning'
- "Requirements starting with RYC referenced by a requirement having an owner"
  → key ~ 'RYC%' AND NOT (from@owner ~ '%')
- "Requirements with lifecycle in DRAFT, REVIEW or DONE"
  → @Life\\ cycle IN ('DRAFT', 'REVIEW', 'DONE')
- "Requirements whose priority is not High"
  → @Priority != 'High'
- "Requirements with a child, through relation 'implements', whose external
  cost is over 500"
  → from@implements->ext@Cost > 500
- "Requirements with variant 'Current' in space 'ANOTHER'"
  → variant = ('Current' in space 'ANOTHER')
- "Requirements that fail the rule 'Mandatory Owner'"
  → ruleStatus@Mandatory\\ Owner = false`
