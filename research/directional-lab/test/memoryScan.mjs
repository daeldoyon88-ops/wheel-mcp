/**
 * Lab-local helpers for the anti-external-memory static scan.
 * Markers are assembled by concatenation so this file never contains the
 * forbidden literals as contiguous source text that would self-trigger.
 */

/** @param {string} text */
export function normalizeScanText(text) {
  return String(text).toLowerCase().replace(/\\/g, '/');
}

/** @returns {string[]} */
export function forbiddenMemoryMarkers() {
  return [
    '.cla' + 'ude',
    'memory' + '.md',
    'project_' + 'directional_lab',
    'project ' + 'memory',
  ];
}

/**
 * @param {string} text
 * @returns {string[]} markers found (normalized)
 */
export function findForbiddenMemoryMarkers(text) {
  const normalized = normalizeScanText(text);
  return forbiddenMemoryMarkers().filter((marker) => normalized.includes(marker.toLowerCase()));
}
