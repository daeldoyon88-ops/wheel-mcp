export const TAXONOMY_VERSION = 'GATE22_LABEL_TAXONOMY_V1';
export const TAXONOMY_PRIMITIVES = Object.freeze(['NEW_LOW', 'NEW_HIGH', 'RECOVERY', 'CONTINUATION', 'DRAWDOWN', 'RANGE']);
export function validateTaxonomy(labels) {
  if (!Array.isArray(labels) || labels.some((label) => !TAXONOMY_PRIMITIVES.includes(label))) throw new Error('TAXONOMY_V1_ONLY');
  return [...new Set(labels)];
}
