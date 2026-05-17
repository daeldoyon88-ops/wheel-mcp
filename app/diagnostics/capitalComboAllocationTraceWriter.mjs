/**
 * Writer Node-only pour `capitalComboAllocationTraceV1` — jamais importé depuis le bundle Vite/dashboard.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** Horodatage lisible dossier fichier : ISO sans « : » (Windows-friendly). */
export function capitalComboAllocationTraceStampLocal(date = new Date()) {
  return date.toISOString().replace(/:/g, "-").slice(0, 19);
}

/**
 * @param {Record<string, unknown>} payload — `capitalComboAllocationTraceV1` depuis buildPortfolioCombos
 * @returns {string} chemin absolu du fichier écrit
 */
export function writeCapitalComboAllocationTraceFile(payload) {
  const debugDir = join(REPO_ROOT, "debug");
  mkdirSync(debugDir, { recursive: true });
  const name = `capital-combo-allocation-trace-${capitalComboAllocationTraceStampLocal()}.json`;
  const filepath = join(debugDir, name);
  writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
  return filepath;
}
