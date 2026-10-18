/**
 * Clusters top-risk STRICTS — fenêtres courtes, sans fusion transitive illimitée.
 * Usage: node scripts/clusterTopRiskEventsStrict.mjs [chemin/vers/dates.csv]
 *
 * Entrée : dernier debug/top-risk-signal-dates-TQQQ-*.csv
 * Sorties : debug/top-risk-clusters-strict-TQQQ-{timestamp}.csv + .json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = path.join(__dirname, "..", "debug");

/** Jours calendaires max pour lier deux événements (pas de chaîne illimitée). */
const LINK_DAILY_MTF_DAYS = 10;
const LINK_WEEKLY_DAYS = 14;
const LINK_MIXED_DAYS = 12;

/** Durée max d’un cluster (du premier au dernier événement). */
const MAX_SPAN_DAILY_MTF = 15;
const MAX_SPAN_WEEKLY = 28;
const MAX_SPAN_MIXED = 21;

/** Seuil « trop large » pour pénalité score / flag. */
const OVER_WIDE_THRESHOLD = 21;

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

function clusterComposition(events) {
  const hasWeekly = events.some((e) => e.timeframe === "weekly");
  const hasDaily = events.some((e) => e.timeframe === "daily");
  const hasMtf = events.some((e) => e.timeframe === "mtf");
  if (hasWeekly && !hasDaily && !hasMtf) return "weekly";
  if ((hasDaily || hasMtf) && !hasWeekly) return "daily_mtf";
  return "mixed";
}

function maxSpanDaysForComposition(comp) {
  if (comp === "weekly") return MAX_SPAN_WEEKLY;
  if (comp === "daily_mtf") return MAX_SPAN_DAILY_MTF;
  return MAX_SPAN_MIXED;
}

function linkGapDays(a, b) {
  const compA = a.timeframe === "weekly" ? "weekly" : a.timeframe === "mtf" ? "mtf" : "daily";
  const compB = b.timeframe === "weekly" ? "weekly" : b.timeframe === "mtf" ? "mtf" : "daily";
  if (compA === "weekly" && compB === "weekly") return LINK_WEEKLY_DAYS;
  if (compA !== "weekly" && compB !== "weekly") return LINK_DAILY_MTF_DAYS;
  return LINK_MIXED_DAYS;
}

function spanDays(events) {
  if (!events.length) return 0;
  const ms = events.map((e) => e.dateMs);
  return (Math.max(...ms) - Math.min(...ms)) / 86_400_000;
}

function minGapDays(row, clusterEvents) {
  let min = Infinity;
  for (const e of clusterEvents) {
    const g = Math.abs(row.dateMs - e.dateMs) / 86_400_000;
    if (g < min) min = g;
  }
  return min;
}

function minLinkRequired(row, clusterEvents) {
  let minLink = Infinity;
  for (const e of clusterEvents) {
    minLink = Math.min(minLink, linkGapDays(row, e));
  }
  return minLink;
}

/**
 * Clustering strict : chaque ajout doit respecter link + span max (pas de chaîne multi-mois).
 */
function greedyStrictClusters(rows) {
  const sorted = [...rows].sort((a, b) => a.dateMs - b.dateMs);
  const clusters = [];

  for (const row of sorted) {
    let best = null;
    let bestScore = -1;

    for (const c of clusters) {
      const gap = minGapDays(row, c.events);
      const linkNeed = minLinkRequired(row, c.events);
      if (gap > linkNeed) continue;

      const trial = [...c.events, row];
      const comp = clusterComposition(trial);
      const maxSpan = maxSpanDaysForComposition(comp);
      if (spanDays(trial) > maxSpan) continue;

      const score = c.events.length * 10 - gap;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) {
      best.events.push(row);
    } else {
      clusters.push({ events: [row], splitFromLargeCluster: false });
    }
  }

  return clusters;
}

/**
 * Scinde récursivement un groupe dont la durée dépasse le max autorisé.
 */
