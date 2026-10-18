/**
 * Extrait les dates des meilleurs signaux top-risk pour comparaison TradingView.
 * Usage: node scripts/extractTopRiskSignalDates.mjs [chemin/vers/audit.json]
 *
 * Lit le dernier debug/top-correlation-mtf-TQQQ-*.json (ou chemin fourni)
 * et enrichit chaque date via debug/ohlc-cache-TQQQ.json (prix + drawdown futur).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const DAILY_THRESH = { veryShort: -0.06, swing: -0.1, medium: -0.15, major: -0.25 };
const WEEKLY_THRESH = { short: -0.12, medium: -0.2, major: -0.3, extreme: -0.4 };
const DAILY_H = { veryShort: 5, swing: 10, medium: 20, major: 40 };
const WEEKLY_H = { short: 4, medium: 8, major: 12, extreme: 16 };

/** Signaux prioritaires : nom affiché → { id, timeframe, cooldown préféré } */
const PRIORITY_SIGNALS = [
  { name: "W vol spike + D mèche", id: "mtf_8", timeframe: "mtf", preferCooldown: "cd10d" },
  { name: "W RSI>75 + D distribution", id: "mtf_14", timeframe: "mtf", preferCooldown: "none" },
  { name: "W mèche + D sous SMA8", id: "mtf_7", timeframe: "mtf", preferCooldown: "none" },
  { name: "W BB sup + D bear engulf", id: "mtf_13", timeframe: "mtf", preferCooldown: "cd10d" },
  { name: "Bear engulf + RSI>70", id: "d_engulf_rsi70", timeframe: "daily", preferCooldown: "cd20d" },
  { name: "RSI14 > 75", id: "d_rsi75", timeframe: "daily", preferCooldown: "none" },
  { name: ">SMA50 15% + sous SMA8", id: "d_ext_sma50_s8", timeframe: "daily", preferCooldown: "none" },
  { name: "Ret10>15% + RSI>70", id: "d_ret10_rsi70", timeframe: "daily", preferCooldown: "none" },
  { name: "Distribution après extension", id: "d_distrib_ext", timeframe: "daily", preferCooldown: "none" },
  { name: "Mèche haute + RSI>70 weekly", id: "w_combo20", timeframe: "weekly", preferCooldown: "none" },
  { name: "RSI>70 + ret8>25% weekly", id: "w_combo4", timeframe: "weekly", preferCooldown: "none" },
  { name: "BB sup + RSI>70 weekly", id: "w_combo19", timeframe: "weekly", preferCooldown: "none" },
];

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((d - jan1) / 86_400_000 + 1) / 7), year: d.getUTCFullYear() };
}

function weekKey(date) {
  const { week, year } = isoWeek(date);
  return `${year}-W${String(week > 52 ? 52 : week).padStart(2, "0")}`;
}

function findLatestJson() {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR)
    .filter((f) => f.match(/^top-correlation-mtf-TQQQ-.+\.json$/))
    .sort()
    .reverse();
  return files[0] ? path.join(DEBUG_DIR, files[0]) : null;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadTqqqBars() {
  const cachePath = path.join(DEBUG_DIR, "ohlc-cache-TQQQ.json");
  if (!fs.existsSync(cachePath)) return null;
  const rows = JSON.parse(fs.readFileSync(cachePath, "utf8")).rows ?? [];
  const bars = rows
    .map((r) => ({ ...r, date: new Date(r.date) }))
    .filter((r) => r.close > 0)
    .sort((a, b) => a.date - b.date);
  const byDate = new Map(bars.map((b, i) => [b.date.toISOString().slice(0, 10), i]));
  return { bars, byDate };
}

