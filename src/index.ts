import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { RequirementsTreeSchema } from "./schemas/requirements.js"
import { validateAndRender } from "./tools/render.js"
import { submitMarkdown } from "./tools/submit.js"

const server = new McpServer({
  name: "prompt2requirements",
  version: "1.0.0",
})

// Règles de format Markdown partagées entre les tools — injectées dans les instructions
const FORMAT_RULES = `
RÈGLE SUR LE FORMAT DES REQUIREMENTS :
Chaque requirement doit TOUJOURS apparaître dans un tableau. Ce format est obligatoire pour le parsing downstream (Confluence, autres apps).

Tableau VERTICAL (requirement parent) :
  | | |
  | :--- | :--- |
  | **Clé** | PREFIX-001 |          ← 1ère ligne : la clé
  | **Titre** | Titre descriptif |  ← 2ème ligne : le titre
  | **Prop** | valeur |             ← lignes suivantes : les properties

Tableau HORIZONTAL (requirements enfants) :
  | Clé | Titre | Prop1 | Prop2 |   ← 1ère colonne : clé, 2ème : titre, reste : properties
  | :--- | :--- | :--- | :--- |
  | PREFIX-001 | Titre | ... | ... |

EN DEHORS des tableaux de requirements, le Markdown est libre :
tu peux ajouter des blocs de code, listes, notes, exemples, callouts, texte d'introduction, etc.
Ces éléments enrichissent le document sans casser le parsing des requirements.

Ce qui est interdit : sortir un requirement de son tableau (le mettre en texte libre, titre seul, liste, etc.).
Ce qui est autorisé : ajouter du contenu Markdown libre autour des tableaux.`

server.tool(
  "analyze_prompt",
  `Analyse un prompt utilisateur et produit un arbre de requirements structuré au format JSON.

Décompose la demande en requirements hiérarchiques (2 à 4 niveaux selon la complexité).

Properties recommandées :
- "Description" : explication détaillée
- "Critères d'acceptation" : conditions de validation
- "Priorité" : Must / Should / Could / Won't

RÈGLES POUR "key" :
- Format obligatoire : [A-Z]{2,8}-\\d{3} (ex: WEBHOOK-001, AUTH-002)
- Préfixe = abréviation significative du domaine (2-8 lettres majuscules)
- Numérotation séquentielle et unique dans tout l'arbre
- Les enfants peuvent avoir un préfixe différent si leur domaine est distinct

${FORMAT_RULES}`,
  {
    prompt: z.string().describe("La demande utilisateur décrivant la feature ou le besoin à spécifier"),
    project_name: z.string().describe("Nom du projet concerné"),
  },
  async ({ prompt, project_name }) => {
    const now = new Date().toISOString()
    return {
      content: [
        {
          type: "text",
          text: `Génère un arbre de requirements JSON pour la demande suivante, puis appelle immédiatement render_requirements avec le résultat.

PROJET : ${project_name}
DEMANDE : ${prompt}

SCHÉMA JSON (obligatoire) :
{
  "version": "1.0",
  "project_name": "${project_name}",
  "description": "<résumé de la feature en 1-2 phrases>",
  "created_at": "${now}",
  "requirements": [
    {
      "key": "<PREFIX-NNN>",
      "title": "<titre descriptif>",
      "properties": [
        { "label": "Description", "value": "<détail>" },
        { "label": "Critères d'acceptation", "value": "<conditions>" },
        { "label": "Priorité", "value": "Must | Should | Could | Won't" }
      ],
      "children": [ ...même structure récursive si besoin... ]
    }
  ]
}

ÉTAPES :
1. Produis l'arbre JSON complet et valide.
2. Appelle render_requirements(tree) — c'est lui qui génère le Markdown, ne pas l'écrire manuellement.
3. Affiche le résultat et demande à l'utilisateur s'il veut affiner.`,
        },
      ],
    }
  }
)

server.tool(
  "refine_requirements",
  `Affine un arbre de requirements existant en appliquant le feedback utilisateur.

Deux types de modifications possibles :

1. CONTENU des requirements (texte, propriétés, clés, structure) → modifier le JSON puis appeler render_requirements.
2. ENRICHISSEMENT du document (ajouter du texte libre, blocs de code, listes, notes autour des tableaux) → peut être fait directement sur le Markdown après le rendu.

${FORMAT_RULES}`,
  {
    current_tree: z.record(z.string(), z.unknown()).describe("L'arbre de requirements actuel (objet JSON complet)"),
    feedback: z.string().describe("Le feedback ou les modifications demandées par l'utilisateur"),
  },
  async ({ current_tree, feedback }) => {
    const validation = RequirementsTreeSchema.safeParse(current_tree)
    if (!validation.success) {
      return {
        content: [{ type: "text", text: `Erreur : l'arbre fourni est invalide. ${validation.error.message}` }],
        isError: true,
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Applique le feedback sur l'arbre de requirements.

FEEDBACK : ${feedback}

ARBRE ACTUEL :
${JSON.stringify(current_tree, null, 2)}

ÉTAPES :
1. Si le feedback porte sur le contenu des requirements (texte, propriétés, structure, clés) :
   → Modifie le JSON et appelle render_requirements(tree) pour régénérer le Markdown de base.
   → Tu peux ensuite enrichir le Markdown (blocs de code, listes, notes) autour des tableaux si pertinent.
2. Si le feedback porte uniquement sur l'enrichissement du document (ajouter un exemple, une note, du contexte) :
   → Ajoute directement le contenu Markdown autour des tableaux existants, sans toucher au JSON.
3. Dans tous les cas : les requirements restent dans leurs tableaux, jamais en texte libre.`,
        },
      ],
    }
  }
)

server.tool(
  "render_requirements",
  `Convertit un arbre de requirements JSON en Markdown structuré avec des tableaux.

C'est le SEUL outil autorisé pour produire le Markdown des requirements.
Le format des tableaux est imposé par le serveur et ne peut pas être modifié.
Appeler après chaque analyze_prompt ou refine_requirements.`,
  {
    tree: z.record(z.string(), z.unknown()).describe("L'arbre de requirements (objet JSON complet)"),
  },
  async ({ tree }) => {
    try {
      const markdown = validateAndRender(tree)
      return {
        content: [
          {
            type: "text",
            text: `Affiche le document suivant directement dans ta réponse (interprète le Markdown, ne le mets pas dans un bloc de code) :\n\n${markdown}\n\nDemande à l'utilisateur s'il veut affiner (via refine_requirements) ou valider pour envoyer (via submit_requirements).`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erreur de rendu : ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "submit_requirements",
  `Envoie le Markdown final à l'API backend pour générer la page de spécifications.

Appelle ce tool uniquement quand l'utilisateur a confirmé qu'il est satisfait.
Passe UNIQUEMENT le Markdown produit par render_requirements — jamais du Markdown écrit manuellement.`,
  {
    markdown: z.string().describe("Le contenu Markdown produit par render_requirements"),
  },
  async ({ markdown }) => {
    const result = await submitMarkdown(markdown)
    return {
      content: [{ type: "text", text: result.message }],
      isError: !result.success,
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
