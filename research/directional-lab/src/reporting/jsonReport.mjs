/**
 * JSON reporting. Output is only written when the caller passes an explicit
 * path (CLI --output); otherwise the string is returned for stdout.
 * Serialization refuses NaN/Infinity (stableStringify throws).
 */

import { writeFileSync } from 'node:fs';
import { stableStringify } from '../contracts/backtestResultV1.mjs';

/**
 * Pretty, deterministic JSON (sorted keys).
 * @param {unknown} value
 * @returns {string}
 */
export function prettyStableJson(value) {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2);
}

/**
 * Write a report to an explicit path. Never picks a path itself.
 * @param {string} outputPath
 * @param {unknown} value
 * @returns {void}
 */
export function writeJsonReport(outputPath, value) {
  if (typeof outputPath !== 'string' || !outputPath) {
    throw new Error('writeJsonReport: an explicit outputPath is required');
  }
  writeFileSync(outputPath, prettyStableJson(value) + '\n', 'utf8');
}
