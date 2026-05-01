import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {'core'|'growth'|'high_premium'|'etf'|'weekly'} UniverseCategory */

const FILE_BY_CATEGORY = {
  core: "universe.core.json",
  growth: "universe.growth.json",
  high_premium: "universe.high_premium.json",
  etf: "universe.etf.json",
  weekly: "weekly_eligible_tradingview.txt",
};

const MASTER_FILENAME = "universe.master.json";

/** Ordre préféré pour attribuer une catégorie quand plusieurs matchent. */
const CATEGORY_PREFERENCE = /** @type {const UniverseCategory[]} */ ([
  "weekly",
  "core",
  "growth",
  "high_premium",
  "etf",
]);

function universeDir() {
  return join(__dirname, "..", "..", "data", "universe");
}

function masterPath() {
  return join(universeDir(), MASTER_FILENAME);
}

/**
 * weekly → source weekly ou tag weekly_options
 * @param {UniverseCategory} cat
 * @param {{ sources?: unknown, tags?: unknown }} row
 */
function matchesRequestedCategory(cat, row) {
  const sources = Array.isArray(row.sources)
    ? row.sources.map((s) => String(s).trim().toLowerCase())
    : [];
  const tags = Array.isArray(row.tags)
    ? row.tags.map((s) => String(s).trim().toLowerCase())
    : [];

  const hasSource = (id) => sources.includes(id);
  const hasTag = (id) => tags.includes(id);

  switch (cat) {
    case "weekly":
      return hasSource("weekly") || hasTag("weekly_options");
    case "core":
      return hasSource("core") || hasTag("core");
    case "growth":
      return hasSource("growth") || hasTag("growth");
    case "high_premium":
      return hasSource("high_premium") || hasTag("high_premium");
    case "etf":
      return hasSource("etf") || hasTag("etf");
    default:
      return false;
  }
}

/**
 * @param {{ sources?: unknown, tags?: unknown }} row
 * @returns {UniverseCategory}
 */
function inferPrimaryCategory(row) {
  for (const c of CATEGORY_PREFERENCE) {
    if (matchesRequestedCategory(c, row)) return c;
  }
  if (Array.isArray(row.sources) && row.sources.length > 0) {
    const raw = String(row.sources[0]).trim();
    const lower = raw.toLowerCase();
    const byLower = CATEGORY_PREFERENCE.find((c) => c.toLowerCase() === lower);
    if (byLower) return byLower;
  }
  return "core";
}

/**
 * @param {{ categories?: UniverseCategory[] }} [params]
 * @returns {{ symbol: string, category: UniverseCategory, enabled: boolean, sources: string[], tags: string[] }[] | null}
 * null si le master est absent ou illisible (utiliser le fallback legacy).
 */
export function loadMasterUniverse({ categories } = {}) {
  const path = masterPath();
  if (!existsSync(path)) return null;

  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  if (!Array.isArray(data)) return null;

  /** @typedef {{ symbol: string, enabled?: boolean, excluded?: boolean, sources?: unknown, tags?: unknown }} MasterRow */

  /** @type {MasterRow[]} */
  const rowsActive = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || typeof item.symbol !== "string") continue;
    const symbol = item.symbol.trim().toUpperCase();
    if (!symbol) continue;
    if (item.enabled !== true) continue;
    if (item.excluded === true) continue;
    rowsActive.push({
      symbol,
      sources: item.sources,
      tags: item.tags,
    });
  }

  const cats = Array.isArray(categories) ? categories.filter(Boolean) : [];

  /** @type {{ symbol: string, category: UniverseCategory, enabled: boolean, sources: string[], tags: string[] }[]} */
  const out = [];

  if (cats.length === 0) {
    for (const row of rowsActive) {
      const sources = Array.isArray(row.sources)
        ? row.sources.map((s) => String(s).trim())
        : [];
      const tags = Array.isArray(row.tags)
        ? row.tags.map((s) => String(s).trim())
        : [];
      out.push({
        symbol: row.symbol.trim().toUpperCase(),
        category: inferPrimaryCategory(row),
        enabled: true,
        sources,
        tags,
      });
    }
    return out;
  }

  const seen = new Set();
  for (const category of cats) {
    if (!category) continue;
    for (const row of rowsActive) {
      const symbol = row.symbol.trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      if (!matchesRequestedCategory(category, row)) continue;
      seen.add(symbol);
      const sources = Array.isArray(row.sources)
        ? row.sources.map((s) => String(s).trim())
        : [];
      const tags = Array.isArray(row.tags)
        ? row.tags.map((s) => String(s).trim())
        : [];
      out.push({
        symbol,
        category,
        enabled: true,
        sources,
        tags,
      });
    }
  }

  return out;
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
  if (filename.endsWith(".txt")) return raw;
  return JSON.parse(raw);
}

/**
 * @param {unknown} data
 * @returns {{ symbol: string, enabled: boolean }[]}
 */
function normalizeRows(data) {
  if (typeof data === "string") {
    return data
      .split(/[\s,]+/)
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
      .map((symbol) => ({ symbol, enabled: true }));
  }

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

/** Ancienne fusion par fichiers (fallback). */
function loadMergedUniverseLegacy({ categories }) {
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

/**
 * Fusionne les fichiers demandés, dédoublonne par symbole (première catégorie dans l’ordre de `categories` gagne).
 * Si universe.master.json est présent et valide → source master filtrée.
 * Sinon → fichiers legacy par catégorie.
 *
 * @param {{ categories: UniverseCategory[] }} params
 * @returns {{ symbol: string, category: UniverseCategory, enabled: boolean, sources?: string[], tags?: string[] }[]}
 */
export function loadMergedUniverse({ categories }) {
  const fromMaster = loadMasterUniverse({ categories });
  if (fromMaster !== null) {
    console.warn(`Universe loaded from master: ${fromMaster.length} symbols enabled`);
    return fromMaster;
  }

  console.warn("Universe master unavailable, using legacy universe files");
  return loadMergedUniverseLegacy({ categories });
}
