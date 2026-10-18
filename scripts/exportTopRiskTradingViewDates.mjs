/**
 * Mini-export TradingView — dates des clusters top-risk stricts.
 * Usage: node scripts/exportTopRiskTradingViewDates.mjs [chemin/vers/clusters-strict.csv]
 *
 * Entrée : dernier debug/top-risk-clusters-strict-TQQQ-*.csv
 * Sorties : debug/top-risk-tv-dates-TQQQ-{timestamp}.csv + .json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(__dirname, "..", "debug");

const MAX_EXPORT = 50;
const TOP_PRIORITY = 20;
const MIN_SCORE = 50;

const MAJOR_TOP_TYPES = new Set(["majeur", "extrême"]);

function findLatestStrictCsv() {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR)
    .filter((f) => f.match(/^top-risk-clusters-strict-TQQQ-.+\.csv$/))
    .sort()
    .reverse();
  return files[0] ? path.join(DEBUG_DIR, files[0]) : null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function toBool(v) {
  return String(v).toLowerCase() === "true";
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function passesFilter(row) {
  if (!toBool(row.isComparableTradingView)) return false;
  const span = toNum(row.clusterSpanDays);
  if (span == null || span > 21) return false;

  const score = toNum(row.clusterScore) ?? 0;
  if (score < MIN_SCORE) return false;

  const worstDrop = toNum(row.worstDrop) ?? 0;
  const topType = row.maxTopType ?? "";
  const hasMajorTop = MAJOR_TOP_TYPES.has(topType);
  const hasDeepDrop = worstDrop <= -0.2;

  if (!hasMajorTop && !hasDeepDrop) return false;

  const daily = toNum(row.dailyCount) ?? 0;
  const mtf = toNum(row.mtfCount) ?? 0;
  if (daily <= 0 && mtf <= 0) return false;

  const families = (row.families ?? "").split("|").filter(Boolean);
  if (families.length < 2) return false;

  return true;
}

function sortKey(row) {
  const score = toNum(row.clusterScore) ?? 0;
  const worstDrop = toNum(row.worstDrop) ?? 0;
  const span = toNum(row.clusterSpanDays) ?? 99;
  const mtf = toNum(row.mtfCount) ?? 0;
  const sig = toNum(row.signalCount) ?? 0;
  return { score, worstDrop, span, mtf, sig };
}

function compareRows(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (kb.score !== ka.score) return kb.score - ka.score;
  if (ka.worstDrop !== kb.worstDrop) return ka.worstDrop - kb.worstDrop;
  if (ka.span !== kb.span) return ka.span - kb.span;
  if (kb.mtf !== ka.mtf) return kb.mtf - ka.mtf;
  return kb.sig - ka.sig;
}

function dominantSignals(signalNamesStr, limit = 3) {
  const names = (signalNamesStr ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.slice(0, limit).join(" | ");
}

function buildComment(row) {
  const parts = [];
  const span = toNum(row.clusterSpanDays);
  const score = toNum(row.clusterScore);
  const top = row.maxTopType || "—";
  const drop = pct(toNum(row.worstDrop));
  const delay = row.delayToMaxDrop;
  const differ = toBool(row.primaryDatesDiffer);

  parts.push(`Fenêtre ${span ?? "?"}j, score ${score ?? "?"}`);
  parts.push(`top ${top}, drop futur ${drop}`);
  if (delay != null && delay !== "") parts.push(`délai drop ${delay}j`);
  if (differ) {
    parts.push(`pic signaux ${row.primaryDatePeak} / drop ${row.primaryDateWorstDrop}`);
  }
  parts.push("date finale = pire drop (tops réels TV)");
  return parts.join(" — ");
}

function mapExportRow(row, rank, isPriority) {
  const primaryDateFinal = row.primaryDateWorstDrop || row.primaryDatePeak;
  return {
    rank,
    isTop20Priority: isPriority,
    primaryDatePeak: row.primaryDatePeak,
    primaryDateWorstDrop: row.primaryDateWorstDrop,
    primaryDateFinal,
    primaryDatesDiffer: toBool(row.primaryDatesDiffer),
    windowStart: row.startDate,
    windowEnd: row.endDate,
    clusterSpanDays: toNum(row.clusterSpanDays),
    score: toNum(row.clusterScore),
    topTypeMax: row.maxTopType,
    worstFutureDrop: toNum(row.worstDrop),
    worstFutureDropPct: pct(toNum(row.worstDrop)),
    daysToWorstDrop: toNum(row.delayToMaxDrop),
    eventCount: toNum(row.eventCount),
    dailyCount: toNum(row.dailyCount),
    weeklyCount: toNum(row.weeklyCount),
    mtfCount: toNum(row.mtfCount),
    families: row.families?.replace(/\|/g, ", ") ?? "",
    dominantSignals: dominantSignals(row.signalNames),
    comment: buildComment(row),
  };
}

function main() {
  const argPath = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
  const csvPath = argPath ? path.resolve(argPath) : findLatestStrictCsv();
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("CSV strict introuvable. Lancer clusterTopRiskEventsStrict.mjs d'abord.");
    process.exit(1);
  }

  const allRows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const filtered = allRows.filter(passesFilter).sort(compareRows);
  const top50 = filtered.slice(0, MAX_EXPORT);
  const top20 = top50.slice(0, TOP_PRIORITY);

  const export50 = top50.map((r, i) => mapExportRow(r, i + 1, i < TOP_PRIORITY));
  const export20 = export50.filter((r) => r.isTop20Priority);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(DEBUG_DIR, `top-risk-tv-dates-TQQQ-${ts}.json`);
  const csvOutPath = path.join(DEBUG_DIR, `top-risk-tv-dates-TQQQ-${ts}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceStrictCsv: csvPath,
    strictClustersRead: allRows.length,
    filteredCount: filtered.length,
    exportedCount: export50.length,
    top20PriorityCount: export20.length,
    filters: {
      isComparableTradingView: true,
      clusterSpanDaysMax: 21,
      topTypeOrDrop: "majeur|extrême OR worstDrop <= -20%",
      minScore: MIN_SCORE,
      minFamilies: 2,
      requiresDailyOrMtf: true,
    },
    primaryDateFinalRule: "primaryDateWorstDrop (comparaison tops réels TradingView)",
    top20Priority: export20,
    top50Export: export50,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const csvCols = [
    "rank",
    "isTop20Priority",
    "primaryDatePeak",
    "primaryDateWorstDrop",
    "primaryDateFinal",
    "primaryDatesDiffer",
    "windowStart",
    "windowEnd",
    "clusterSpanDays",
    "score",
    "topTypeMax",
    "worstFutureDrop",
    "worstFutureDropPct",
    "daysToWorstDrop",
    "eventCount",
    "dailyCount",
    "weeklyCount",
    "mtfCount",
    "families",
    "dominantSignals",
    "comment",
  ];

  const esc = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csvBody = export50.map((r) => csvCols.map((c) => esc(r[c])).join(",")).join("\n");
  fs.writeFileSync(csvOutPath, `${csvCols.join(",")}\n${csvBody}`, "utf8");

  console.log("=== EXPORT TRADINGVIEW — TOP-RISK STRICTS TQQQ ===\n");
  console.log(`Source : ${csvPath}`);
  console.log(`Clusters stricts lus : ${allRows.length}`);
  console.log(`Après filtre TV : ${filtered.length}`);
  console.log(`Dates exportées (top ${MAX_EXPORT}) : ${export50.length}`);
  console.log(`Top ${TOP_PRIORITY} prioritaire : ${export20.length}`);
  console.log(`Règle primaryDateFinal : primaryDateWorstDrop (tops réels)\n`);

  console.log(`${"=".repeat(72)}`);
  console.log(`TOP ${TOP_PRIORITY} DATES TRADINGVIEW`);
  console.log(`${"=".repeat(72)}`);
  for (const r of export20) {
    const dateNote = r.primaryDatesDiffer
      ? `finale ${r.primaryDateFinal} (pic ${r.primaryDatePeak})`
      : `finale ${r.primaryDateFinal}`;
    console.log(`\n#${r.rank} ${dateNote}`);
    console.log(`  Fenêtre : ${r.windowStart} → ${r.windowEnd} (${r.clusterSpanDays} j)`);
    console.log(`  Drop : ${r.worstFutureDropPct} | délai ${r.daysToWorstDrop ?? "—"} j | score ${r.score} | top ${r.topTypeMax}`);
    console.log(`  Signaux : ${r.dominantSignals}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  CSV  : ${csvOutPath}`);
  console.log(`  JSON : ${jsonPath}`);
}

main();
