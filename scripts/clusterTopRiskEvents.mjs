/**
 * Regroupe les dates top-risk en clusters exploitables.
 * Usage: node scripts/clusterTopRiskEvents.mjs [chemin/vers/dates.csv]
 *
 * Entrée : dernier debug/top-risk-signal-dates-TQQQ-*.csv
 * Sorties : debug/top-risk-clusters-TQQQ-{timestamp}.csv + .json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(__dirname, "..", "debug");

const WINDOW_DAILY_CAL_DAYS = 14;
const WINDOW_WEEKLY_CAL_DAYS = 21;

const TOP_RANK = {
  aucun: 0,
  "très court": 1,
  court: 2,
  swing: 3,
  moyen: 4,
  majeur: 5,
  extrême: 6,
};

const FAMILIES = [
  { key: "rsi_momentum", re: /rsi|stoch|macd|momentum|ret\d|ret8|ret10|ret12/i },
  { key: "extension", re: /sma|ma50|ma21|extension|étiré|bb sup|bollinger/i },
  { key: "break", re: /sous sma|casse|break/i },
  { key: "volume", re: /vol|volume|spike/i },
  { key: "candle", re: /mèche|engulf|star|distribution|chandelier/i },
  { key: "weekly_context", re: /^W |weekly|mtf_/i },
];

function findLatestDatesCsv() {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR)
    .filter((f) => f.match(/^top-risk-signal-dates-TQQQ-.+\.csv$/))
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
    if (row.error?.trim()) continue;
    row.dateMs = new Date(row.date).getTime();
    if (Number.isNaN(row.dateMs)) continue;
    row.closeNum = toNum(row.close);
    row.worstDropNum = toNum(row.worstDrop);
    row.drop40 = toNum(row.drop40or16w);
    row.drop20 = toNum(row.drop20or12w);
    row.delayMax = Math.max(toNum(row.delay20or12w) ?? 0, toNum(row.delay5or4w) ?? 0) || null;
    rows.push(row);
  }
  return rows;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mergeGapDays(a, b) {
  const gap = Math.abs(a.dateMs - b.dateMs) / 86_400_000;
  const useWeekly = a.timeframe === "weekly" || b.timeframe === "weekly";
  const limit = useWeekly ? WINDOW_WEEKLY_CAL_DAYS : WINDOW_DAILY_CAL_DAYS;
  return gap <= limit;
}

function unionFindCluster(rows) {
  const n = rows.length;
  const parent = rows.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (mergeGapDays(rows[i], rows[j])) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(rows[i]);
  }
  return [...groups.values()];
}

function parseTopTypes(topTypeStr) {
  if (!topTypeStr || topTypeStr === "aucun") return [];
  return topTypeStr.split("+").map((s) => s.trim()).filter(Boolean);
}

function maxTopType(types) {
  let best = "aucun";
  let rank = 0;
  for (const t of types) {
    const r = TOP_RANK[t] ?? 0;
    if (r > rank) { rank = r; best = t; }
  }
  return best;
}

function detectFamilies(signalName, signalId, timeframe) {
  const text = `${signalName} ${signalId} ${timeframe}`;
  return FAMILIES.filter((f) => f.re.test(text)).map((f) => f.key);
}

function buildCluster(events) {
  const sorted = [...events].sort((a, b) => a.dateMs - b.dateMs);
  const dates = sorted.map((e) => e.date);
  const startDate = dates[0];
  const endDate = dates.at(-1);

  const byTf = { daily: 0, weekly: 0, mtf: 0 };
  const signalSet = new Map();
  const allTopTypes = [];
  const families = new Set();
  let worstDrop = 0;
  let bestDropEvent = sorted[0];
  let delayAtWorst = null;

  for (const e of sorted) {
    byTf[e.timeframe] = (byTf[e.timeframe] ?? 0) + 1;
    const sigKey = e.signalId || e.signalName;
    if (!signalSet.has(sigKey)) {
      signalSet.set(sigKey, { signalId: e.signalId, signalName: e.signalName, count: 0, timeframes: new Set() });
    }
    const s = signalSet.get(sigKey);
    s.count += 1;
    s.timeframes.add(e.timeframe);
    for (const t of parseTopTypes(e.topType)) allTopTypes.push(t);
    for (const f of detectFamilies(e.signalName, e.signalId, e.timeframe)) families.add(f);
    const wd = e.worstDropNum ?? 0;
    if (wd < worstDrop) {
      worstDrop = wd;
      bestDropEvent = e;
      delayAtWorst = e.delayMax;
    }
  }

  const midIdx = Math.floor(sorted.length / 2);
  const centralEvent = sorted[midIdx];
  const closeAtCentral = centralEvent.closeNum;
  const closes = sorted.map((e) => e.closeNum).filter((c) => c != null);
  const avgClose = closes.length ? closes.reduce((s, c) => s + c, 0) / closes.length : null;

  const maxTopTypeLabel = maxTopType(allTopTypes);
  const hasMajor = allTopTypes.includes("majeur") || allTopTypes.includes("extrême");
  const hasExtreme = allTopTypes.includes("extrême");

  const uniqueSignals = [...signalSet.values()].map((s) => ({
    signalId: s.signalId,
    signalName: s.signalName,
    count: s.count,
    timeframes: [...s.timeframes],
  }));

  const score = computeClusterScore({
    eventCount: sorted.length,
    signalCount: uniqueSignals.length,
    byTf,
    families: [...families],
    hasMajor,
    hasExtreme,
    hasMtf: byTf.mtf > 0,
    hasDailyWeekly: byTf.daily > 0 && byTf.weekly > 0,
    worstDrop,
    maxTopTypeLabel,
  });

  const isMajorForTv =
    hasMajor ||
    hasExtreme ||
    worstDrop <= -0.2 ||
    (sorted.length >= 3 && byTf.mtf > 0);

  return {
    startDate,
    endDate,
    centralDate: centralEvent.date,
    primaryDate: bestDropEvent.date,
    eventCount: sorted.length,
    signalCount: uniqueSignals.length,
    dailyCount: byTf.daily ?? 0,
    weeklyCount: byTf.weekly ?? 0,
    mtfCount: byTf.mtf ?? 0,
    signals: uniqueSignals,
    signalNames: uniqueSignals.map((s) => s.signalName),
    closeCentral: closeAtCentral,
    closeAvg: avgClose,
    closeAtWorstDrop: bestDropEvent.closeNum,
    worstDrop,
    delayToMaxDrop: delayAtWorst,
    maxTopType: maxTopTypeLabel,
    topTypesSeen: [...new Set(allTopTypes)],
    families: [...families],
    clusterScore: score,
    isMajorForTradingView: isMajorForTv,
    events: sorted.map((e) => ({
      date: e.date,
      signalName: e.signalName,
      timeframe: e.timeframe,
      topType: e.topType,
      worstDrop: e.worstDropNum,
    })),
  };
}

function computeClusterScore({
  eventCount,
  signalCount,
  byTf,
  families,
  hasMajor,
  hasExtreme,
  hasMtf,
  hasDailyWeekly,
  worstDrop,
}) {
  let score = 0;
  if (hasMtf) score += 25;
  if (hasDailyWeekly) score += 20;
  if (byTf.daily > 0) score += 5;
  if (byTf.weekly > 0) score += 8;
  if (hasExtreme) score += 30;
  else if (hasMajor) score += 22;
  if (worstDrop <= -0.4) score += 25;
  else if (worstDrop <= -0.25) score += 18;
  else if (worstDrop <= -0.15) score += 10;
  score += Math.min(25, families.length * 5);
  score += Math.min(20, signalCount * 3);
  score += Math.min(15, Math.log2(eventCount + 1) * 4);
  if (eventCount === 1 && signalCount === 1) score -= 25;
  else if (eventCount <= 2 && signalCount <= 1) score -= 12;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  const argPath = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
  const csvPath = argPath ? path.resolve(argPath) : findLatestDatesCsv();
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("CSV introuvable. Lancer extractTopRiskSignalDates.mjs d'abord.");
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const rawGroups = unionFindCluster(rows);
  const clusters = rawGroups
    .map(buildCluster)
    .sort((a, b) => b.clusterScore - a.clusterScore);

  const majorTv = clusters
    .filter((c) => c.isMajorForTradingView)
    .sort((a, b) => {
      const dropDiff = (a.worstDrop ?? 0) - (b.worstDrop ?? 0);
      if (dropDiff !== 0) return dropDiff;
      return b.clusterScore - a.clusterScore;
    });

  const top50 = clusters.slice(0, 50);
  const top20Major = majorTv.slice(0, 20);

  console.log("=== CLUSTERS TOP-RISK TQQQ ===\n");
  console.log(`Source : ${csvPath}`);
  console.log(`Lignes originales : ${rows.length}`);
  console.log(`Clusters créés : ${clusters.length}`);
  console.log(`Clusters majeurs (filtre TradingView) : ${majorTv.length}`);
  console.log(`Fenêtres : daily/mtf ≈ ${WINDOW_DAILY_CAL_DAYS} j. cal. | weekly ≈ ${WINDOW_WEEKLY_CAL_DAYS} j. cal.\n`);

  console.log(`${"=".repeat(72)}`);
  console.log("TOP 20 CLUSTERS MAJEURS — À COMPARER AUX FLÈCHES TRADINGVIEW");
  console.log(`${"=".repeat(72)}`);
  for (const c of top20Major) {
    console.log(`\n# Score ${c.clusterScore} | ${c.startDate} → ${c.endDate} (centre ${c.centralDate})`);
    console.log(`  Signaux : ${c.signalCount} types | événements : ${c.eventCount} | D${c.dailyCount} W${c.weeklyCount} MTF${c.mtfCount}`);
    console.log(`  Close centre ${c.closeCentral?.toFixed?.(2) ?? "—"} | pire drop ${pct(c.worstDrop)} @ ${c.primaryDate} | top max : ${c.maxTopType}`);
    console.log(`  Familles : ${c.families.join(", ") || "—"}`);
    console.log(`  Liste : ${c.signalNames.slice(0, 8).join(" | ")}${c.signalNames.length > 8 ? " …" : ""}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("TOP 50 CLUSTERS (tous scores)");
  console.log(`${"=".repeat(72)}`);
  for (const c of top50) {
    console.log(
      `  [${c.clusterScore}] ${c.centralDate} (${c.startDate}→${c.endDate}) | n=${c.eventCount} sig=${c.signalCount} D${c.dailyCount}/W${c.weeklyCount}/M${c.mtfCount} | drop ${pct(c.worstDrop)} | ${c.maxTopType}${c.isMajorForTradingView ? " ★TV" : ""}`,
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(DEBUG_DIR, `top-risk-clusters-TQQQ-${ts}.json`);
  const csvOutPath = path.join(DEBUG_DIR, `top-risk-clusters-TQQQ-${ts}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceCsv: csvPath,
    originalRowCount: rows.length,
    clusterCount: clusters.length,
    majorClusterCount: majorTv.length,
    windowDays: { dailyCalDays: WINDOW_DAILY_CAL_DAYS, weeklyCalDays: WINDOW_WEEKLY_CAL_DAYS },
    top20MajorForTradingView: top20Major,
    top50Clusters: top50,
    allClusters: clusters,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const csvRows = clusters.map((c) => ({
    clusterScore: c.clusterScore,
    isMajorForTradingView: c.isMajorForTradingView,
    startDate: c.startDate,
    endDate: c.endDate,
    centralDate: c.centralDate,
    primaryDate: c.primaryDate,
    eventCount: c.eventCount,
    signalCount: c.signalCount,
    dailyCount: c.dailyCount,
    weeklyCount: c.weeklyCount,
    mtfCount: c.mtfCount,
    closeCentral: c.closeCentral,
    closeAvg: c.closeAvg,
    worstDrop: c.worstDrop,
    delayToMaxDrop: c.delayToMaxDrop,
    maxTopType: c.maxTopType,
    families: c.families.join("|"),
    signalNames: c.signalNames.join("|"),
  }));

  const hdr = Object.keys(csvRows[0] ?? {}).join(",");
  const body = csvRows.map((r) => Object.values(r).map((v) => String(v ?? "").replace(/,/g, ";")).join(",")).join("\n");
  fs.writeFileSync(csvOutPath, `${hdr}\n${body}`, "utf8");

  console.log(`\n${"=".repeat(72)}`);
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  JSON : ${jsonPath}`);
  console.log(`  CSV  : ${csvOutPath}`);
  console.log(`\nDates principales TradingView (top 10, tri par gravité drop) :`);
  for (const c of majorTv.slice(0, 10)) {
    console.log(`  ${c.centralDate} (fenêtre ${c.startDate} → ${c.endDate}) — score ${c.clusterScore} — ${c.signalCount} signaux`);
  }
}

main();
