import { RequirementsTreeSchema, type RequirementsTree } from "../schemas/requirements.js"

export const ANALYZE_TOOL = {
  name: "analyze_prompt",
  description: `Analyse un prompt utilisateur et produit un arbre de requirements structuré au format JSON.

Tu dois décomposer la demande en requirements hiérarchiques (de 2 à 4 niveaux selon la complexité).
Chaque requirement a une clé (key) courte et descriptive, et des properties libres selon le contexte.

Les properties recommandées sont :
- "Description" : explication détaillée du requirement
- "Critères d'acceptation" : conditions de validation
- "Priorité" : Must / Should / Could / Won't

Retourne UNIQUEMENT un objet JSON valide respectant ce schéma :
${JSON.stringify(RequirementsTreeSchema.shape, null, 2)}

Exemple de structure attendue :
{
  "version": "1.0",
  "project_name": "Nom du projet",
  "description": "Description de la feature",
  "created_at": "<ISO datetime>",
  "requirements": [
    {
      "key": "Nom du requirement parent",
      "properties": [
        { "label": "Description", "value": "..." },
        { "label": "Priorité", "value": "Must" }
      ],
      "children": [
        {
          "key": "Nom du sous-requirement",
          "properties": [
            { "label": "Description", "value": "..." },
            { "label": "Critères d'acceptation", "value": "..." }
          ],
          "children": []
        }
      ]
    }
  ]
}`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "La demande utilisateur décrivant la feature ou le besoin à spécifier",
      },
      project_name: {
        type: "string",
        description: "Nom du projet concerné",
      },
    },
    required: ["prompt", "project_name"],
  },
} as const

export function validateTree(raw: unknown): RequirementsTree {
  return RequirementsTreeSchema.parse(raw)
}