function splitOversizedCluster(events, inheritedSplit = false) {
  const sorted = [...events].sort((a, b) => a.dateMs - b.dateMs);
  const comp = clusterComposition(sorted);
  const maxSpan = maxSpanDaysForComposition(comp);
  const span = spanDays(sorted);

  if (span <= maxSpan) {
    return [{ events: sorted, splitFromLargeCluster: inheritedSplit }];
  }

  let bestIdx = -1;
  let bestGap = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = (sorted[i + 1].dateMs - sorted[i].dateMs) / 86_400_000;
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestGap >= 3) {
    const left = sorted.slice(0, bestIdx + 1);
    const right = sorted.slice(bestIdx + 1);
    return [
      ...splitOversizedCluster(left, true),
      ...splitOversizedCluster(right, true),
    ];
  }

  const out = [];
  let start = 0;
  for (let i = 0; i < sorted.length; i++) {
    const fromStart = (sorted[i].dateMs - sorted[start].dateMs) / 86_400_000;
    if (fromStart > maxSpan) {
      out.push(...splitOversizedCluster(sorted.slice(start, i), true));
      start = i;
    }
  }
  out.push(...splitOversizedCluster(sorted.slice(start), true));
  return out;
}

function strictClusterPipeline(rows) {
  const greedy = greedyStrictClusters(rows);
  const final = [];
  for (const g of greedy) {
    final.push(...splitOversizedCluster(g.events, false));
  }
  return final;
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

function dateWithMostSignals(events) {
  const byDate = new Map();
  for (const e of events) {
    byDate.set(e.date, (byDate.get(e.date) ?? 0) + 1);
  }
  let bestDate = events[0].date;
  let bestCount = 0;
  for (const [d, n] of byDate) {
    if (n > bestCount) {
      bestCount = n;
      bestDate = d;
    }
  }
  return { date: bestDate, count: bestCount };
}

function buildStrictCluster(events, meta = {}) {
  const sorted = [...events].sort((a, b) => a.dateMs - b.dateMs);
  const startDate = sorted[0].date;
  const endDate = sorted.at(-1).date;
  const clusterSpanDays = Math.round(spanDays(sorted) * 10) / 10;
  const composition = clusterComposition(sorted);
  const maxSpanAllowed = maxSpanDaysForComposition(composition);

  const byTf = { daily: 0, weekly: 0, mtf: 0 };
  const signalSet = new Map();
  const allTopTypes = [];
  const families = new Set();
  let worstDrop = 0;
  let worstDropEvent = sorted[0];

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
      worstDropEvent = e;
    }
  }

  const peak = dateWithMostSignals(sorted);
  const primaryDatePeak = peak.date;
  const primaryDateWorstDrop = worstDropEvent.date;
  const primaryDatesDiffer = primaryDatePeak !== primaryDateWorstDrop;

  const midIdx = Math.floor(sorted.length / 2);
  const centralDate = sorted[midIdx].date;
  const closes = sorted.map((e) => e.closeNum).filter((c) => c != null);
  const avgClose = closes.length ? closes.reduce((s, c) => s + c, 0) / closes.length : null;
  const closeAtPeak = sorted.find((e) => e.date === primaryDatePeak)?.closeNum ?? null;
  const closeAtWorst = worstDropEvent.closeNum;

  const maxTopTypeLabel = maxTopType(allTopTypes);
  const hasMajor = allTopTypes.includes("majeur") || allTopTypes.includes("extrême");
  const hasExtreme = allTopTypes.includes("extrême");

  const uniqueSignals = [...signalSet.values()].map((s) => ({
    signalId: s.signalId,
    signalName: s.signalName,
    count: s.count,
    timeframes: [...s.timeframes],
  }));

  const dominantSignalRatio = sorted.length > 0
    ? Math.max(...uniqueSignals.map((s) => s.count)) / sorted.length
    : 1;

  const isOverWideCluster = clusterSpanDays > OVER_WIDE_THRESHOLD
    || clusterSpanDays > maxSpanAllowed + 0.01;

  const score = computeStrictClusterScore({
    eventCount: sorted.length,
    signalCount: uniqueSignals.length,
    byTf,
    families: [...families],
    hasMajor,
    hasExtreme,
    hasMtf: byTf.mtf > 0,
    hasDailyWeekly: byTf.daily > 0 && byTf.weekly > 0,
    worstDrop,
    clusterSpanDays,
    isOverWideCluster,
    dominantSignalRatio,
    splitFromLargeCluster: meta.splitFromLargeCluster ?? false,
  });

  const isComparableTradingView =
    clusterSpanDays <= 21
    && families.size >= 2
    && (byTf.daily > 0 || byTf.mtf > 0)
    && (hasMajor || hasExtreme || worstDrop <= -0.2)
    && score >= 40;

  return {
    startDate,
    endDate,
    centralDate,
    primaryDatePeak,
    primaryDateWorstDrop,
    primaryDatesDiffer,
    primaryDate: primaryDateWorstDrop,
    clusterSpanDays,
    maxSpanAllowed,
    composition,
    isOverWideCluster,
    splitFromLargeCluster: meta.splitFromLargeCluster ?? false,
    eventCount: sorted.length,
    signalCount: uniqueSignals.length,
    dailyCount: byTf.daily ?? 0,
    weeklyCount: byTf.weekly ?? 0,
    mtfCount: byTf.mtf ?? 0,
    signals: uniqueSignals,
    signalNames: uniqueSignals.map((s) => s.signalName),
    closeAtPeak,
    closeAtWorstDrop: closeAtWorst,
    closeAvg: avgClose,
    worstDrop,
    delayToMaxDrop: worstDropEvent.delayMax,
    maxTopType: maxTopTypeLabel,
    families: [...families],
    clusterScore: score,
    isComparableTradingView,
    events: sorted.map((e) => ({
      date: e.date,
      signalName: e.signalName,
      timeframe: e.timeframe,
      topType: e.topType,
      worstDrop: e.worstDropNum,
    })),
  };
}

