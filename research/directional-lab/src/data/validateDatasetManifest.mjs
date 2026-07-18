/**
 * Validate a DatasetManifestV1 structurally and, optionally, against the
 * source file it points to (hash must still match: detects silent mutation).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { datasetManifestProblems } from '../contracts/datasetManifestV1.mjs';

/**
 * @param {Object} manifest
 * @param {{verifyHash?: boolean}} [options]
 * @returns {{problems: string[], hashVerified: boolean|null}}
 */
export function validateDatasetManifest(manifest, options = {}) {
  const problems = datasetManifestProblems(manifest);
  let hashVerified = null;
  if (problems.length === 0 && options.verifyHash) {
    try {
      const bytes = readFileSync(/** @type {any} */ (manifest).sourcePath);
      const actual = createHash('sha256').update(bytes).digest('hex');
      hashVerified = actual === /** @type {any} */ (manifest).contentHash;
      if (!hashVerified) {
        problems.push(`source file changed since manifest was built (hash mismatch for ${(/** @type {any} */ (manifest)).sourcePath})`);
      }
    } catch (err) {
      hashVerified = false;
      problems.push(`source file unreadable: ${/** @type {Error} */ (err).message}`);
    }
  }
  return { problems, hashVerified };
}