function aggregateWeekly(dailyBars) {
  const buckets = new Map();
  for (const r of dailyBars) {
    const k = weekKey(r.date);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const weeks = [];
  const byDate = new Map();
  for (const [, sorted0] of buckets) {
    const sorted = sorted0.sort((a, b) => a.date - b.date);
    const last = sorted.at(-1);
    const w = {
      date: last.date,
      dateStr: last.date.toISOString().slice(0, 10),
      close: last.close,
      open: sorted[0].open,
      high: Math.max(...sorted.map((x) => x.high)),
      low: Math.min(...sorted.map((x) => x.low)),
    };
    weeks.push(w);
    byDate.set(w.dateStr, weeks.length - 1);
  }
  weeks.sort((a, b) => a.date - b.date);
  weeks.forEach((w, i) => byDate.set(w.dateStr, i));
  return { weeks, byDate };
}

function collectSignalPool(json) {
  const pool = [];
  for (const bucket of ["daily", "weekly", "mtf"]) {
    for (const r of json.allResults?.[bucket] ?? []) pool.push(r);
    for (const r of json.top15?.[bucket] ?? []) pool.push(r);
  }
  return pool;
}

function pickSignalRecord(pool, id, preferCooldown) {
  const matches = pool.filter((r) => r.id === id);
  if (!matches.length) return null;
  const preferred = matches.find((r) => r.cooldownVariant === preferCooldown);
  if (preferred) return preferred;
  return matches.sort((a, b) => (b.scoreHint ?? 0) - (a.scoreHint ?? 0))[0];
}

function computeMetrics(bars, idx, isWeekly) {
  if (idx == null || idx < 0 || idx >= bars.length) return null;
  const base = bars[idx].close;
  const horizons = isWeekly ? WEEKLY_H : DAILY_H;
  const thresh = isWeekly ? WEEKLY_THRESH : DAILY_THRESH;
  const maxDrop = {};
  const delayToMax = {};
  let worst = 0;
  let worstHorizon = null;

  for (const [key, h] of Object.entries(horizons)) {
    let minRet = 0;
    let minAt = null;
    for (let j = 1; j <= h && idx + j < bars.length; j++) {
      const r = bars[idx + j].close / base - 1;
      if (r < minRet) {
        minRet = r;
        minAt = j;
      }
    }
    maxDrop[h] = minRet;
    delayToMax[h] = minAt;
    if (minRet < worst) {
      worst = minRet;
      worstHorizon = h;
    }
  }

  const topsHit = [];
  if (isWeekly) {
    if (maxDrop[WEEKLY_H.short] <= WEEKLY_THRESH.short) topsHit.push("court");
    if (maxDrop[WEEKLY_H.medium] <= WEEKLY_THRESH.medium) topsHit.push("moyen");
    if (maxDrop[WEEKLY_H.major] <= WEEKLY_THRESH.major) topsHit.push("majeur");
    if (maxDrop[WEEKLY_H.extreme] <= WEEKLY_THRESH.extreme) topsHit.push("extrême");
  } else {
    if (maxDrop[DAILY_H.veryShort] <= DAILY_THRESH.veryShort) topsHit.push("très court");
    if (maxDrop[DAILY_H.swing] <= DAILY_THRESH.swing) topsHit.push("swing");
    if (maxDrop[DAILY_H.medium] <= DAILY_THRESH.medium) topsHit.push("moyen");
    if (maxDrop[DAILY_H.major] <= DAILY_THRESH.major) topsHit.push("majeur");
  }

  const comment = buildComment(topsHit, worst, isWeekly);

  return {
    close: base,
    maxDrop,
    delayToMax,
    worstDrop: worst,
    worstHorizon,
    topsHit,
    topTypeLabel: topsHit.length ? topsHit.join(" + ") : "aucun",
    comment,
  };
}

function buildComment(topsHit, worst, isWeekly) {
  if (topsHit.includes("majeur") || topsHit.includes("extrême")) {
    return `Correction majeure — baisse max ${(worst * 100).toFixed(1)}%`;
  }
  if (topsHit.includes("moyen") || topsHit.includes("swing")) {
    return `Pullback notable — baisse max ${(worst * 100).toFixed(1)}%`;
  }
  if (topsHit.length) {
    return `Top léger — baisse max ${(worst * 100).toFixed(1)}%`;
  }
  return isWeekly ? "Faux signal weekly — pas de top seuil atteint" : "Faux signal daily — pas de top seuil atteint";
}

function resolveBarIndex(dateStr, timeframe, daily, weekly) {
  if (timeframe === "weekly") {
    let idx = weekly.byDate.get(dateStr);
    if (idx != null) return { bars: weekly.weeks, idx, isWeekly: true };
    const d = new Date(dateStr);
    for (let k = 0; k < 10; k++) {
      const probe = new Date(d);
      probe.setUTCDate(probe.getUTCDate() - k);
      const s = probe.toISOString().slice(0, 10);
      idx = weekly.byDate.get(s);
      if (idx != null) return { bars: weekly.weeks, idx, isWeekly: true };
    }
    return null;
  }
  const idx = daily.byDate.get(dateStr);
  if (idx == null) return null;
  return { bars: daily.bars, idx, isWeekly: false };
}

function enrichEvent(dateStr, timeframe, daily, weekly) {
  const resolved = resolveBarIndex(dateStr, timeframe, daily, weekly);
  if (!resolved) return { date: dateStr, error: "date hors historique TQQQ" };
  const m = computeMetrics(resolved.bars, resolved.idx, resolved.isWeekly);
  if (!m) return { date: dateStr, error: "métriques indisponibles" };
  return {
    date: dateStr,
    close: m.close,
    maxDrop: m.maxDrop,
    delayToMax: m.delayToMax,
    worstDrop: m.worstDrop,
    worstHorizon: m.worstHorizon,
    topsHit: m.topsHit,
    topTypeLabel: m.topTypeLabel,
    comment: m.comment,
    isWeekly: resolved.isWeekly,
  };
}

function formatDropCols(m, isWeekly) {
  if (isWeekly) {
    return `4s=${pct(m.maxDrop[4])} 8s=${pct(m.maxDrop[8])} 12s=${pct(m.maxDrop[12])} 16s=${pct(m.maxDrop[16])}`;
  }
  return `5j=${pct(m.maxDrop[5])} 10j=${pct(m.maxDrop[10])} 20j=${pct(m.maxDrop[20])} 40j=${pct(m.maxDrop[40])}`;
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function findClusters(allRows, windowDays = 7) {
  const dated = allRows
    .filter((r) => !r.error)
    .map((r) => ({ ...r, ts: new Date(r.date).getTime() }))
    .sort((a, b) => a.ts - b.ts);
  const clusters = [];
  let cluster = [];
  for (const row of dated) {
    if (!cluster.length) {
      cluster.push(row);
      continue;
    }
    const last = cluster.at(-1);
    const days = (row.ts - last.ts) / 86_400_000;
    if (days <= windowDays) cluster.push(row);
    else {
      if (cluster.length >= 2) clusters.push([...cluster]);
      cluster = [row];
    }
  }
  if (cluster.length >= 2) clusters.push(cluster);
  return clusters;
}

function buildTradingViewHighlights(allRows) {
  const valid = allRows.filter((r) => !r.error && r.topsHit?.length);
  const scored = valid.map((r) => ({
    ...r,
    score:
      (r.topsHit.includes("majeur") || r.topsHit.includes("extrême") ? 100 : 0) +
      (r.topsHit.includes("moyen") ? 50 : 0) +
      Math.abs(r.worstDrop ?? 0) * 80,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 40);
}

function main() {
  const argPath = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
  const jsonPath = argPath ? path.resolve(argPath) : findLatestJson();
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error("Fichier JSON introuvable. Lancer d'abord auditTopCorrelationMultiTimeframe.mjs TQQQ");
    process.exit(1);
  }

  console.log("=== EXTRACTION DATES SIGNAUX TOP-RISK ===\n");
  console.log(`Source audit : ${jsonPath}`);

  const json = loadJson(jsonPath);
  const tqqq = loadTqqqBars();
  if (!tqqq) {
    console.error("Cache debug/ohlc-cache-TQQQ.json requis pour prix et drawdowns.");
    process.exit(1);
  }
  const weekly = aggregateWeekly(tqqq.bars);
  console.log(`TQQQ : ${tqqq.bars[0].date.toISOString().slice(0, 10)} → ${tqqq.bars.at(-1).date.toISOString().slice(0, 10)}`);
  console.log(`Période audit : ${json.primarySeries?.period?.first} → ${json.primarySeries?.period?.last}\n`);

  const pool = collectSignalPool(json);
  const allCsvRows = [];
  const byYear = new Map();

  for (const sig of PRIORITY_SIGNALS) {
    const rec = pickSignalRecord(pool, sig.id, sig.preferCooldown);
    if (!rec?.eventDates?.length) {
      console.log(`\n── ${sig.name} (${sig.id}) — aucune date dans l'audit ──`);
      continue;
    }

    console.log(`\n${"─".repeat(68)}`);
    console.log(`${sig.name} [${sig.timeframe}] — id=${sig.id} — cooldown=${rec.cooldownVariant} — n=${rec.occurrences}`);
    console.log(`Taux top majeur audit : ${pct(rec.rates?.topMajor)} | lift : ${pct(rec.lift?.major)}`);

    for (const dateStr of rec.eventDates) {
      const enriched = enrichEvent(dateStr, sig.timeframe, tqqq, weekly);
      const row = {
        signalName: sig.name,
        signalId: sig.id,
        timeframe: sig.timeframe,
        cooldown: rec.cooldownVariant,
        date: dateStr,
        close: enriched.close ?? "",
        topType: enriched.topTypeLabel ?? "",
        worstDrop: enriched.worstDrop ?? "",
        comment: enriched.comment ?? enriched.error ?? "",
        drop5: enriched.maxDrop?.[5] ?? enriched.maxDrop?.[4] ?? "",
        drop10: enriched.maxDrop?.[10] ?? enriched.maxDrop?.[8] ?? "",
        drop20: enriched.maxDrop?.[20] ?? enriched.maxDrop?.[12] ?? "",
        drop40: enriched.maxDrop?.[40] ?? enriched.maxDrop?.[16] ?? "",
        delay5: enriched.delayToMax?.[5] ?? enriched.delayToMax?.[4] ?? "",
        delay20: enriched.delayToMax?.[20] ?? enriched.delayToMax?.[12] ?? "",
        error: enriched.error ?? "",
      };
      allCsvRows.push(row);

      const year = dateStr.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push({ sig, rec, enriched, row });

      if (enriched.error) {
        console.log(`  ${dateStr} — ${enriched.error}`);
      } else {
        const drops = formatDropCols(enriched, enriched.isWeekly);
        const delayVal = enriched.delayToMax?.[enriched.worstHorizon];
        const delay = enriched.isWeekly
          ? `délai max: ${delayVal ?? "—"} sem. (hor. ${enriched.worstHorizon ?? "—"})`
          : `délai max: ${delayVal ?? "—"} j. (hor. ${enriched.worstHorizon ?? "—"})`;
        console.log(
          `  ${dateStr} | close ${enriched.close?.toFixed?.(2) ?? "—"} | ${drops} | ${enriched.topTypeLabel} | ${delay}`,
        );
        console.log(`    → ${enriched.comment}`);
      }
    }
  }

  const flatForCluster = allCsvRows
    .filter((r) => !r.error)
    .map((r) => ({
      date: r.date,
      signalName: r.signalName,
      signalId: r.signalId,
      timeframe: r.timeframe,
      topsHit: r.topType ? r.topType.split(" + ") : [],
      worstDrop: Number(r.worstDrop) || 0,
      topTypeLabel: r.topType,
      comment: r.comment,
      close: r.close,
      error: r.error,
    }));

  const clusters = findClusters(flatForCluster, 10);

  console.log(`\n${"=".repeat(72)}`);
  console.log("PÉRIODES OÙ PLUSIEURS SIGNAUX SE REGROUPENT (≤10 jours)");
  console.log(`${"=".repeat(72)}`);
  for (const cluster of clusters.slice(0, 25)) {
    const dates = [...new Set(cluster.map((c) => c.date))].sort();
    const signals = [...new Set(cluster.map((c) => c.signalName))];
    const worst = Math.min(...cluster.map((c) => c.worstDrop));
    console.log(`\n  Fenêtre autour de ${dates[0]}${dates.length > 1 ? ` → ${dates.at(-1)}` : ""}`);
    console.log(`  Signaux (${signals.length}) : ${signals.join(" | ")}`);
    console.log(`  Pire baisse max dans le groupe : ${pct(worst)}`);
    for (const c of cluster) {
      console.log(`    ${c.date} — ${c.signalName} — ${c.topTypeLabel} — ${c.comment}`);
    }
  }

  const highlights = buildTradingViewHighlights(flatForCluster);

  console.log(`\n${"=".repeat(72)}`);
  console.log("DATES MAJEURES À COMPARER AUX FLÈCHES TRADINGVIEW");
  console.log("(tri : top majeur/extrême, puis ampleur de la baisse max)");
  console.log(`${"=".repeat(72)}`);

  const seen = new Set();
  for (const h of highlights) {
    const key = `${h.date}|${h.signalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(
      `  ${h.date} | ${h.signalName} [${h.timeframe}] | close ${typeof h.close === "number" ? h.close.toFixed(2) : h.close} | ${h.topTypeLabel} | baisse max ${pct(h.worstDrop)}`,
    );
    console.log(`    → ${h.comment}`);
  }

  console.log(`\n── Résumé par année (tous signaux prioritaires) ──`);
  for (const year of [...byYear.keys()].sort()) {
    const items = byYear.get(year);
    const majors = items.filter((x) => x.enriched.topsHit?.includes("majeur") || x.enriched.topsHit?.includes("extrême"));
    console.log(`  ${year} : ${items.length} signaux | ${majors.length} avec top majeur/extrême`);
  }

  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const csvPath = path.join(DEBUG_DIR, `top-risk-signal-dates-TQQQ-${ts}.csv`);
  const headers = [
    "signalName", "signalId", "timeframe", "cooldown", "date", "close",
    "topType", "worstDrop", "drop5or4w", "drop10or8w", "drop20or12w", "drop40or16w",
    "delay5or4w", "delay20or12w", "comment", "error",
  ];
  const lines = allCsvRows.map((r) =>
    [
      r.signalName, r.signalId, r.timeframe, r.cooldown, r.date, r.close,
      r.topType, r.worstDrop, r.drop5, r.drop10, r.drop20, r.drop40,
      r.delay5, r.delay20, r.comment, r.error,
    ].map((v) => (v == null ? "" : String(v).replace(/,/g, ";"))).join(","),
  );
  fs.writeFileSync(csvPath, `${headers.join(",")}\n${lines.join("\n")}`, "utf8");

  console.log(`\nCSV écrit : ${csvPath}`);
  console.log(`Total lignes : ${allCsvRows.length}`);
}

main();
