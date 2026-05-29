import { RequirementsTreeSchema, type RequirementsTree } from "../schemas/requirements.js"

export const REFINE_TOOL = {
  name: "refine_requirements",
  description: `Affine un arbre de requirements existant en appliquant le feedback utilisateur.

Tu reçois l'arbre actuel (current_tree) et le feedback de l'utilisateur (feedback).
Tu dois modifier l'arbre en tenant compte du feedback : ajouter, supprimer, reformuler ou réorganiser des requirements.
Retourne UNIQUEMENT le nouvel arbre JSON complet, valide et modifié.`,
  inputSchema: {
    type: "object",
    properties: {
      current_tree: {
        type: "object",
        description: "L'arbre de requirements actuel (objet JSON complet)",
      },
      feedback: {
        type: "string",
        description: "Le feedback ou les modifications demandées par l'utilisateur",
      },
    },
    required: ["current_tree", "feedback"],
  },
} as const

export function validateTree(raw: unknown): RequirementsTree {
  return RequirementsTreeSchema.parse(raw)
}