function computeStrictClusterScore({
  eventCount,
  signalCount,
  byTf,
  families,
  hasMajor,
  hasExtreme,
  hasMtf,
  hasDailyWeekly,
  worstDrop,
  clusterSpanDays,
  isOverWideCluster,
  dominantSignalRatio,
  splitFromLargeCluster,
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
  score += Math.min(18, signalCount * 3);
  score += Math.min(12, Math.log2(eventCount + 1) * 3);

  if (clusterSpanDays <= 10) score += 8;
  else if (clusterSpanDays <= 15) score += 4;
  else if (clusterSpanDays <= 21) score += 0;
  else score -= 15;

  if (isOverWideCluster) score -= 20;
  if (dominantSignalRatio >= 0.85 && signalCount <= 2) score -= 18;
  if (eventCount === 1 && signalCount === 1) score -= 25;
  else if (eventCount <= 2 && signalCount <= 1) score -= 10;
  if (splitFromLargeCluster && clusterSpanDays <= 21) score += 3;

  return Math.round(Math.max(0, Math.min(100, score)));
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

/** Comparaison rapide avec clustering loose (union-find). */
function looseClusterCount(rows) {
  const WINDOW_DAILY = 14;
  const WINDOW_WEEKLY = 21;
  function mergeGap(a, b) {
    const gap = Math.abs(a.dateMs - b.dateMs) / 86_400_000;
    const useWeekly = a.timeframe === "weekly" || b.timeframe === "weekly";
    return gap <= (useWeekly ? WINDOW_WEEKLY : WINDOW_DAILY);
  }
  const n = rows.length;
  const parent = rows.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[i]; i = parent[i]; }
    return i;
  }
  function union(i, j) {
    const ri = find(i); const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (mergeGap(rows[i], rows[j])) union(i, j);
    }
  }
  const groups = new Set();
  for (let i = 0; i < n; i++) groups.add(find(i));
  const spans = [];
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(rows[i]);
  }
  for (const evs of byRoot.values()) spans.push(spanDays(evs));
  const overWide = spans.filter((s) => s > 21).length;
  const covid = [...byRoot.values()].find((evs) => {
    const dates = evs.map((e) => e.date).sort();
    return dates.some((d) => d.startsWith("2020-02")) && spanDays(evs) > 60;
  });
  return {
    clusterCount: groups.size,
    overWideCount: overWide,
    maxSpan: spans.length ? Math.max(...spans) : 0,
    covidLoose: covid
      ? { start: covid.map((e) => e.date).sort()[0], end: covid.map((e) => e.date).sort().at(-1), spanDays: spanDays(covid), events: covid.length }
      : null,
  };
}

