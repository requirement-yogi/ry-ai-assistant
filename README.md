# Prompt2Requirements

Serveur MCP (Model Context Protocol) en TypeScript qui permet à un LLM client (Claude Desktop, Claude Code, Cursor…) de transformer un prompt utilisateur en arbre de requirements structuré, de l'affiner en conversation, puis de l'envoyer à un backend qui génère une page de spécifications (Confluence ou autre).

## Prérequis

- Node.js 18+
- npm
- Claude Desktop (ou tout client MCP compatible)

## Installation

```bash
npm install
npm run build
```

## Configuration

Copier `.env.example` en `.env` et renseigner les valeurs :

```bash
cp .env.example .env
```

```env
API_BASE_URL=http://localhost:8082
API_ACCESS_TOKEN=your-access-token
```

## Connexion à Claude Desktop

Éditer `~/Library/Application Support/Claude/claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "prompt2requirements": {
      "command": "node",
      "args": ["/chemin/vers/Prompt2Requirements/dist/index.js"],
      "env": {
        "API_BASE_URL": "http://localhost:8082",
        "API_ACCESS_TOKEN": "your-access-token"
      }
    }
  }
}
```

Redémarrer Claude Desktop. L'icône 🔨 en bas de la zone de saisie confirme que les tools sont chargés.

## Utilisation

Décrire une feature en langage naturel dans Claude Desktop :

> "Je veux spécifier une nouvelle feature sur mon projet de machine à café connectée. J'aimerais ajouter un webhook pour déclencher la préparation d'un café depuis une automatisation externe."

Claude utilise alors les tools MCP pour :

1. Décomposer le besoin en arbre de requirements JSON
2. Afficher un aperçu Markdown avec des tableaux structurés
3. Affiner en boucle selon le feedback
4. Envoyer la page finale au backend

## Les 4 tools MCP

| Tool | Rôle |
|---|---|
| `analyze_prompt` | Décompose le prompt en arbre de requirements JSON |
| `refine_requirements` | Applique le feedback utilisateur sur l'arbre JSON |
| `render_requirements` | Génère le Markdown structuré depuis le JSON |
| `submit_requirements` | Envoie le Markdown final à l'API backend |

## Format du document généré

Chaque requirement est rendu dans un tableau :

**Parent (tableau vertical) :**
```markdown
## Titre du requirement

| | |
| :--- | :--- |
| **Clé** | WEBHOOK-001 |
| **Titre** | Webhook de déclenchement café |
| **Description** | Exposer un endpoint HTTP... |
| **Priorité** | Must |
```

**Enfants (tableau horizontal) :**
```markdown
| Clé | Titre | Description | Critères d'acceptation |
| :--- | :--- | :--- | :--- |
| RECV-001 | Réception et validation | ... | 200 si accepté... |
| AUTH-001 | Authentification | ... | 401 si secret invalide |
```

Du contenu Markdown libre (blocs de code, listes, notes) peut être ajouté autour des tableaux.

## Schéma JSON

```typescript
Property        = { label: string, value: string }
RequirementNode = {
  key: string,    // identifiant : format [A-Z]{2,8}-\d{3}, ex: WEBHOOK-001
  title: string,  // texte descriptif
  properties: Property[],
  children: RequirementNode[]
}
RequirementsTree = {
  version: "1.0",
  project_name: string,
  description: string,
  created_at: string,  // ISO datetime
  requirements: RequirementNode[]
}
```

## Développement

```bash
npm run dev      # Lance le serveur MCP en mode dev (tsx, sans build)
npm run build    # Compile TypeScript → dist/
npm run mock     # Lance un serveur mock local sur :3000 (sauvegarde les .md dans output/)
```

## Logs

Les logs du serveur MCP sont accessibles dans :

```
~/Library/Logs/Claude/mcp-server-prompt2requirements.log
```

```bash
tail -f ~/Library/Logs/Claude/mcp-server-prompt2requirements.log
```

## Architecture

```
src/
├── index.ts              # Serveur MCP — registration des 4 tools
├── auth/
│   └── keycloak.ts       # Client credentials OAuth2 (si besoin)
├── schemas/
│   └── requirements.ts   # Schéma Zod + types TypeScript
└── tools/
    ├── analyze.ts         # Constantes du tool analyze
    ├── refine.ts          # Constantes du tool refine
    ├── render.ts          # Conversion JSON → Markdown
    └── submit.ts          # POST Markdown vers l'API backend
```
