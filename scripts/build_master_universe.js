/**
 * Génère data/universe/universe.master.json en fusionnant les listes existantes.
 * Ne modifie pas les fichiers sources.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const UNIVERSE_DIR = join(ROOT, "data", "universe");

/** @typedef {"weekly"|"core"|"growth"|"high_premium"|"etf"} SourceId */

/** @type {{ id: SourceId, file: string, type: "json"|"txt" }[]} */
const SOURCE_DEFS = [
  { id: "core", file: "universe.core.json", type: "json" },
  { id: "growth", file: "universe.growth.json", type: "json" },
  { id: "high_premium", file: "universe.high_premium.json", type: "json" },
  { id: "etf", file: "universe.etf.json", type: "json" },
  { id: "weekly", file: "weekly_eligible_tradingview.txt", type: "txt" },
];

const SOURCE_ORDER = ["core", "etf", "growth", "high_premium", "weekly"];

const WHITELIST = new Set(["TQQQ"]);

/** ETF levier / inverse / volatilité — TQQQ n’est pas inclus (whitelist séparée). */
const LEVERAGED_EXCLUDE = new Set(
  `
AGQ,AMDL,BOIL,CONL,DPST,FAS,LABU,METU,NAIL,NUGT,SCO,SOXL,SOXS,SPXL,SPXS,SPXU,SQQQ,SSO,
TMF,TNA,TSLL,UPRO,UVIX,VXX,YINN,NVDL,NVDX,MSTU,TECL,TECS,FNGU,FNGD,LABD,TZA,ERX,ERY,DRIP,
GUSH,KOLD
`
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.toUpperCase())
);

const CRYPTO_LEVERAGE_EXCLUDE = new Set(
  ["BITX", "BITU", "BITI", "ETHU", "ETHD", "MSTZ"].map((s) => s.toUpperCase())
);

const PUMP_EXCLUDE = new Set(
  `
BBAI,FSR,GOEV,MULN,NKLA,BYND,AMC,GME,CLOV,BKKT,ASTS,ASST,BULL,ABTC,KEEL,ABVX,FRMI,FIGR,
GEMI,KLAR,NMAX,NUAI,ORBS,PONY,RZLV,SBET,GRRR,RCAT,ONDS,AMPX,KOPN,LAES,LASR,MNKD,LUNR,NB,
POET,PTON
`
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.toUpperCase())
);

/** Quantum hype exclu — IONQ exclu de ce set exprès. */
const QUANTUM_HYPE_EXCLUDE = new Set(["QBTS", "RGTI", "SOUN", "QUBT"].map((s) => s.toUpperCase()));

/**
 * Étiquettes levier pour tagging (dont TQQQ pour affichage, sans exclusion automatique).
 * @returns {boolean}
 */
function matchesLeveragedEtfTag(symbol) {
  if (WHITELIST.has(symbol) && symbol === "TQQQ") return true;
  return LEVERAGED_EXCLUDE.has(symbol);
}

/**
 * Raison d’exclusion par priorité.
 * @param {string} symbol
 * @returns {"leveraged_etf"|"crypto_leverage"|"pump_ultra_speculative"|"quantum_hype"|null}
 */
function pickExcludeReason(symbol) {
  if (WHITELIST.has(symbol)) return null;
  if (LEVERAGED_EXCLUDE.has(symbol)) return "leveraged_etf";
  if (CRYPTO_LEVERAGE_EXCLUDE.has(symbol)) return "crypto_leverage";
  if (PUMP_EXCLUDE.has(symbol)) return "pump_ultra_speculative";
  if (QUANTUM_HYPE_EXCLUDE.has(symbol)) return "quantum_hype";
  return null;
}

/**
 * Tag source pour le fichier weekly → weekly_options dans les tags.
 * @param {SourceId} id
 * @returns {string | null}
 */
function tagFromSource(id) {
  if (id === "weekly") return "weekly_options";
  return id;
}

/**
 * @param {unknown} data
 * @returns {{ rows: { symbol: string, enabledFromSource: boolean }[], rawCount: number }}
 */