function main() {
  const argPath = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
  const csvPath = argPath ? path.resolve(argPath) : findLatestDatesCsv();
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("CSV introuvable. Lancer extractTopRiskSignalDates.mjs d'abord.");
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const rawGroups = strictClusterPipeline(rows);
  const clusters = rawGroups
    .map((g) => buildStrictCluster(g.events, { splitFromLargeCluster: g.splitFromLargeCluster }))
    .sort((a, b) => b.clusterScore - a.clusterScore);

  const tvComparable = clusters
    .filter((c) => c.isComparableTradingView)
    .sort((a, b) => {
      const dropDiff = (a.worstDrop ?? 0) - (b.worstDrop ?? 0);
      if (dropDiff !== 0) return dropDiff;
      return b.clusterScore - a.clusterScore;
    });

  const majorStrict = clusters.filter(
    (c) => c.maxTopType === "majeur" || c.maxTopType === "extrême" || c.worstDrop <= -0.2 || (c.eventCount >= 3 && c.mtfCount > 0),
  );

  const top30 = clusters.slice(0, 30);
  const top15Tv = tvComparable.slice(0, 15);

  const covidStrict = clusters
    .filter((c) => c.startDate >= "2019-12-01" && c.endDate <= "2020-04-15")
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const loose = looseClusterCount(rows);

  console.log("=== CLUSTERS TOP-RISK STRICTS — TQQQ ===\n");
  console.log(`Source : ${csvPath}`);
  console.log(`Lignes originales : ${rows.length}`);
  console.log(`Clusters stricts créés : ${clusters.length}`);
  console.log(`Clusters majeurs (top/drop) : ${majorStrict.length}`);
  console.log(`Comparables TradingView (≤21j, 2+ familles, D/MTF, majeur/-20%) : ${tvComparable.length}`);
  console.log(`Durée max : daily/MTF ${MAX_SPAN_DAILY_MTF}j | weekly ${MAX_SPAN_WEEKLY}j | mixte ${MAX_SPAN_MIXED}j`);
  console.log(`Lien max : daily/MTF ${LINK_DAILY_MTF_DAYS}j | weekly ${LINK_WEEKLY_DAYS}j | mixte ${LINK_MIXED_DAYS}j\n`);

  console.log("--- Comparaison clustering LOOSE (ancien) ---");
  console.log(`  Clusters loose : ${loose.clusterCount}`);
  console.log(`  Clusters loose > 21 jours : ${loose.overWideCount}`);
  console.log(`  Plus grand cluster loose : ${loose.maxSpan.toFixed(0)} jours`);
  if (loose.covidLoose) {
    console.log(`  Zone COVID loose : ${loose.covidLoose.start} → ${loose.covidLoose.end} (${loose.covidLoose.spanDays.toFixed(0)} j, ${loose.covidLoose.events} événements)`);
  }
  console.log(`  Zones COVID strictes (déc 2019 – avr 2020) : ${covidStrict.length}`);
  for (const c of covidStrict) {
    console.log(`    ${c.startDate} → ${c.endDate} (${c.clusterSpanDays}j) | pic signaux ${c.primaryDatePeak} | drop ${c.primaryDateWorstDrop} | ${c.eventCount} év. | score ${c.clusterScore}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("TOP 15 CLUSTERS — COMPARABLES TRADINGVIEW");
  console.log(`${"=".repeat(72)}`);
  for (const c of top15Tv) {
    const datesNote = c.primaryDatesDiffer
      ? `pic signaux ${c.primaryDatePeak} | pire drop ${c.primaryDateWorstDrop}`
      : `date principale ${c.primaryDatePeak}`;
    console.log(`\n# Score ${c.clusterScore} | ${c.startDate} → ${c.endDate} (${c.clusterSpanDays} j)`);
    console.log(`  ${datesNote}`);
    console.log(`  Signaux : ${c.signalCount} types | événements : ${c.eventCount} | D${c.dailyCount} W${c.weeklyCount} MTF${c.mtfCount}`);
    console.log(`  Drop ${pct(c.worstDrop)} | top ${c.maxTopType} | familles : ${c.families.join(", ")}`);
    console.log(`  ${c.signalNames.slice(0, 6).join(" | ")}${c.signalNames.length > 6 ? " …" : ""}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("TOP 30 CLUSTERS STRICTS (par score)");
  console.log(`${"=".repeat(72)}`);
  for (const c of top30) {
    const flags = [
      c.isComparableTradingView ? "★TV" : "",
      c.splitFromLargeCluster ? "split" : "",
      c.isOverWideCluster ? "WIDE" : "",
    ].filter(Boolean).join(" ");
    console.log(
      `  [${c.clusterScore}] ${c.startDate}→${c.endDate} (${c.clusterSpanDays}j) | n=${c.eventCount} sig=${c.signalCount} | drop ${pct(c.worstDrop)} @ ${c.primaryDateWorstDrop} | ${flags}`,
    );
  }

  const overWideRemaining = clusters.filter((c) => c.clusterSpanDays > 21);
  if (overWideRemaining.length) {
    console.log(`\n⚠ Clusters encore > 21j : ${overWideRemaining.length} (vérifier composition weekly)`);
  } else {
    console.log("\n✓ Aucun cluster prioritaire > 21 jours (hors weekly isolés jusqu'à 28j).");
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(DEBUG_DIR, `top-risk-clusters-strict-TQQQ-${ts}.json`);
  const csvOutPath = path.join(DEBUG_DIR, `top-risk-clusters-strict-TQQQ-${ts}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "strict",
    sourceCsv: csvPath,
    originalRowCount: rows.length,
    strictClusterCount: clusters.length,
    comparableTradingViewCount: tvComparable.length,
    limits: {
      maxSpanDailyMtf: MAX_SPAN_DAILY_MTF,
      maxSpanWeekly: MAX_SPAN_WEEKLY,
      maxSpanMixed: MAX_SPAN_MIXED,
      linkDailyMtf: LINK_DAILY_MTF_DAYS,
      linkWeekly: LINK_WEEKLY_DAYS,
      linkMixed: LINK_MIXED_DAYS,
    },
    comparisonLoose: loose,
    covidStrictZones: covidStrict,
    top15ComparableTradingView: top15Tv,
    top30Strict: top30,
    allClusters: clusters,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const csvRows = clusters.map((c) => ({
    clusterScore: c.clusterScore,
    isComparableTradingView: c.isComparableTradingView,
    startDate: c.startDate,
    endDate: c.endDate,
    clusterSpanDays: c.clusterSpanDays,
    isOverWideCluster: c.isOverWideCluster,
    splitFromLargeCluster: c.splitFromLargeCluster,
    centralDate: c.centralDate,
    primaryDatePeak: c.primaryDatePeak,
    primaryDateWorstDrop: c.primaryDateWorstDrop,
    primaryDatesDiffer: c.primaryDatesDiffer,
    composition: c.composition,
    eventCount: c.eventCount,
    signalCount: c.signalCount,
    dailyCount: c.dailyCount,
    weeklyCount: c.weeklyCount,
    mtfCount: c.mtfCount,
    closeAtPeak: c.closeAtPeak,
    closeAtWorstDrop: c.closeAtWorstDrop,
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
}

main();
