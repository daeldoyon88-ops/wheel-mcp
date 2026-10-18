/**
 * Audit corrélation — flèches jaunes PERSONNELLES de l'utilisateur (saisies à la main)
 * vs drawdowns TQQQ. Audit SEULEMENT.
 *
 * ⚠️ Différence avec scripts/auditYellowArrowCorrelation.mjs :
 *   - Ce script N'UTILISE PAS le Pine (debug/TQQQ_Top_Risk_Live_Final.pine) comme source.
 *   - Les flèches jaunes proviennent UNIQUEMENT d'une liste manuelle fournie par l'utilisateur :
 *       1) debug/manual-yellow-arrow-dates-TQQQ.csv  (prioritaire)   colonnes: date,note
 *       2) sinon, le tableau MANUAL_YELLOW_ARROW_DATES ci-dessous.
 *   - On ne suppose JAMAIS que les flèches utilisateur == dispWatch du Pine.
 *
 * Usage: node scripts/auditManualYellowArrowCorrelation.mjs [TQQQ]
 *
 * Sorties :
 *   - rapport console
 *   - debug/manual-yellow-arrow-correlation-audit.md
 *   - debug/manual-yellow-arrow-correlation-audit.json
 *
 * Si aucune date exacte n'est disponible, le script l'indique clairement et n'invente rien.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const CLI = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TICKER = (CLI[0] ?? "TQQQ").trim().toUpperCase();

// ────────────────────────────────────────────────────────────────────────────
// Source 2 (fallback) : liste manuelle inline. Laisser vide pour forcer le CSV.
// Renseigner ICI les dates EXACTES des flèches jaunes si tu ne veux pas de CSV.
// Format strict: 'YYYY-MM-DD'. Les placeholders type '2022-01-xx' sont ignorés.
// ────────────────────────────────────────────────────────────────────────────
const MANUAL_YELLOW_ARROW_DATES = [
  // '2021-02-16',
  // '2021-11-19',
  // '2022-08-16',
];

const MANUAL_CSV = path.join(DEBUG_DIR, `manual-yellow-arrow-dates-${TICKER}.csv`);

const HORIZONS = [5, 10, 20, 40];
const DROP_THRESHOLDS = [0.05, 0.1, 0.15, 0.2];
const LOCAL_PEAK_LOOKBACK = 20;
const LOCAL_PEAK_TOLERANCE = 0.03; // <=3% du high récent => "près du sommet"
const LATE_DROP_THRESHOLD = 0.05; // déjà -5%+ du high récent => "trop tard"
const DATE_SNAP_TOLERANCE_DAYS = 4; // tolérance pour caler une date sur une barre

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function round2(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100; }
function round4(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000; }
function daysBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}
function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
function avg(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

// ── CSV parsing ─────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = "", inQ = false;
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
  const lines = content.split(/\r?\n/);
  const dataLines = lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!dataLines.length) return [];
  const headers = parseCsvLine(dataLines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < dataLines.length; i++) {
    const vals = parseCsvLine(dataLines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] ?? "").trim(); });
    rows.push(row);
  }
  return rows;
}

function findLatest(pattern) {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR).filter((f) => pattern.test(f)).sort().reverse();
  return files[0] ? path.join(DEBUG_DIR, files[0]) : null;
}

function cacheFile(symbol) {
  return path.join(DEBUG_DIR, `ohlc-cache-${String(symbol).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function loadBars(symbol) {
  const p = cacheFile(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    const rows = JSON.parse(fs.readFileSync(p, "utf8")).rows ?? [];
    const bars = rows
      .map((r) => ({
        date: new Date(r.date),
        open: +r.open, high: +r.high, low: +r.low, close: +r.close,
        volume: r.volume == null ? null : +r.volume,
      }))
      .filter((r) => r.close > 0 && !Number.isNaN(r.date.getTime()))
      .sort((a, b) => a.date - b.date);
    return bars.length >= 50 ? bars : null;
  } catch { return null; }
}

// ── Chargement des flèches manuelles ────────────────────────────────────────
function loadManualArrows() {
  // 1) CSV prioritaire
  if (fs.existsSync(MANUAL_CSV)) {
    const rows = parseCsv(fs.readFileSync(MANUAL_CSV, "utf8"));
    const arrows = [];
    const ignored = [];
    for (const r of rows) {
      const raw = (r.date ?? "").trim();
      if (DATE_RE.test(raw)) arrows.push({ date: raw, note: r.note ?? "" });
      else if (raw) ignored.push(raw);
    }
    return { source: "csv", path: MANUAL_CSV, arrows, ignored };
  }
  // 2) Tableau inline
  const arrows = [];
  const ignored = [];
  for (const raw of MANUAL_YELLOW_ARROW_DATES) {
    const v = String(raw).trim();
    if (DATE_RE.test(v)) arrows.push({ date: v, note: "inline" });
    else if (v) ignored.push(v);
  }
  return { source: "inline", path: null, arrows, ignored };
}

// ── Calage d'une date sur une barre de trading ──────────────────────────────
function snapToBar(bars, dateStr) {
  // exact
  let idx = bars.findIndex((b) => isoDay(b.date) === dateStr);
  if (idx >= 0) return { idx, matchedDate: dateStr, deltaDays: 0, exact: true };
  // nearest dans la tolérance
  let best = Infinity, bestIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const d = daysBetween(bars[i].date, dateStr);
    if (d < best) { best = d; bestIdx = i; }
  }
  if (bestIdx >= 0 && best <= DATE_SNAP_TOLERANCE_DAYS) {
    return { idx: bestIdx, matchedDate: isoDay(bars[bestIdx].date), deltaDays: best, exact: false };
  }
  return { idx: -1, matchedDate: null, deltaDays: best, exact: false };
}

// ── Métriques forward à partir d'un index de barre ──────────────────────────
function computeForwardMetrics(bars, idx) {
  const baseClose = bars[idx].close;
  const baseHigh = bars[idx].high;
  const metrics = {
    close: round2(baseClose),
    labelable: idx + 40 < bars.length,
    horizonsAvailable: {},
    returns: {}, maxDrawdowns: {}, daysToMaxDrawdown: {},
    lowPrices: {}, precededDrop: {},
  };

  for (const h of HORIZONS) {
    let minLow = Infinity, minRet = 0, minAt = null;
    let bars_seen = 0;
    for (let j = 1; j <= h && idx + j < bars.length; j++) {
      bars_seen++;
      const bar = bars[idx + j];
      if (bar.low < minLow) minLow = bar.low;
      const retLow = bar.low / baseClose - 1;
      if (retLow < minRet) { minRet = retLow; minAt = j; }
    }
    metrics.horizonsAvailable[h] = bars_seen === h;
    metrics.lowPrices[h] = minLow === Infinity ? null : round2(minLow);
    metrics.maxDrawdowns[h] = bars_seen > 0 ? round4(minRet) : null;
    metrics.daysToMaxDrawdown[h] = minAt;
    metrics.returns[h] = idx + h < bars.length ? round4(bars[idx + h].close / baseClose - 1) : null;
  }

  for (const t of DROP_THRESHOLDS) {
    metrics.precededDrop[t] = false;
    for (const h of HORIZONS) {
      const dd = metrics.maxDrawdowns[h];
      if (dd != null && dd <= -t) { metrics.precededDrop[t] = true; break; }
    }
  }

  // sommet local précédent / timing
  let recentHigh = baseHigh;
  const lookStart = Math.max(0, idx - LOCAL_PEAK_LOOKBACK);
  for (let k = lookStart; k <= idx; k++) {
    if (bars[k].high > recentHigh) recentHigh = bars[k].high;
  }
  const dropFromPeak = recentHigh > 0 ? 1 - baseClose / recentHigh : 0;
  metrics.recentPeakHigh = round2(recentHigh);
  metrics.dropFromRecentPeak = round4(dropFromPeak);
  metrics.nearLocalPeak = dropFromPeak <= LOCAL_PEAK_TOLERANCE;
  metrics.tooLateAfterDrop = dropFromPeak >= LATE_DROP_THRESHOLD;

  return metrics;
}

// ── Tops TV (référence) — sans Pine ─────────────────────────────────────────
function loadTvDates() {
  const p = findLatest(new RegExp(`^top-risk-tv-dates-${TICKER}-.+\\.csv$`));
  if (!p) return { path: null, dates: [], rows: [] };
  const rows = parseCsv(fs.readFileSync(p, "utf8"));
  const dates = rows.map((r) => r.primaryDateFinal).filter((d) => DATE_RE.test(d));
  return { path: p, dates: [...new Set(dates)].sort(), rows };
}

function overlapStats(sourceDates, targetDates, windows = [0, 3, 5]) {
  const result = {};
  for (const w of windows) {
    let matched = 0; const pairs = [];
    for (const s of sourceDates) {
      let best = Infinity, bestT = null;
      for (const t of targetDates) {
        const d = daysBetween(s, t);
        if (d < best) { best = d; bestT = t; }
      }
      if (best <= w) { matched++; pairs.push({ source: s, target: bestT, deltaDays: Math.round(best) }); }
    }
    result[w] = { matched, total: sourceDates.length, rate: sourceDates.length ? matched / sourceDates.length : 0, pairs };
  }
  return result;
}

function reverseUnmatched(sourceDates, targetDates, window) {
  const unmatched = [];
  let matched = 0;
  for (const t of targetDates) {
    let best = Infinity;
    for (const s of sourceDates) best = Math.min(best, daysBetween(t, s));
    if (best <= window) matched++; else unmatched.push(t);
  }
  return { matched, total: targetDates.length, unmatched };
}

// ── Sortie "impossible" ─────────────────────────────────────────────────────
function emitImpossible(loaded, reason) {
  const msg = "Impossible de faire une corrélation fiable sans dates exactes des flèches utilisateur.";
  console.log("=== AUDIT FLÈCHES JAUNES MANUELLES (TQQQ) ===\n");
  console.log(`⛔ ${msg}`);
  console.log(`\nRaison : ${reason}`);
  console.log(`Source attendue (prioritaire) : ${MANUAL_CSV}`);
  console.log("Format CSV : date,note  (une ligne par flèche, date = YYYY-MM-DD)");
  if (loaded.ignored?.length) console.log(`Entrées ignorées (non valides) : ${loaded.ignored.join(", ")}`);
  console.log("\nÉtapes :");
  console.log("  1) Ouvre TradingView (TQQQ 1D), relève la date exacte de chaque flèche jaune.");
  console.log(`  2) Renseigne ces dates dans ${path.relative(ROOT, MANUAL_CSV)} (ou le tableau inline du script).`);
  console.log("  3) Relance : node scripts/auditManualYellowArrowCorrelation.mjs");

  const md = [
    "# Audit corrélation — flèches jaunes manuelles (utilisateur) — TQQQ",
    "",
    `Généré : ${new Date().toISOString()}`,
    "",
    "## ⛔ Audit non concluant",
    "",
    `**${msg}**`,
    "",
    `- Raison : ${reason}`,
    `- Source attendue (prioritaire) : \`${path.relative(ROOT, MANUAL_CSV)}\``,
    "- Le Pine (`debug/TQQQ_Top_Risk_Live_Final.pine`) n'est volontairement **pas** utilisé comme source des flèches.",
    loaded.ignored?.length ? `- Entrées ignorées : ${loaded.ignored.join(", ")}` : "- Aucune entrée valide trouvée.",
    "",
    "## Comment fournir les dates",
    "",
    "1. Sur TradingView (TQQQ, 1D), relève la **date exacte** de chacune de tes flèches jaunes personnelles.",
    `2. Renseigne-les dans \`${path.relative(ROOT, MANUAL_CSV)}\` au format :`,
    "",
    "```csv",
    "date,note",
    "2021-11-19,flèche utilisateur",
    "2022-08-16,flèche utilisateur",
    "```",
    "",
    "3. Relance `node scripts/auditManualYellowArrowCorrelation.mjs`.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.md"), md, "utf8");
  fs.writeFileSync(
    path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      ticker: TICKER,
      status: "insufficient_data",
      message: msg,
      reason,
      manualSource: loaded.path ? path.relative(ROOT, loaded.path) : "inline",
      ignoredEntries: loaded.ignored ?? [],
      pineUsedAsSource: false,
    }, null, 2),
    "utf8",
  );
  console.log("\nFichiers générés (constat) :");
  console.log(`  ${path.relative(ROOT, path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.md"))}`);
  console.log(`  ${path.relative(ROOT, path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.json"))}`);
}

function buildVerdict(stats, audits, tv) {
  const lb = audits.filter((a) => a.metrics.labelable);
  const n = lb.length;
  if (!n) {
    return {
      verdict: "indéterminé",
      rationale: ["Aucune flèche n'a 40 séances de données futures — impossible de juger la performance forward."],
    };
  }
  const hit5 = lb.filter((a) => a.metrics.precededDrop[0.05]).length;
  const hit10 = lb.filter((a) => a.metrics.precededDrop[0.1]).length;
  const hit20 = lb.filter((a) => a.metrics.precededDrop[0.2]).length;
  const falsePos = n - hit5;
  const tooLate = lb.filter((a) => a.metrics.tooLateAfterDrop).length;
  const nearPeak = lb.filter((a) => a.metrics.nearLocalPeak).length;
  const tvCover5 = tv.dates.length ? stats.arrowsToTv[5].matched / stats.arrowsToTv[0].total : null;

  const rationale = [];
  let verdict;
  if (hit20 / n >= 0.35 && falsePos / n <= 0.45) {
    verdict = "bon WATCH (utile)";
    rationale.push(`${hit20}/${n} flèches ont précédé une baisse ≥20% avec peu de faux positifs (${falsePos}/${n}).`);
  } else if (tooLate / n > 0.5) {
    verdict = "trop tard";
    rationale.push(`${tooLate}/${n} flèches arrivent alors que TQQQ a déjà perdu ≥5% du sommet récent.`);
  } else if (hit10 / n >= 0.4 && falsePos / n <= 0.5) {
    verdict = "bon WATCH (utile)";
    rationale.push(`${hit10}/${n} flèches ont précédé une baisse ≥10%.`);
  } else if (falsePos / n > 0.55) {
    verdict = "à améliorer (trop de faux positifs)";
    rationale.push(`${falsePos}/${n} flèches n'ont pas atteint -5% dans les 40 séances.`);
  } else {
    verdict = "à améliorer";
    rationale.push("Performance mitigée — capture partielle des baisses.");
  }
  if (n < 5) rationale.push(`Échantillon faible (${n} flèches labelables) — verdict indicatif.`);
  if (tvCover5 != null) rationale.push(`Couverture des tops TV (±5j) : ${pct(tvCover5)}.`);
  if (nearPeak / n < 0.4) rationale.push(`Seulement ${nearPeak}/${n} flèches sont proches d'un sommet local (timing perfectible).`);
  return { verdict, rationale };
}

function main() {
  console.log("=== AUDIT FLÈCHES JAUNES MANUELLES (utilisateur) — " + TICKER + " ===\n");
  console.log("Source des flèches : LISTE MANUELLE (le Pine n'est PAS utilisé comme source).\n");

  const loaded = loadManualArrows();
  console.log(`Source flèches : ${loaded.source}${loaded.path ? " (" + path.relative(ROOT, loaded.path) + ")" : ""}`);

  if (!loaded.arrows.length) {
    const reason = loaded.source === "csv"
      ? `Le fichier ${path.relative(ROOT, MANUAL_CSV)} ne contient aucune date valide (YYYY-MM-DD).`
      : "Aucune date dans le tableau inline ni de CSV manuel.";
    emitImpossible(loaded, reason);
    process.exit(0);
  }

  const bars = loadBars(TICKER);
  if (!bars) {
    emitImpossible(loaded, `Cache OHLC introuvable ou trop court : ${path.relative(ROOT, cacheFile(TICKER))}`);
    process.exit(0);
  }
  const dataStart = isoDay(bars[0].date);
  const dataEnd = isoDay(bars.at(-1).date);

  // Dédup + tri des dates manuelles, puis calage sur les barres
  const uniqueArrows = [];
  const seen = new Set();
  for (const a of loaded.arrows.sort((x, y) => x.date.localeCompare(y.date))) {
    if (seen.has(a.date)) continue;
    seen.add(a.date);
    uniqueArrows.push(a);
  }

  const audits = [];
  const unmatched = [];
  for (const a of uniqueArrows) {
    const snap = snapToBar(bars, a.date);
    if (snap.idx < 0) {
      unmatched.push({ ...a, reason: snap.matchedDate == null ? `hors tolérance (${Math.round(snap.deltaDays)}j de la barre la plus proche)` : "non calé" });
      continue;
    }
    audits.push({
      inputDate: a.date,
      matchedDate: snap.matchedDate,
      snapDeltaDays: Math.round(snap.deltaDays),
      snapExact: snap.exact,
      note: a.note,
      metrics: computeForwardMetrics(bars, snap.idx),
    });
  }

  if (!audits.length) {
    emitImpossible(loaded, `Aucune date manuelle ne tombe dans la plage du cache OHLC (${dataStart} → ${dataEnd}) à ±${DATE_SNAP_TOLERANCE_DAYS}j.`);
    process.exit(0);
  }

  const tv = loadTvDates();
  const arrowDates = audits.map((a) => a.matchedDate);
  const arrowsToTv = overlapStats(arrowDates, tv.dates, [0, 3, 5]);
  const tvMissed5 = tv.dates.length ? reverseUnmatched(arrowDates, tv.dates, 5) : { matched: 0, total: 0, unmatched: [] };

  // Gros drawdowns TV manqués + drop futur réel
  const missedDrawdowns = tvMissed5.unmatched.map((date) => {
    const idx = bars.findIndex((b) => isoDay(b.date) === date);
    let drop40 = null;
    if (idx >= 0 && idx + 40 < bars.length) {
      let minRet = 0;
      for (let j = 1; j <= 40; j++) { const r = bars[idx + j].low / bars[idx].close - 1; if (r < minRet) minRet = r; }
      drop40 = round4(minRet);
    }
    let nearest = null, nd = Infinity;
    for (const ad of arrowDates) { const d = daysBetween(date, ad); if (d < nd) { nd = d; nearest = ad; } }
    return { date, drop40, nearestArrow: nearest, nearestArrowDeltaDays: Math.round(nd) };
  }).sort((a, b) => (a.drop40 ?? 0) - (b.drop40 ?? 0));

  const labelable = audits.filter((a) => a.metrics.labelable);
  const bestSignals = [...labelable].sort((a, b) => (a.metrics.maxDrawdowns[40] ?? 0) - (b.metrics.maxDrawdowns[40] ?? 0)).slice(0, 20);
  const falsePositives = labelable.filter((a) => !a.metrics.precededDrop[0.05]);
  const tooLate = labelable.filter((a) => a.metrics.tooLateAfterDrop);

  const stats = {
    arrowCount: uniqueArrows.length,
    matchedCount: audits.length,
    labelableCount: labelable.length,
    unmatchedCount: unmatched.length,
    tvCount: tv.dates.length,
    arrowsToTv,
    tvMissed5: { matched: tvMissed5.matched, total: tvMissed5.total, missed: tvMissed5.unmatched.length },
    dropHitRates: Object.fromEntries(DROP_THRESHOLDS.map((t) => {
      const c = labelable.filter((a) => a.metrics.precededDrop[t]).length;
      return [t, { hit: c, total: labelable.length, rate: labelable.length ? c / labelable.length : 0 }];
    })),
    avgDrawdownByHorizon: Object.fromEntries(HORIZONS.map((h) => [h, round4(avg(labelable.map((a) => a.metrics.maxDrawdowns[h])))])),
    avgReturnByHorizon: Object.fromEntries(HORIZONS.map((h) => [h, round4(avg(labelable.map((a) => a.metrics.returns[h])))])),
    nearPeakCount: labelable.filter((a) => a.metrics.nearLocalPeak).length,
    tooLateCount: tooLate.length,
    falsePositiveCount: falsePositives.length,
  };

  const verdict = buildVerdict(stats, audits, tv);

  // ── Console ───────────────────────────────────────────────────────────────
  console.log(`Cache OHLC     : ${path.relative(ROOT, cacheFile(TICKER))} (${dataStart} → ${dataEnd}, ${bars.length} barres)`);
  console.log(`Tops TV (réf.) : ${tv.path ? path.relative(ROOT, tv.path) + " (" + tv.dates.length + " dates)" : "(absent)"}`);
  console.log(`\nFlèches saisies : ${stats.arrowCount} | calées sur barre : ${stats.matchedCount} | labelables (40j futurs) : ${stats.labelableCount} | non calées : ${stats.unmatchedCount}`);
  if (unmatched.length) {
    console.log("Dates non calées :");
    for (const u of unmatched) console.log(`  - ${u.date} : ${u.reason}`);
  }
  console.log("\n--- TAUX DE BAISSE APRÈS FLÈCHE (sur labelables) ---");
  for (const t of DROP_THRESHOLDS) {
    const r = stats.dropHitRates[t];
    console.log(`  ≥${t * 100}% : ${r.hit}/${r.total} (${pct(r.rate)})`);
  }
  console.log("\n--- DRAWDOWN / RETOUR MOYEN ---");
  for (const h of HORIZONS) console.log(`  ${h}j : DD moyen ${pct(stats.avgDrawdownByHorizon[h])} | retour close ${pct(stats.avgReturnByHorizon[h])}`);
  console.log(`\nFaux positifs (pas de -5% en 40j) : ${stats.falsePositiveCount}/${stats.labelableCount}`);
  console.log(`Trop tard (déjà -5% du pic 20j)   : ${stats.tooLateCount}/${stats.labelableCount}`);
  console.log(`Près d'un sommet local (≤3%)      : ${stats.nearPeakCount}/${stats.labelableCount}`);
  if (tv.dates.length) {
    console.log("\n--- vs TOPS TV ---");
    for (const w of [0, 3, 5]) console.log(`  flèches → TV ±${w}j : ${arrowsToTv[w].matched}/${arrowsToTv[w].total} (${pct(arrowsToTv[w].rate)})`);
    console.log(`  tops TV manqués (±5j) : ${stats.tvMissed5.missed}/${tv.dates.length}`);
  }
  console.log(`\n=> VERDICT : ${verdict.verdict}`);
  for (const r of verdict.rationale) console.log(`   - ${r}`);

  // ── Markdown ───────────────────────────────────────────────────────────────
  const fmtRow = (a) => {
    const m = a.metrics;
    return `| ${a.matchedDate}${a.snapExact ? "" : `*`} | ${m.close ?? "—"} | ${pct(m.maxDrawdowns[5])} | ${pct(m.maxDrawdowns[10])} | ${pct(m.maxDrawdowns[20])} | ${pct(m.maxDrawdowns[40])} | ${pct(m.returns[40])} | ${m.nearLocalPeak ? "oui" : "non"} | ${m.tooLateAfterDrop ? "oui" : "non"} | ${m.precededDrop[0.1] ? "oui" : "non"} | ${m.precededDrop[0.2] ? "oui" : "non"} |`;
  };

  const md = [];
  md.push("# Audit corrélation — flèches jaunes **manuelles** (utilisateur) — " + TICKER);
  md.push("");
  md.push(`Généré : ${new Date().toISOString()}`);
  md.push("");
  md.push("> ⚠️ **Source des flèches = liste manuelle de l'utilisateur uniquement.**");
  md.push("> Le Pine `debug/TQQQ_Top_Risk_Live_Final.pine` n'est **pas** utilisé comme source ici.");
  md.push("");
  md.push("## 1. Résumé exécutif");
  md.push("");
  md.push(`- Flèches utilisateur saisies : **${stats.arrowCount}**`);
  md.push(`- Calées sur une barre (±${DATE_SNAP_TOLERANCE_DAYS}j) : **${stats.matchedCount}** | non calées : **${stats.unmatchedCount}**`);
  md.push(`- Labelables (≥40 séances futures) : **${stats.labelableCount}**`);
  md.push(`- Faux positifs (pas de -5% en 40j) : **${stats.falsePositiveCount}/${stats.labelableCount}**`);
  md.push(`- Trop tardives (déjà -5% du pic 20j) : **${stats.tooLateCount}/${stats.labelableCount}**`);
  md.push(`- Tops TV référence : **${stats.tvCount}**${tv.dates.length ? ` — couverts par flèches (±5j) : **${arrowsToTv[5].matched}/${arrowsToTv[0].total}**, manqués : **${stats.tvMissed5.missed}**` : " (fichier absent)"}`);
  md.push(`- **Verdict : ${verdict.verdict}**`);
  md.push("");
  md.push("## 2. Sources");
  md.push("");
  md.push("| Source | Fichier | Usage |");
  md.push("|--------|---------|-------|");
  md.push(`| Flèches manuelles | \`${loaded.path ? path.relative(ROOT, loaded.path) : "tableau inline"}\` | Dates des flèches utilisateur |`);
  md.push(`| OHLC ${TICKER} | \`${path.relative(ROOT, cacheFile(TICKER))}\` | Prix, drawdowns, retours |`);
  md.push(`| Tops TV | \`${tv.path ? path.relative(ROOT, tv.path) : "—"}\` | ${tv.dates.length} dates de tops réels (référence) |`);
  md.push("| Pine | (non utilisé comme source) | — |");
  md.push("");
  md.push(`Plage OHLC : ${dataStart} → ${dataEnd} (${bars.length} barres). `);
  md.push("Une `*` après la date = date calée sur la barre de trading la plus proche (la date saisie n'était pas une séance).");
  md.push("");

  if (unmatched.length) {
    md.push("## 3. Dates non calées");
    md.push("");
    md.push("| Date saisie | Raison |");
    md.push("|-------------|--------|");
    for (const u of unmatched) md.push(`| ${u.date} | ${u.reason} |`);
    md.push("");
  }

  md.push("## 4. Performance après chaque flèche");
  md.push("");
  md.push("| Date | Close | DD 5j | DD 10j | DD 20j | DD 40j | Ret 40j | Près sommet | Trop tard | ≥10% | ≥20% |");
  md.push("|------|-------|-------|--------|--------|--------|---------|-------------|-----------|------|------|");
  for (const a of audits) md.push(fmtRow(a));
  md.push("");

  md.push("## 5. Statistiques agrégées (labelables)");
  md.push("");
  md.push("| Horizon | Drawdown moyen | Retour close moyen |");
  md.push("|---------|----------------|--------------------|");
  for (const h of HORIZONS) md.push(`| ${h}j | ${pct(stats.avgDrawdownByHorizon[h])} | ${pct(stats.avgReturnByHorizon[h])} |`);
  md.push("");
  md.push("| Seuil de baisse | Flèches touchées | Taux |");
  md.push("|-----------------|------------------|------|");
  for (const t of DROP_THRESHOLDS) { const r = stats.dropHitRates[t]; md.push(`| ≥${t * 100}% | ${r.hit}/${r.total} | ${pct(r.rate)} |`); }
  md.push("");
  md.push(`- Près d'un sommet local (≤3% du high 20j) : **${stats.nearPeakCount}/${stats.labelableCount}**`);
  md.push(`- Trop tard (déjà -5%+ du high 20j) : **${stats.tooLateCount}/${stats.labelableCount}**`);
  md.push("");

  md.push("## 6. Meilleurs signaux (pire drawdown 40j capté)");
  md.push("");
  md.push("| Date | Close | DD 40j | Délai pire DD | ≥20% |");
  md.push("|------|-------|--------|---------------|------|");
  for (const a of bestSignals.slice(0, 12)) {
    md.push(`| ${a.matchedDate} | ${a.metrics.close} | ${pct(a.metrics.maxDrawdowns[40])} | ${a.metrics.daysToMaxDrawdown[40] ?? "—"} j | ${a.metrics.precededDrop[0.2] ? "oui" : "non"} |`);
  }
  md.push("");

  md.push("## 7. Faux positifs (pas de baisse ≥5% en 40j)");
  md.push("");
  if (falsePositives.length) {
    md.push("| Date | Close | DD 40j max | Ret 40j |");
    md.push("|------|-------|-----------|---------|");
    for (const a of falsePositives) md.push(`| ${a.matchedDate} | ${a.metrics.close} | ${pct(a.metrics.maxDrawdowns[40])} | ${pct(a.metrics.returns[40])} |`);
  } else {
    md.push("Aucun faux positif : toutes les flèches labelables ont connu ≥-5% dans les 40 séances.");
  }
  md.push("");

  md.push("## 8. Signaux trop tardifs (déjà -5% du pic 20j)");
  md.push("");
  if (tooLate.length) {
    md.push("| Date | Close | Baisse depuis pic 20j | DD 40j suivant |");
    md.push("|------|-------|-----------------------|----------------|");
    for (const a of tooLate) md.push(`| ${a.matchedDate} | ${a.metrics.close} | ${pct(a.metrics.dropFromRecentPeak)} | ${pct(a.metrics.maxDrawdowns[40])} |`);
  } else {
    md.push("Aucune flèche n'arrive trop tard : toutes sont à ≤5% du pic 20j.");
  }
  md.push("");

  md.push("## 9. Gros drawdowns manqués (tops TV sans flèche ±5j)");
  md.push("");
  if (!tv.dates.length) {
    md.push("Fichier de tops TV absent — comparaison non disponible.");
  } else if (!missedDrawdowns.length) {
    md.push("Aucun top TV manqué (±5j).");
  } else {
    md.push("| Date TV | Drop ~40j | Flèche la plus proche | Écart (j) |");
    md.push("|---------|-----------|------------------------|-----------|");
    for (const m of missedDrawdowns.slice(0, 20)) {
      md.push(`| ${m.date} | ${pct(m.drop40)} | ${m.nearestArrow ?? "—"} | ${Number.isFinite(m.nearestArrowDeltaDays) ? m.nearestArrowDeltaDays : "—"} |`);
    }
  }
  md.push("");

  md.push("## 10. Comparaison avec tops TV");
  md.push("");
  if (tv.dates.length) {
    md.push("| Fenêtre | Flèches → tops TV |");
    md.push("|---------|-------------------|");
    for (const w of [0, 3, 5]) md.push(`| ±${w}j | ${arrowsToTv[w].matched}/${arrowsToTv[w].total} (${pct(arrowsToTv[w].rate)}) |`);
    md.push("");
    md.push(`- Tops TV manqués (±5j) : **${stats.tvMissed5.missed}/${tv.dates.length}**`);
  } else {
    md.push("Aucun fichier `top-risk-tv-dates-" + TICKER + "-*.csv` trouvé — section ignorée.");
  }
  md.push("");

  md.push("## 11. Conclusion");
  md.push("");
  md.push(`### Verdict : **${verdict.verdict}**`);
  md.push("");
  for (const r of verdict.rationale) md.push(`- ${r}`);
  md.push("");
  md.push("Échelle : *utile / trop tard / trop rare / bon WATCH / à améliorer*.");
  md.push("");

  const mdPath = path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.md");
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  const jsonPath = path.join(DEBUG_DIR, "manual-yellow-arrow-correlation-audit.json");
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ticker: TICKER,
    status: "ok",
    pineUsedAsSource: false,
    manualSource: loaded.path ? path.relative(ROOT, loaded.path) : "inline",
    ohlcCache: path.relative(ROOT, cacheFile(TICKER)),
    ohlcRange: { start: dataStart, end: dataEnd, bars: bars.length },
    tvDatesFile: tv.path ? path.relative(ROOT, tv.path) : null,
    snapToleranceDays: DATE_SNAP_TOLERANCE_DAYS,
    stats,
    verdict,
    arrows: audits,
    unmatched,
    missedDrawdowns,
    tvDates: tv.dates,
  }, null, 2), "utf8");

  console.log("\n" + "=".repeat(60));
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  ${path.relative(ROOT, mdPath)}`);
  console.log(`  ${path.relative(ROOT, jsonPath)}`);
  console.log("\n(Audit seulement — aucun commit, aucun git add.)");
}

main();
