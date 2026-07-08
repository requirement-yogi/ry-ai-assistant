# Requirement Yogi — RQL search syntax reference (v3)

<!--
  SOURCE OF TRUTH: this reference is derived ONLY from the ANTLR grammar
  backend/shared/src/main/antlr4/.../RQL.g4 (structure) and the DSL
  evaluation code under .../features/dsl/model (semantics).
  It intentionally supersedes search-syntax-prompt.txt and
  search-syntax-prompt-v2.md, which contained constructs that no longer
  exist in the grammar (excel, isModified(), hasLastTest(), links,
  pageHistory, `baseline was`) and a wrong page-title wildcard (*/? — pages
  actually use % like everything else). Do NOT reintroduce those.
  Only fields/operators reachable from `searchExpression` are listed here;
  calculation/aggregation functions (SUM, COUNT, IF, CONCAT, AVGIF, …) are
  NOT valid in a search query and are deliberately omitted.
-->

A search query is either a **boolean expression** (a filter, described below)
or a **bare quoted string** (`'login form'`), which runs a full-text search on
the requirement key and text (matched as `%login form%`, case-insensitive).

The syntax is **case-insensitive** for keywords and field names.

## Operators

| Operator | Meaning |
|----------|---------|
| `=` `==` | exact equality |
| `!=` `<>` | not equal |
| `>` `>=` `<` `<=` | numeric comparison (typed values only, e.g. `ext@`) |
| `~` `LIKE` `ILIKE` | wildcard match — use `%` (multi-char). This is the ONLY wildcard; there is no `*`, `?`, or single-char wildcard |
| `IS NULL` / `IS NOT NULL` | presence check |
| `IN (v1, v2, …)` / `NOT IN (…)` | membership |
| `AND` `OR` `NOT` `( )` | boolean composition |
| `rel-> …` (or `rel→ …`) | chained search through a relationship |

## Values

- **String**: single-quoted — `'Functional'`. Inside the quotes, escape a
  literal `'` or `\` with a backslash (`'it\'s'`). `%` inside a string is a
  wildcard when used with `~`/`LIKE`.
- **Number**: `42`, `-3`, `10.5`.
- **Boolean**: `true` / `false`.
- **Null**: `NULL`.

## Fields

### Core

| Field (+ aliases) | Compares to | Notes |
|-------------------|-------------|-------|
| `key` | string | requirement key, unique per space. **Never null** — do not write `key IS NOT NULL`. |
| `text` (`description`) | string | requirement content (not its properties). |
| `space` (`spacekey`, `space_key`) | string | space key (case-sensitive value). |
| `status` | string | internal state (`ACTIVE`, `DELETED`, `MOVED`), default `ACTIVE`. Rarely useful — for a workflow status prefer a custom property `@Status`. |
| `page` (`document_id`) | number (page ID) or string (page title) | Only `=` and `~` are allowed. Title uses `%` for wildcard: `page ~ 'Specs%'`. |
| `link` | primitive | typically `link IS NULL` / `link IS NOT NULL`. |

### Properties

| Field | Compares to | Notes |
|-------|-------------|-------|
| `@Name` | string / null | a requirement property. |
| `ext@Name` | typed value | an external (typed) property. Supports `> >= < <=` on numeric properties: `ext@Cost > 500`. |

Escape spaces and special characters in a property name with `\`:
`@Main\ Category = 'Functional'`.

### Dependencies

| Field | Meaning |
|-------|---------|
| `from` / `child` (aliases) | requirements referenced **by** the given key (`from = 'REQ-1'`). |
| `to` / `parent` (aliases) | requirements that **reference** the given key (`to = 'REQ-1'`). |
| `from@rel`, `to@rel`, … | restrict to a named relationship: `from@refines = 'REQ-1'`. |

Chained (multi-hop) search uses `->`:
`from@refines->ext@Cost > 500` = requirements having a child (via `refines`)
whose external property `Cost` > 500. Chains can be nested:
`to@rel1->from@rel2->@Author = 'John'`.

### Jira

| Field | Compares to | Notes |
|-------|-------------|-------|
| `jira` | string (issue key) / null | `jira = 'JRA-21'`, `jira IS NULL`. |
| `jira@rel` | string | linked with relationship `rel` (relationship name is matched case-insensitively): `jira@implements = 'JRA-21'`. |
| `project` (`project_key`, `projectKey`) | string | Jira project key. Only `=` and `~`. |
| `project_name` (`projectName`) | string | Jira project display name. Only `=` and `~`. |

### Validation rules

| Field | Compares to | Notes |
|-------|-------------|-------|
| `ruleStatus` | `true` / `false` / `'warning'` / null | `ruleStatus = false` = requirements in error; `ruleStatus IS NOT NULL` = submitted to at least one rule. |
| `ruleStatus@Rule\ Name` | same | status for a specific rule (escape spaces): `ruleStatus@Mandatory\ Owner = false`. |

### Variants, baselines, types

| Field | Compares to |
|-------|-------------|
| `variant` | id (`variant = 1`), name (`variant = 'Current'`), or `('Name' in space 'KEY')`. |
| `baseline` | number, name (`baseline = 'My Baseline'`), `('Name' in space 'KEY')`, `('Name' in parent 'KEY')`, or null. |
| `type` (`type.id`, `type.name`) | string / number / null. |

### Advanced / internal fields

These exist in the grammar but are niche or internal — use only when the user
explicitly needs them: `id`, `new_key`, `new_space_key`, `container`,
`new_container`, `suspect`, `test_case` (`testCase`).

## Gotchas (grammar/eval-verified)

- `%` is the only wildcard, everywhere (including page titles). No `*` / `?`.
- Escape spaces and specials in **identifier names** (properties, relationships,
  rule names) with `\` — never inside a value string, which is quoted.
- `key` is never null → `key IS NOT NULL` is always-true and useless.
- A bare `'%'` matches everything — never emit it alone.
- `page`, `project`, `project_name` accept only `=` and `~`.
- Numeric comparisons (`> < >= <=`) apply to typed values (`ext@…`, numbers),
  not to plain string properties.
- There is no cross-space search operator; filter a single space with `space`.

## Examples (intent → query)

```
keys starting with BR                    key ~ 'BR-%'
text contains "login"                    text ~ '%login%'
Category is Functional                   @Category = 'Functional'
property "Main Category" set             @Main\ Category IS NOT NULL
lifecycle in a set                       @Life\ cycle IN ('DRAFT', 'DONE')
priority not High                        @Priority != 'High'
external cost over 500                   ext@Cost > 500
no linked Jira issue                     jira IS NULL
linked to JRA-21 via "implements"        jira@implements = 'JRA-21'
in Jira project ABC                      project = 'ABC'
on a page whose title starts "Specs"     page ~ 'Specs%'
on page with ID 467382                   page = 467382
child (via 'refines') with cost > 500    from@refines->ext@Cost > 500
fails rule "Mandatory Owner"             ruleStatus@Mandatory\ Owner = false
requirements in error                    ruleStatus = false
starts with FN, no parent in XX          key ~ 'FN-%' AND NOT (parent ~ 'XX%')
variant "Current" in space ANOTHER       variant = ('Current' in space 'ANOTHER')
```
