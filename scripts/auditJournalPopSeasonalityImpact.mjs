#!/usr/bin/env node
/**
 * AUDIT READ-ONLY — Impact saisonnalité sur le Journal POP (Wheel)
 * ----------------------------------------------------------------
 * Mesure si les colonnes seasonality_* améliorent réellement les décisions Wheel.
 *
 * Ne modifie RIEN : lecture seule sur data/wheelValidationJournal.sqlite.
 *
 * Lancement :
 *   node --check scripts/auditJournalPopSeasonalityImpact.mjs
 *   node scripts/auditJournalPopSeasonalityImpact.mjs
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const TABLE = "wheel_validation_records";

const SEASONALITY_COLUMNS = [
  "seasonality_score_at_scan",
  "seasonality_win_rate_at_scan",
  "seasonality_best_window_start",
  "seasonality_best_window_end",
  "seasonality_direction",
  "seasonality_confidence",
  "seasonality_snapshot_version",
];

const COLUMN_CANDIDATES = {
  symbol: ["symbol"],
  dte: ["dteAtScan", "dte_at_scan", "dte"],
  mode: ["strikeMode", "selectedMode", "recommendationMode", "selected_mode", "mode"],
  pop: ["popEstimate", "pop_at_scan", "popAtScan", "pop"],
  yield: [
    "premium_to_spot_pct",
    "realizedReturnPct",
    "yield_at_scan",
    "yieldAtScan",
    "premiumYield",
    "yield",
    "annualizedYield",
  ],
  resolved: ["resolved", "isResolved"],
  assigned: ["assigned_flag", "assigned", "wasAssigned", "assignment", "isAssigned"],
  win: ["expired_otm", "expiredWorthless"],
  expiration: ["expiration", "expirationDate", "expiration_date"],
  scanDate: ["scanDate", "scan_date", "createdAt", "created_at"],
};

const WHEEL_PRIORITY_TICKERS = [
  "TQQQ", "APLD", "SOFI", "HOOD", "AMD", "NVDA", "TSLA", "PLTR", "SMCI", "MSTR",
  "RIVN", "AFRM", "DKNG", "RBLX", "UBER", "CVNA", "DOCU", "SHOP", "CRM", "PYPL",
  "BABA", "INTC", "MRVL", "CORZ", "IONQ", "RKLB", "ALAB", "CSCO", "CCL", "MGM",
  "TEM", "CZR", "ETSY", "ABNB", "ORCL", "WFC", "CVS", "SCHW",
];

const BUCKET_DEFS = [
  { key: "70+", label: "70+ favorable fort", min: 70, max: Infinity },
  { key: "55-69", label: "55–69 favorable/modéré", min: 55, max: 69.999 },
  { key: "45-54", label: "45–54 neutre", min: 45, max: 54.999 },
  { key: "30-44", label: "30–44 défavorable", min: 30, max: 44.999 },
  { key: "<30", label: "<30 très défavorable", min: -Infinity, max: 29.999 },
  { key: "NULL", label: "NULL (absent)", min: null, max: null },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function padNum(value, len, digits = 0) {
  if (value == null || !Number.isFinite(value)) return pad("—", len);
  const s = digits > 0 ? value.toFixed(digits) : String(Math.round(value));
  return " ".repeat(Math.max(0, len - s.length)) + s;
}

function pct(n, total) {
  if (!total) return "0.0 %";
  return `${((n / total) * 100).toFixed(1)} %`;
}

function avg(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function toBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return null;
}

function parseSeasonalityScore(row, scoreCol) {
  if (!scoreCol || !row) return null;
  const raw = row[scoreCol];
  if (raw == null || raw === "") return null;
  const score = Number(raw);
  return Number.isFinite(score) ? score : null;
}

function seasonalityBucket(score) {
  if (score == null || !Number.isFinite(score)) return "NULL";
  if (score >= 70) return "70+";
  if (score >= 55) return "55-69";
  if (score >= 45) return "45-54";
  if (score >= 30) return "30-44";
  return "<30";
}

function dominantValue(counts) {
  let best = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best ?? "—";
}

function resolveColumn(existingCols, candidates, label) {
  for (const name of candidates) {
    if (existingCols.has(name)) return { name, found: true };
  }
  console.log(`  Colonne absente : ${label} — section partielle ou ignorée`);
  return { name: null, found: false };
}

function getYieldPctAtScan(row, yieldCol) {
  const premium = Number(row?.premium);
  const strike = Number(row?.strike);
  const spot = Number(row?.spotAtScan);

  if (yieldCol === "premium_to_spot_pct") {
    const v = Number(row.premium_to_spot_pct);
    if (Number.isFinite(v)) return v;
  }
  if (yieldCol === "realizedReturnPct") {
    const v = Number(row.realizedReturnPct);
    if (Number.isFinite(v)) return v;
  }
  if (premium > 0 && strike > 0) return (premium / strike) * 100;
  if (premium > 0 && spot > 0) return (premium / spot) * 100;

  if (yieldCol) {
    const v = Number(row[yieldCol]);
    if (Number.isFinite(v)) {
      // annualizedYield est annualisé — pas idéal pour CSP par expiration
      if (yieldCol === "annualizedYield") return null;
      return v;
    }
  }
  return null;
}

function isWin(row, winCol, assignedCol, resolvedCol) {
  const resolved = toBool(row[resolvedCol]);
  if (resolved !== true) return null;

  if (winCol) {
    const winFlag = toBool(row[winCol]);
    if (winFlag === true) return true;
    if (winFlag === false) return false;
  }
  if (assignedCol) {
    const assigned = toBool(row[assignedCol]);
    if (assigned === true) return false;
    if (assigned === false) return true;
  }
  return null;
}

function isAssigned(row, assignedCol) {
  if (!assignedCol) return null;
  return toBool(row[assignedCol]);
}

function yieldGroup(yieldPct) {
  if (yieldPct == null || !Number.isFinite(yieldPct)) return null;
  if (yieldPct >= 1) return "1%+";
  if (yieldPct >= 0.5) return "0.5-1%";
  return "<0.5%";
}

function emptyBucketStats() {
  return {
    records: 0,
    tickers: new Set(),
    scores: [],
    seasonWinRates: [],
    resolved: 0,
    unresolved: 0,
    wins: 0,
    losses: 0,
    unknownOutcome: 0,
    assigned: 0,
    yields: [],
    pops: [],
    modes: new Map(),
    dtes: [],
  };
}

function finalizeBucketStats(stats) {
  const outcomeKnown = stats.wins + stats.losses;
  return {
    records: stats.records,
    tickers: stats.tickers.size,
    avgScore: avg(stats.scores),
    avgSeasonWinRate: avg(stats.seasonWinRates),
    resolved: stats.resolved,
    unresolved: stats.unresolved,
    winRate: outcomeKnown > 0 ? (stats.wins / outcomeKnown) * 100 : null,
    assignmentRate: stats.resolved > 0 ? (stats.assigned / stats.resolved) * 100 : null,
    avgYield: avg(stats.yields),
    avgPop: avg(stats.pops),
    modes: stats.modes,
    avgDte: avg(stats.dtes),
    wins: stats.wins,
    losses: stats.losses,
    unknownOutcome: stats.unknownOutcome,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(SQLITE_PATH)) {
    console.error(`Fichier introuvable : ${SQLITE_PATH}`);
    process.exit(1);
  }

  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  const tableCols = db.prepare(`PRAGMA table_info(${TABLE})`).all();
  const existingCols = new Set(tableCols.map((c) => c.name));

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  AUDIT READ-ONLY — Impact saisonnalité Journal POP (Wheel)");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Source : ${SQLITE_PATH}`);
  console.log(`  Table  : ${TABLE}`);
  console.log("");

  // ── Colonnes détectées ─────────────────────────────────────────────────────
  console.log("── COLONNES DÉTECTÉES ────────────────────────────────────────────────");

  const seasonalityPresent = {};
  for (const col of SEASONALITY_COLUMNS) {
    seasonalityPresent[col] = existingCols.has(col);
    if (!seasonalityPresent[col]) {
      console.log(`  Colonne absente : ${col} — section ignorée`);
    } else {
      console.log(`  ✓ ${col}`);
    }
  }

  const resolvedCols = {};
  for (const [key, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    resolvedCols[key] = resolveColumn(existingCols, candidates, key);
  }

  console.log("");
  console.log("  Colonnes performance mappées :");
  for (const [key, res] of Object.entries(resolvedCols)) {
    console.log(`    · ${key.padEnd(10)} → ${res.found ? res.name : "(absente)"}`);
  }
  console.log("");

  const scoreCol = seasonalityPresent.seasonality_score_at_scan
    ? "seasonality_score_at_scan"
    : null;
  const seasonWrCol = seasonalityPresent.seasonality_win_rate_at_scan
    ? "seasonality_win_rate_at_scan"
    : null;
  const directionCol = seasonalityPresent.seasonality_direction
    ? "seasonality_direction"
    : null;
  const confidenceCol = seasonalityPresent.seasonality_confidence
    ? "seasonality_confidence"
    : null;

  const symbolCol = resolvedCols.symbol.name ?? "symbol";
  const dteCol = resolvedCols.dte.name;
  const modeCol = resolvedCols.mode.name;
  const popCol = resolvedCols.pop.name;
  const yieldCol = resolvedCols.yield.found
    ? resolvedCols.yield.name
    : existingCols.has("premium") && existingCols.has("strike")
      ? "(premium/strike calculé)"
      : null;
  const resolvedCol = resolvedCols.resolved.name;
  const assignedCol = resolvedCols.assigned.name;
  const winCol = resolvedCols.win.name;

  const selectCols = new Set([
    symbolCol,
    ...SEASONALITY_COLUMNS.filter((c) => existingCols.has(c)),
    dteCol,
    modeCol,
    popCol,
    resolvedCol,
    assignedCol,
    winCol,
    "premium",
    "strike",
    "spotAtScan",
    "premium_to_spot_pct",
    "realizedReturnPct",
    "annualizedYield",
  ].filter(Boolean));

  const rows = db
    .prepare(`SELECT ${[...selectCols].join(", ")} FROM ${TABLE}`)
    .all();

  const total = rows.length;
  const withScore = scoreCol
    ? rows.filter((r) => parseSeasonalityScore(r, scoreCol) != null).length
    : 0;
  const remaining = total - withScore;

  const remainingTickers = scoreCol
    ? [...new Set(
        rows
          .filter((r) => parseSeasonalityScore(r, scoreCol) == null)
          .map((r) => normalizeSymbol(r[symbolCol]))
          .filter(Boolean),
      )].sort()
    : [];

  // ── 1. Couverture ────────────────────────────────────────────────────────
  console.log("── 1. COUVERTURE SAISONNALITÉ ───────────────────────────────────────");
  console.log(`  Total records                              : ${total}`);
  if (scoreCol) {
    console.log(`  Records avec seasonality_score_at_scan     : ${withScore}`);
    console.log(`  % rempli                                   : ${pct(withScore, total)}`);
    console.log(`  Records restants (score null)              : ${remaining}`);
    console.log(`  Tickers restants (score null)              : ${remainingTickers.length}`);
    if (remainingTickers.length > 0 && remainingTickers.length <= 40) {
      console.log(`  Liste tickers manquants                    : ${remainingTickers.join(", ")}`);
    } else if (remainingTickers.length > 40) {
      console.log(`  Liste tickers manquants (40 premiers)      : ${remainingTickers.slice(0, 40).join(", ")} …`);
    }
  } else {
    console.log("  Section ignorée — colonne seasonality_score_at_scan absente.");
  }
  console.log("");

  // ── 2. Buckets saisonnalité ──────────────────────────────────────────────
  console.log("── 2. RÉPARTITION PAR BUCKET SAISONNALITÉ ───────────────────────────");
  if (!scoreCol) {
    console.log("  Section ignorée — score saisonnalité indisponible.");
  } else {
    const bucketMap = new Map(BUCKET_DEFS.map((b) => [b.key, emptyBucketStats()]));

    for (const row of rows) {
      const score = parseSeasonalityScore(row, scoreCol);
      const bucket = seasonalityBucket(score);
      const stats = bucketMap.get(bucket);
      stats.records += 1;
      stats.tickers.add(normalizeSymbol(row[symbolCol]));
      if (Number.isFinite(score)) stats.scores.push(score);
      if (seasonWrCol) {
        const swr = Number(row[seasonWrCol]);
        if (Number.isFinite(swr)) stats.seasonWinRates.push(swr * 100);
      }
    }

    console.log(
      `  ${pad("Bucket", 22)}${pad("Records", 10)}${pad("Tickers", 9)}${pad("Score moy.", 12)}${pad("WR sais. moy.", 14)}`,
    );
    console.log("  " + "-".repeat(66));
    for (const def of BUCKET_DEFS) {
      const f = finalizeBucketStats(bucketMap.get(def.key));
      console.log(
        `  ${pad(def.label, 22)}${padNum(f.records, 8)}  ${padNum(f.tickers, 7)}  ${padNum(f.avgScore, 10, 1)}  ${padNum(f.avgSeasonWinRate, 12, 1)}%`,
      );
    }
  }
  console.log("");

  // ── 3 & 4. Top tickers favorables / défavorables ─────────────────────────
  function printTickerRankings(title, filterFn, limit = 15) {
    console.log(title);
    if (!scoreCol) {
      console.log("  Section ignorée — score saisonnalité indisponible.");
      return;
    }

    const byTicker = new Map();
    for (const row of rows) {
      const sym = normalizeSymbol(row[symbolCol]);
      const score = parseSeasonalityScore(row, scoreCol);
      if (!sym || score == null || !filterFn(score)) continue;

      if (!byTicker.has(sym)) {
        byTicker.set(sym, {
          symbol: sym,
          records: 0,
          scores: [],
          directions: new Map(),
          confidences: new Map(),
        });
      }
      const t = byTicker.get(sym);
      t.records += 1;
      t.scores.push(score);
      if (directionCol) {
        const d = String(row[directionCol] ?? "—");
        t.directions.set(d, (t.directions.get(d) ?? 0) + 1);
      }
      if (confidenceCol) {
        const c = String(row[confidenceCol] ?? "—");
        t.confidences.set(c, (t.confidences.get(c) ?? 0) + 1);
      }
    }

    const ranked = [...byTicker.values()]
      .map((t) => ({
        ...t,
        avg: avg(t.scores),
        min: Math.min(...t.scores),
        max: Math.max(...t.scores),
        dir: dominantValue(t.directions),
        conf: dominantValue(t.confidences),
      }))
      .sort((a, b) => b.avg - a.avg || b.records - a.records)
      .slice(0, limit);

    if (ranked.length === 0) {
      console.log("  (aucun ticker dans cette catégorie)");
      return;
    }

    console.log(
      `  ${pad("Ticker", 8)}${pad("Rec.", 6)}${pad("Min", 6)}${pad("Moy.", 6)}${pad("Max", 6)}${pad("Direction", 16)}Confidence`,
    );
    console.log("  " + "-".repeat(62));
    for (const t of ranked) {
      console.log(
        `  ${pad(t.symbol, 8)}${padNum(t.records, 4)}  ${padNum(t.min, 4)}  ${padNum(t.avg, 4, 0)}  ${padNum(t.max, 4)}  ${pad(t.dir, 16)}${t.conf}`,
      );
    }
  }

  printTickerRankings(
    "── 3. TOP TICKERS FAVORABLES (score ≥ 55) ──────────────────────────",
    (s) => s >= 55,
  );
  console.log("");
  // Section 4 — défavorables triés par score croissant (les pires en premier)
  if (scoreCol) {
    console.log("── 4. TOP TICKERS DÉFAVORABLES (score < 45) ────────────────────────");
    const byTicker = new Map();
    for (const row of rows) {
      const sym = normalizeSymbol(row[symbolCol]);
      const score = parseSeasonalityScore(row, scoreCol);
      if (!sym || score == null || score >= 45) continue;
      if (!byTicker.has(sym)) {
        byTicker.set(sym, { symbol: sym, records: 0, scores: [], directions: new Map(), confidences: new Map() });
      }
      const t = byTicker.get(sym);
      t.records += 1;
      t.scores.push(score);
      if (directionCol) {
        const d = String(row[directionCol] ?? "—");
        t.directions.set(d, (t.directions.get(d) ?? 0) + 1);
      }
      if (confidenceCol) {
        const c = String(row[confidenceCol] ?? "—");
        t.confidences.set(c, (t.confidences.get(c) ?? 0) + 1);
      }
    }
    const ranked = [...byTicker.values()]
      .map((t) => ({
        ...t,
        avg: avg(t.scores),
        min: Math.min(...t.scores),
        max: Math.max(...t.scores),
        dir: dominantValue(t.directions),
        conf: dominantValue(t.confidences),
      }))
      .sort((a, b) => a.avg - b.avg || b.records - a.records)
      .slice(0, 15);

    if (ranked.length === 0) {
      console.log("  (aucun ticker défavorable)");
    } else {
      console.log(
        `  ${pad("Ticker", 8)}${pad("Rec.", 6)}${pad("Min", 6)}${pad("Moy.", 6)}${pad("Max", 6)}${pad("Direction", 16)}Confidence`,
      );
      console.log("  " + "-".repeat(62));
      for (const t of ranked) {
        console.log(
          `  ${pad(t.symbol, 8)}${padNum(t.records, 4)}  ${padNum(t.min, 4)}  ${padNum(t.avg, 4, 0)}  ${padNum(t.max, 4)}  ${pad(t.dir, 16)}${t.conf}`,
        );
      }
    }
    console.log("");
  }

  // ── 5. Tickers Wheel prioritaires ────────────────────────────────────────
  console.log("── 5. TICKERS WHEEL PRIORITAIRES ────────────────────────────────────");
  if (!scoreCol) {
    console.log("  Section ignorée — score saisonnalité indisponible.");
  } else {
    const tickerSummary = new Map();
    for (const row of rows) {
      const sym = normalizeSymbol(row[symbolCol]);
      if (!sym) continue;
      if (!tickerSummary.has(sym)) {
        tickerSummary.set(sym, {
          total: 0,
          withScore: 0,
          scores: [],
          directions: new Map(),
          confidences: new Map(),
        });
      }
      const t = tickerSummary.get(sym);
      t.total += 1;
      const score = parseSeasonalityScore(row, scoreCol);
      if (score != null) {
        t.withScore += 1;
        t.scores.push(score);
        if (directionCol) {
          const d = String(row[directionCol] ?? "—");
          t.directions.set(d, (t.directions.get(d) ?? 0) + 1);
        }
        if (confidenceCol) {
          const c = String(row[confidenceCol] ?? "—");
          t.confidences.set(c, (t.confidences.get(c) ?? 0) + 1);
        }
      }
    }

    const complete = [];
    const missing = [];
    for (const sym of WHEEL_PRIORITY_TICKERS) {
      const t = tickerSummary.get(sym);
      if (!t || t.withScore === 0) {
        missing.push({ symbol: sym, total: t?.total ?? 0 });
      } else if (t.withScore === t.total) {
        complete.push({
          symbol: sym,
          records: t.total,
          avgScore: avg(t.scores),
          direction: dominantValue(t.directions),
          confidence: dominantValue(t.confidences),
        });
      } else {
        missing.push({
          symbol: sym,
          total: t.total,
          partial: t.withScore,
          avgScore: avg(t.scores),
          direction: dominantValue(t.directions),
          confidence: dominantValue(t.confidences),
        });
      }
    }

    console.log(`  Prioritaires avec saisonnalité complète : ${complete.length} / ${WHEEL_PRIORITY_TICKERS.length}`);
    if (complete.length > 0) {
      console.log(
        `  ${pad("Ticker", 8)}${pad("Rec.", 6)}${pad("Score moy.", 12)}${pad("Direction", 16)}Confidence`,
      );
      console.log("  " + "-".repeat(54));
      for (const t of complete.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))) {
        console.log(
          `  ${pad(t.symbol, 8)}${padNum(t.records, 4)}  ${padNum(t.avgScore, 10, 0)}  ${pad(t.direction, 16)}${t.confidence}`,
        );
      }
    }

    console.log("");
    console.log(`  Prioritaires encore manquants ou partiels : ${missing.length}`);
    if (missing.length > 0) {
      for (const m of missing) {
        if (m.partial != null) {
          console.log(
            `    ${pad(m.symbol, 8)} partiel ${m.partial}/${m.total} — score moy. ${m.avgScore != null ? m.avgScore.toFixed(0) : "—"} · ${m.direction} · ${m.confidence}`,
          );
        } else {
          console.log(`    ${pad(m.symbol, 8)} aucun score (${m.total} record(s) sans saisonnalité)`);
        }
      }
    }
  }
  console.log("");

  // ── 6. Croisement performance ────────────────────────────────────────────
  console.log("── 6. CROISEMENT PERFORMANCE (résultats réels) ──────────────────────");

  const canPerformance =
    scoreCol && resolvedCol && (assignedCol || winCol);

  if (!canPerformance) {
    console.log("  Sections performance impossibles — colonnes manquantes :");
    if (!scoreCol) console.log("    · seasonality_score_at_scan");
    if (!resolvedCol) console.log("    · resolved / isResolved");
    if (!assignedCol && !winCol) console.log("    · assigned / expired_otm / expiredWorthless");
  } else {
    const perfBuckets = new Map(BUCKET_DEFS.map((b) => [b.key, emptyBucketStats()]));

    for (const row of rows) {
      const score = parseSeasonalityScore(row, scoreCol);
      const bucket = seasonalityBucket(score);
      const stats = perfBuckets.get(bucket);
      stats.records += 1;
      stats.tickers.add(normalizeSymbol(row[symbolCol]));

      const resolved = toBool(row[resolvedCol]);
      if (resolved === true) stats.resolved += 1;
      else stats.unresolved += 1;

      const outcome = isWin(row, winCol, assignedCol, resolvedCol);
      if (outcome === true) stats.wins += 1;
      else if (outcome === false) stats.losses += 1;
      else if (resolved === true) stats.unknownOutcome += 1;

      const assigned = isAssigned(row, assignedCol);
      if (assigned === true) stats.assigned += 1;

      const y = getYieldPctAtScan(row, resolvedCols.yield.name);
      if (y != null) stats.yields.push(y);

      if (popCol) {
        const pop = Number(row[popCol]);
        if (Number.isFinite(pop)) stats.pops.push(pop <= 1 ? pop * 100 : pop);
      }

      if (dteCol) {
        const dte = Number(row[dteCol]);
        if (Number.isFinite(dte)) stats.dtes.push(dte);
      }

      if (modeCol) {
        const mode = String(row[modeCol] ?? "—").toLowerCase();
        stats.modes.set(mode, (stats.modes.get(mode) ?? 0) + 1);
      }
    }

    console.log("  Colonnes utilisées :");
    console.log(`    · score      : ${scoreCol}`);
    console.log(`    · résolu     : ${resolvedCol}`);
    console.log(`    · assignation: ${assignedCol ?? winCol ?? "—"}`);
    console.log(`    · victoire   : ${winCol ?? "(dérivé de non-assignation)"}`);
    if (yieldCol) console.log(`    · rendement  : ${yieldCol}`);
    if (popCol) console.log(`    · POP        : ${popCol}`);
    if (modeCol) console.log(`    · mode       : ${modeCol}`);
    if (dteCol) console.log(`    · DTE        : ${dteCol}`);
    console.log("");

    console.log(
      `  ${pad("Bucket", 22)}${pad("Résolus", 9)}${pad("Win %", 8)}${pad("Assign %", 10)}${pad("Rend. moy.", 11)}${pad("POP moy.", 9)}`,
    );
    console.log("  " + "-".repeat(68));
    for (const def of BUCKET_DEFS) {
      const f = finalizeBucketStats(perfBuckets.get(def.key));
      console.log(
        `  ${pad(def.label, 22)}${padNum(f.resolved, 7)}  ${padNum(f.winRate, 6, 1)}%  ${padNum(f.assignmentRate, 8, 1)}%  ${padNum(f.avgYield, 9, 2)}%  ${padNum(f.avgPop, 7, 1)}%`,
      );
    }

    const totalResolved = rows.filter((r) => toBool(r[resolvedCol]) === true).length;
    const totalUnresolved = total - totalResolved;
    console.log("");
    console.log(`  Records résolus   : ${totalResolved}`);
    console.log(`  Records en attente: ${totalUnresolved}`);

    // SAFE vs AGGRESSIVE par bucket
    if (modeCol) {
      console.log("");
      console.log("  Comparaison SAFE vs AGGRESSIVE par bucket :");
      const modeBuckets = new Map();
      for (const row of rows) {
        const score = parseSeasonalityScore(row, scoreCol);
        const bucket = seasonalityBucket(score);
        const mode = String(row[modeCol] ?? "").toLowerCase();
        if (!mode.includes("safe") && !mode.includes("aggr")) continue;
        const key = `${bucket}|${mode.includes("aggr") ? "aggressive" : "safe"}`;
        if (!modeBuckets.has(key)) {
          modeBuckets.set(key, { wins: 0, losses: 0, records: 0 });
        }
        const s = modeBuckets.get(key);
        s.records += 1;
        const outcome = isWin(row, winCol, assignedCol, resolvedCol);
        if (outcome === true) s.wins += 1;
        else if (outcome === false) s.losses += 1;
      }

      for (const def of BUCKET_DEFS) {
        const safe = modeBuckets.get(`${def.key}|safe`);
        const aggr = modeBuckets.get(`${def.key}|aggressive`);
        const safeWr = safe && safe.wins + safe.losses > 0
          ? ((safe.wins / (safe.wins + safe.losses)) * 100).toFixed(1)
          : "—";
        const aggrWr = aggr && aggr.wins + aggr.losses > 0
          ? ((aggr.wins / (aggr.wins + aggr.losses)) * 100).toFixed(1)
          : "—";
        console.log(
          `    ${pad(def.label, 22)} SAFE win ${pad(safeWr === "—" ? safeWr : safeWr + "%", 8)} (${safe?.records ?? 0} rec.) · AGGR win ${pad(aggrWr === "—" ? aggrWr : aggrWr + "%", 8)} (${aggr?.records ?? 0} rec.)`,
        );
      }
    } else {
      console.log("");
      console.log("  Comparaison SAFE vs AGGRESSIVE : ignorée (colonne mode absente).");
    }

    // DTE par bucket
    if (dteCol) {
      const dteFilled = rows.filter((r) => Number.isFinite(Number(r[dteCol]))).length;
      console.log("");
      console.log(`  DTE disponible sur ${dteFilled} / ${total} records.`);
      if (dteFilled > 0) {
        console.log("  DTE moyen par bucket :");
        for (const def of BUCKET_DEFS) {
          const f = finalizeBucketStats(perfBuckets.get(def.key));
          console.log(`    ${pad(def.label, 22)} ${f.avgDte != null ? f.avgDte.toFixed(1) + " j" : "—"}`);
        }
      }
    } else {
      console.log("");
      console.log("  Analyse par DTE : ignorée (colonne DTE absente).");
    }
  }
  console.log("");

  // ── 7. Rapport CSP 1%+ ───────────────────────────────────────────────────
  console.log("── 7. RAPPORT CSP 1 %+ (rendement au scan) ──────────────────────────");

  const hasYield =
    resolvedCols.yield.found ||
    (existingCols.has("premium") && existingCols.has("strike"));

  if (!hasYield || !scoreCol) {
    console.log("  Section ignorée — colonne rendement ou score saisonnalité absente.");
  } else {
    const yieldSource = resolvedCols.yield.name ?? "premium/strike calculé";
    console.log(`  Source rendement : ${yieldSource}`);
    console.log("  Groupes rendement : ≥1 % · 0,5–1 % · <0,5 %");
    console.log("");

    const yieldGroups = { "1%+": 0, "0.5-1%": 0, "<0.5%": 0, null: 0 };
    const csp1Cross = {
      "70+": { total: 0, wins: 0, losses: 0, assigned: 0, resolved: 0 },
      "55-69": { total: 0, wins: 0, losses: 0, assigned: 0, resolved: 0 },
      "45-54": { total: 0, wins: 0, losses: 0, assigned: 0, resolved: 0 },
      "<45": { total: 0, wins: 0, losses: 0, assigned: 0, resolved: 0 },
      NULL: { total: 0, wins: 0, losses: 0, assigned: 0, resolved: 0 },
    };

    for (const row of rows) {
      const y = getYieldPctAtScan(row, resolvedCols.yield.name);
      const yg = yieldGroup(y);
      if (yg) yieldGroups[yg] += 1;
      else yieldGroups.null += 1;

      if (y == null || y < 1) continue;

      const score = parseSeasonalityScore(row, scoreCol);
      let crossKey;
      if (score == null) crossKey = "NULL";
      else if (score >= 70) crossKey = "70+";
      else if (score >= 55) crossKey = "55-69";
      else if (score >= 45) crossKey = "45-54";
      else crossKey = "<45";

      const cell = csp1Cross[crossKey];
      cell.total += 1;

      if (resolvedCol && toBool(row[resolvedCol]) === true) {
        cell.resolved += 1;
        const outcome = isWin(row, winCol, assignedCol, resolvedCol);
        if (outcome === true) cell.wins += 1;
        else if (outcome === false) cell.losses += 1;
        if (isAssigned(row, assignedCol) === true) cell.assigned += 1;
      }
    }

    console.log("  Répartition rendement (tous records) :");
    console.log(`    ≥ 1 %     : ${yieldGroups["1%+"]}`);
    console.log(`    0,5–1 %   : ${yieldGroups["0.5-1%"]}`);
    console.log(`    < 0,5 %   : ${yieldGroups["<0.5%"]}`);
    console.log(`    inconnu   : ${yieldGroups.null}`);
    console.log("");
    console.log("  Trades CSP ≥ 1 % croisés avec saisonnalité :");
    console.log(
      `  ${pad("Bucket sais.", 14)}${pad("Trades 1%+", 12)}${pad("Résolus", 9)}${pad("Win %", 8)}${pad("Assign %", 10)}`,
    );
    console.log("  " + "-".repeat(52));
    for (const [key, label] of [
      ["70+", "score ≥ 70"],
      ["55-69", "score 55–69"],
      ["45-54", "score 45–54"],
      ["<45", "score < 45"],
      ["NULL", "score NULL"],
    ]) {
      const c = csp1Cross[key];
      const wr = c.wins + c.losses > 0 ? ((c.wins / (c.wins + c.losses)) * 100).toFixed(1) : "—";
      const ar = c.resolved > 0 ? ((c.assigned / c.resolved) * 100).toFixed(1) : "—";
      console.log(
        `  ${pad(label, 14)}${padNum(c.total, 10)}  ${padNum(c.resolved, 7)}  ${pad(wr === "—" ? wr : wr + "%", 7)}  ${pad(ar === "—" ? ar : ar + "%", 9)}`,
      );
    }
  }
  console.log("");

  // ── 8. Conclusion automatique ────────────────────────────────────────────
  console.log("── 8. CONCLUSION AUTOMATIQUE ────────────────────────────────────────");

  let conclusion = "Données insuffisantes";
  let conclusionDetail = "";

  if (canPerformance && scoreCol) {
    const perfBuckets = new Map(BUCKET_DEFS.map((b) => [b.key, emptyBucketStats()]));
    for (const row of rows) {
      const score = parseSeasonalityScore(row, scoreCol);
      const bucket = seasonalityBucket(score);
      const stats = perfBuckets.get(bucket);
      if (toBool(row[resolvedCol]) === true) stats.resolved += 1;
      const outcome = isWin(row, winCol, assignedCol, resolvedCol);
      if (outcome === true) stats.wins += 1;
      else if (outcome === false) stats.losses += 1;
    }

    const fav = finalizeBucketStats(perfBuckets.get("70+"));
    const mod = finalizeBucketStats(perfBuckets.get("55-69"));
    const neu = finalizeBucketStats(perfBuckets.get("45-54"));
    const def = finalizeBucketStats(perfBuckets.get("30-44"));
    const bad = finalizeBucketStats(perfBuckets.get("<30"));

    const totalResolvedForConclusion =
      fav.resolved + mod.resolved + neu.resolved + def.resolved + bad.resolved;
    const favWr = avg([fav.winRate, mod.winRate].filter((v) => v != null));
    const unfavWr = avg([def.winRate, bad.winRate].filter((v) => v != null));
    const neuWr = neu.winRate;

    if (totalResolvedForConclusion < 50) {
      conclusion = "Données insuffisantes";
      conclusionDetail = `Seulement ${totalResolvedForConclusion} records résolus avec score — échantillon trop petit pour conclure.`;
    } else if (favWr != null && unfavWr != null && favWr - unfavWr >= 5) {
      conclusion = "Saisonnalité exploitable";
      conclusionDetail = `Win rate moyen buckets favorables (70+ / 55–69) : ${favWr.toFixed(1)} % vs défavorables (30–44 / <30) : ${unfavWr.toFixed(1)} % (écart ≥ 5 pts).`;
    } else if (favWr != null && unfavWr != null && Math.abs(favWr - unfavWr) < 3) {
      conclusion = "Saisonnalité à utiliser comme filtre secondaire";
      conclusionDetail = `Écart win rate favorable vs défavorable faible (${(favWr - unfavWr).toFixed(1)} pts). Neutre : ${neuWr != null ? neuWr.toFixed(1) + " %" : "—"}.`;
    } else {
      conclusion = "Saisonnalité à utiliser comme filtre secondaire";
      conclusionDetail = `Signal mitigé — favorable ${favWr != null ? favWr.toFixed(1) + " %" : "—"}, défavorable ${unfavWr != null ? unfavWr.toFixed(1) + " %" : "—"}, neutre ${neuWr != null ? neuWr.toFixed(1) + " %" : "—"}.`;
    }
  } else {
    conclusionDetail = "Colonnes performance ou score manquantes — impossible de comparer les buckets.";
  }

  console.log(`  Verdict : ${conclusion}`);
  console.log(`  Détail  : ${conclusionDetail}`);
  console.log("");

  // ── 9. Recommandations ───────────────────────────────────────────────────
  console.log("── 9. RECOMMANDATIONS (seuils à valider avec résultats réels) ───────");
  console.log("  Seuils saisonnalité proposés pour le Journal POP :");
  console.log("    · score ≥ 70      → bonus / contexte favorable fort");
  console.log("    · score 55–69     → neutre positif");
  console.log("    · score 45–54     → neutre (pas de filtre)");
  console.log("    · score 30–44     → prudence");
  console.log("    · score < 30      → alerte / éviter si autre signal faible");
  console.log("");
  console.log("  IMPORTANT : ces seuils sont indicatifs. Valider avec :");
  console.log("    · win rate réel par bucket (section 6)");
  console.log("    · taux d'assignation par bucket");
  console.log("    · croisement CSP 1 %+ (section 7)");
  console.log("    · tickers prioritaires Wheel (section 5)");
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  Audit terminé — AUCUNE écriture effectuée (lecture seule).");
  console.log("══════════════════════════════════════════════════════════════════════");
}

main();