function readJsonSource(data) {
  if (!Array.isArray(data))
    return { rows: [], rawCount: 0 };
  /** @type {{ symbol: string, enabledFromSource: boolean }[]} */
  const rows = [];
  let rawCount = 0;
  for (const item of data) {
    rawCount += 1;
    let symbol = "";
    let enabledFromSource = true;
    if (typeof item === "string" && item.trim()) {
      symbol = item.trim().toUpperCase();
    } else if (item && typeof item === "object" && typeof item.symbol === "string") {
      symbol = item.symbol.trim().toUpperCase();
      enabledFromSource = item.enabled !== false;
    } else continue;
    if (!symbol) continue;
    rows.push({ symbol, enabledFromSource });
  }
  return { rows, rawCount };
}

/**
 * @param {string} text
 */
function readTxtSource(text) {
  const symbols = text
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const rows = symbols.map((symbol) => ({ symbol, enabledFromSource: true }));
  return { rows, rawCount: symbols.length };
}

/**
 * @param {SourceId} id
 * @param {string} filePath
 */
function loadSourceRows(id, filePath) {
  const raw = readFileSync(filePath, "utf8");
  if (id === "weekly") {
    return readTxtSource(raw);
  }
  return readJsonSource(JSON.parse(raw));
}

function main() {
  let totalRawRows = 0;
  /** symbol -> SourceId[] (ordre d’insertion puis tri) */
  const sourcesMap = new Map();
  /** symbol -> any explicit disable from a source row */
  const disabledBySymbol = new Map();

  for (const def of SOURCE_DEFS) {
    const pathAbs = join(UNIVERSE_DIR, def.file);
    const { rows, rawCount } = loadSourceRows(def.id, pathAbs);
    totalRawRows += rawCount;

    for (const row of rows) {
      const sym = row.symbol;
      if (!sourcesMap.has(sym)) sourcesMap.set(sym, []);

      /** @type {SourceId[]} */
      const arr = sourcesMap.get(sym);
      if (!arr.includes(def.id)) arr.push(def.id);

      if (!row.enabledFromSource) disabledBySymbol.set(sym, true);
      else if (!disabledBySymbol.has(sym)) disabledBySymbol.set(sym, false);
    }
  }

  const symbolsSorted = [...sourcesMap.keys()].sort((a, b) => a.localeCompare(b));
  const totalUniqueSymbols = symbolsSorted.length;

  /** @typedef {{symbol: string, count: number, sources: SourceId[]} } DupEntry */
  /** @type DupEntry[] */
  const dupEntries = [];
  for (const sym of symbolsSorted) {
    const src = sourcesMap.get(sym) ?? [];
    if (src.length > 1) dupEntries.push({ symbol: sym, count: src.length, sources: sortSources(src) });
  }
  dupEntries.sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol));

  /** @type {object[]} */
  const master = [];

  for (const symbol of symbolsSorted) {
    const sources = sortSources(sourcesMap.get(symbol) ?? []);
    /** @type {Set<string>} */
    const tags = new Set();
    for (const sid of sources) {
      const t = tagFromSource(sid);
      if (t) tags.add(t);
    }

    if (matchesLeveragedEtfTag(symbol)) tags.add("leveraged_etf");
    if (CRYPTO_LEVERAGE_EXCLUDE.has(symbol)) tags.add("crypto_leverage");
    if (PUMP_EXCLUDE.has(symbol)) tags.add("pump");
    if (symbol === "IONQ") tags.add("quantum");

    if (WHITELIST.has(symbol)) tags.add("whitelisted");

    const excludeReasonRaw = WHITELIST.has(symbol) ? null : pickExcludeReason(symbol);
    const excluded = !WHITELIST.has(symbol) && excludeReasonRaw != null;

    let enabled;
    if (WHITELIST.has(symbol)) {
      enabled = true;
    } else if (excluded) {
      enabled = false;
    } else {
      enabled = !(disabledBySymbol.get(symbol) === true);
    }

    const excludeReason = WHITELIST.has(symbol) ? null : excludeReasonRaw;

    master.push({
      symbol,
      enabled,
      excluded: WHITELIST.has(symbol) ? false : excluded,
      excludeReason,
      sources,
      tags: [...tags].sort((a, b) => a.localeCompare(b)),
    });
  }

  const outPath = join(UNIVERSE_DIR, "universe.master.json");
  writeFileSync(outPath, `${JSON.stringify(master, null, 2)}\n`, "utf8");

  const totalEnabled = master.filter((r) => r.enabled).length;
  const totalExcluded = master.filter((r) => r.excluded).length;

  /** @type {Record<string, number>} */
  const excludedByReason = {};
  for (const row of master) {
    if (!row.excluded || !row.excludeReason) continue;
    excludedByReason[row.excludeReason] = (excludedByReason[row.excludeReason] || 0) + 1;
  }

  const whitelistedArr = [...WHITELIST];

  console.log("=== universe.master.json ===");
  console.log("");
  console.log(`Output: ${outPath}`);
  console.log(`totalRawRows: ${totalRawRows}`);
  console.log(`totalUniqueSymbols: ${totalUniqueSymbols}`);
  console.log(`totalEnabled: ${totalEnabled}`);
  console.log(`totalExcluded: ${totalExcluded}`);
  console.log("excludedByReason:", excludedByReason);
  console.log("tickers whitelisted:", whitelistedArr);
  console.log("");
  console.log("Top duplicated symbols (par nombre de sources):");
  for (const row of dupEntries.slice(0, 25)) {
    console.log(`  ${row.symbol} ×${row.count} (${row.sources.join(", ")})`);
  }
  if (dupEntries.length > 25) console.log(`  … +${dupEntries.length - 25} autres`);

  confirmChecks(master);
}

