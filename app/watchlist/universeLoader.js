import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {'core'|'growth'|'high_premium'|'etf'} UniverseCategory */

const FILE_BY_CATEGORY = {
  core: "universe.core.json",
  growth: "universe.growth.json",
  high_premium: "universe.high_premium.json",
  etf: "universe.etf.json",
};

function universeDir() {
  return join(__dirname, "..", "..", "data", "universe");
}

/**
 * @param {UniverseCategory} category
 * @returns {unknown}
 */
function readCategoryFile(category) {
  const filename = FILE_BY_CATEGORY[category];
  if (!filename) throw new Error(`unknown universe category: ${category}`);
  const path = join(universeDir(), filename);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/**
 * @param {unknown} data
 * @returns {{ symbol: string, enabled: boolean }[]}
 */
function normalizeRows(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    if (typeof item === "string" && item.trim()) {
      out.push({ symbol: item.trim().toUpperCase(), enabled: true });
      continue;
    }
    if (item && typeof item === "object" && typeof item.symbol === "string") {
      const sym = item.symbol.trim().toUpperCase();
      if (!sym) continue;
      const enabled = item.enabled !== false;
      out.push({ symbol: sym, enabled });
    }
  }
  return out;
}

/**
 * Fusionne les fichiers demandés, dédoublonne par symbole (première catégorie dans l’ordre de `categories` gagne).
 *
 * @param {{ categories: UniverseCategory[] }} params
 * @returns {{ symbol: string, category: UniverseCategory, enabled: boolean }[]}
 */
export function loadMergedUniverse({ categories }) {
  const seen = new Set();
  /** @type {{ symbol: string, category: UniverseCategory, enabled: boolean }[]} */
  const merged = [];

  for (const category of categories) {
    const rows = normalizeRows(readCategoryFile(category));
    for (const row of rows) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      merged.push({ symbol: row.symbol, category, enabled: row.enabled });
    }
  }

  return merged;
}
