# Prompt2Requirements — MCP Server

## Ce que fait ce projet

Serveur MCP (Model Context Protocol) en TypeScript qui permet à un LLM client (Claude Desktop, Claude Code, Cursor...) de transformer un prompt utilisateur en arbre de requirements structuré au format JSON, de l'affiner en conversation, puis de l'envoyer à un backend qui génère une page de spécifications (Confluence ou autre).

**Le LLM client fait le travail de découpage** — le MCP server fournit le schéma, valide le JSON (Zod), et envoie à l'API. Pas d'appel LLM côté serveur.

## Stack

- TypeScript + Node.js (ESM)
- `@modelcontextprotocol/sdk` pour le serveur MCP
- `zod` v4 pour la validation du schéma
- Transport : stdio (standard MCP)

## Commandes

```bash
npm run build   # compile TypeScript → dist/
npm run dev     # lance en dev avec tsx (pas de build nécessaire)
npm start       # lance le build compilé
```

## Architecture

```
src/
├── index.ts                  # Serveur MCP, registration des 4 tools
├── schemas/requirements.ts   # Schéma Zod + types TypeScript
└── tools/
    ├── analyze.ts            # Constantes du tool analyze
    ├── refine.ts             # Constantes du tool refine
    ├── render.ts             # Conversion JSON → Markdown (renderTree)
    └── submit.ts             # POST Markdown vers l'API (mock pour l'instant)
```

## Les 4 tools MCP

| Tool | Input | Rôle |
|---|---|---|
| `analyze_prompt` | `prompt`, `project_name` | Instruit le LLM de produire l'arbre JSON initial |
| `refine_requirements` | `current_tree`, `feedback` | Valide l'arbre entrant puis instruit le LLM d'appliquer le feedback |
| `render_requirements` | `tree` | Convertit le JSON en Markdown (côté serveur, déterministe) pour preview dans le chat |
| `submit_requirements` | `markdown` | POST le Markdown final vers l'API backend |

Le JSON est le format interne (structuré, validable par Zod). Le Markdown est ce qui sort : preview chat + payload envoyé au backend.

## Schéma JSON (Zod)

```typescript
Property          = { label: string, value: string }
RequirementNode   = { key: string, properties: Property[], children: RequirementNode[] }
RequirementsTree  = { version: "1.0", project_name, description, created_at, requirements: RequirementNode[] }
```

- Pas d'`id` sur les nœuds (généré par la DB côté backend)
- Pas de `type` sur les nœuds (libre, non imposé)
- `properties` est un tableau libre de label/value — pas de colonnes prédéfinies
- La hiérarchie est libre en profondeur

## Variables d'environnement

```bash
API_URL=http://localhost:3000/api/requirements  # endpoint POST du backend
```

Copier `.env.example` → `.env`. Le tool `submit` mocke le succès si l'API n'est pas disponible.

## Flux utilisateur

```
[User] prompt → analyze_prompt → LLM produit l'arbre JSON
[User] feedback → refine_requirements → LLM affine l'arbre (loop)
[User] "montre-moi" → render_requirements → Markdown affiché dans le chat
[User] retouches libres sur le MD via le LLM (optionnel)
[User] "valide" → submit_requirements → POST Markdown vers l'API
```

## Ce qui reste à faire

- [ ] Connecter à Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)
- [ ] Définir le contrat d'API avec le backend (format de la requête POST, auth)
- [ ] Ajouter l'authentification sur `submit_requirements` (token en env var)
- [ ] Tester le flow complet avec un vrai prompt
- [ ] Affiner les descriptions des tools selon les retours qualité du LLM