/**
 * @param {SourceId[]} ids
 */
function sortSources(ids) {
  const order = SOURCE_ORDER.reduce((acc, sid, idx) => {
    acc[sid] = idx;
    return acc;
  }, {});
  return [...ids].sort((a, b) => (order[a] ?? 999) - (order[b] ?? 999));
}

/**
 * Sanity checks utilisateur.
 * @param {{symbol: string}[]} master
 */
function confirmChecks(master) {
  console.log("");
  console.log("=== validations rapides ===");
  const req = /** @type {Record<string, (r: Record<string, unknown>) => boolean>} */ ({
    "TQQQ present": () => !!getRow(master, "TQQQ"),
    "TQQQ enabled": () => getRow(master, "TQQQ")?.enabled === true,
    "TQQQ not excluded": () => getRow(master, "TQQQ")?.excluded === false,
    "TQQQ whitelisted tag": () => getRow(master, "TQQQ")?.tags?.includes("whitelisted"),
    "SOXL excluded": () => getRow(master, "SOXL")?.excluded === true,
    "BITX excluded": () => getRow(master, "BITX")?.excluded === true,
    "BULL excluded": () => getRow(master, "BULL")?.excluded === true,
    "ASST excluded": () => getRow(master, "ASST")?.excluded === true,
    "GME excluded": () => getRow(master, "GME")?.excluded === true,
    "AMC excluded": () => getRow(master, "AMC")?.excluded === true,
    "IONQ present": () => !!getRow(master, "IONQ"),
    "IONQ enabled": () => getRow(master, "IONQ")?.enabled === true,
    "IONQ not excluded": () => getRow(master, "IONQ")?.excluded === false,
    "IONQ no excludeReason": () => getRow(master, "IONQ")?.excludeReason == null,
    "IONQ quantum tag": () => getRow(master, "IONQ")?.tags?.includes("quantum"),
  });
  for (const [label, fn] of Object.entries(req)) {
    const ok = fn();
    console.log(`${ok ? "OK" : "FAIL"}  ${label}`);
  }
}

/**
 * @param {object[]} master
 * @param {string} symbol
 */
function getRow(master, symbol) {
  return master.find((r) => r.symbol === symbol);
}

main();
