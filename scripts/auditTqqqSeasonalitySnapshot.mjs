/**
 * Audit temporaire — origine du score seasonality TQQQ (Journal POP).
 * Usage: node scripts/auditTqqqSeasonalitySnapshot.mjs
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotFromBundle } from "../app/journal/seasonalitySnapshot.js";
import {
  buildSeasonalityDecisionHeader,
  computeWeeklySeasonalityScore,
  computeAnnualWindowScore,
} from "../app/seasonality/seasonalityDecisionScores.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = path.resolve(ROOT, "data", "wheelValidationJournal.sqlite");
const SYMBOL = "TQQQ";
const AS_OF = new Date("2026-06-05T12:00:00Z");

function section(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function isWindowActiveToday(w, today) {
  const d = today ?? new Date();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const sm = w.startMonth;
  const em = w.endMonth;
  if (typeof sm !== "number" || typeof em !== "number") return false;
  const sd = w.startDay ?? 1;
  const ed = w.endDay ?? 28;
  const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const doy = (m, dd) => {
    let v = dd;
    for (let i = 1; i < m; i++) v += DAYS[i];
    return v;
  };
  const todayDOY = doy(month, day);
  const startDOY = doy(sm, sd);
  const endDOY = doy(em, ed);
  if (startDOY <= endDOY) return todayDOY >= startDOY && todayDOY <= endDOY;
  return todayDOY >= startDOY || todayDOY <= endDOY;
}

function listActiveWindows(pool, label, today) {
  if (!Array.isArray(pool) || !pool.length) {
    console.log(`  ${label}: (vide)`);
    return [];
  }
  const active = pool.filter((w) => isWindowActiveToday(w, today));
  console.log(`  ${label}: ${pool.length} total, ${active.length} active(s) le ${today.toISOString().slice(0, 10)}`);
  for (const w of active) {
    console.log(`    · ${w.displayLabel ?? "?"} | strength=${w.strength ?? "?"} | ${w.startMonth}/${w.startDay} → ${w.endMonth}/${w.endDay}`);
  }
  return active;
}

const db = new DatabaseSync(DB_PATH);
const row = db
  .prepare(
    `SELECT payload_json, computed_at FROM seasonality_cache
     WHERE ticker = ? AND cache_version = 'annual-display-v1'`
  )
  .get(SYMBOL);

if (!row) {
  console.error(`Cache absent pour ${SYMBOL}`);
  process.exit(1);
}

const payload = JSON.parse(row.payload_json);
const { shortTermData, windowsData } = payload;
const w7j = shortTermData?.windows?.find((w) => w.days === 7) ?? null;

const header = buildSeasonalityDecisionHeader({
  shortTermData,
  windowsData,
  today: AS_OF,
});
const snap = buildSnapshotFromBundle(payload, {
  computedAt: row.computed_at,
  today: AS_OF,
});

section("1. SNAPSHOT Journal POP (buildSnapshotFromBundle)");
console.log(JSON.stringify(snap, null, 2));

section("2. SOURCE EXACTE DU SCORE");
const weekly = header.weeklyScore;
const annual = header.annualWindowScore;
console.log(`Score utilisé (priorité weekly): ${snap.seasonality_score_at_scan}`);
console.log(`  weeklyScore.score     = ${weekly?.score} (${weekly?.source}, conf=${weekly?.confidence})`);
console.log(`  annualWindowScore.score = ${annual?.score} (active=${annual?.activeWindow?.displayLabel ?? "aucune"})`);
console.log(`  Règle: weeklyScore ?? annualScore (si fenêtre active)`);
console.log(`  Direction: score < 45 ⇒ défavorable (seuil snapshot)`);

section("3. DÉCOMPOSITION weeklyScore (calendrier / shortTermData)");
console.log(JSON.stringify(weekly?.reasons ?? [], null, 2));
if (weekly?.warnings?.length) {
  console.log("Warnings:", weekly.warnings);
}

section("4. calendarWeek (shortTermData — source primaire du score)");
console.log(JSON.stringify(shortTermData?.calendarWeek ?? null, null, 2));

section("5. annualWindowScore (windowsData.annualDisplayWindows — fallback seulement)");
console.log(JSON.stringify(
  {
    score: annual?.score,
    label: annual?.label,
    confidence: annual?.confidence,
    activeWindow: annual?.activeWindow,
    reasons: annual?.reasons,
  },
  null,
  2
));

section("6. FENÊTRES ACTIVES — annualDisplayWindows (utilisé par computeAnnualWindowScore)");
const adw = windowsData?.annualDisplayWindows ?? {};
listActiveWindows(adw.bullish, "annualDisplayWindows.bullish", AS_OF);
listActiveWindows(windowsData?.recentBearishVigilance, "recentBearishVigilance", AS_OF);
listActiveWindows(windowsData?.bestBearishAnnualWindows, "bestBearishAnnualWindows", AS_OF);

section("7. FENÊTRES ACTIVES — clusters (UI, NON utilisé par snapshot)");
const clusters = windowsData?.clusters ?? {};
for (const c of clusters.bullish ?? []) {
  const bw = c.bestWindow ?? c;
  const active = isWindowActiveToday(
    { startMonth: bw.startMonth, startDay: bw.startDay, endMonth: bw.endMonth, endDay: bw.endDay },
    AS_OF
  );
  if (active) {
    console.log(`  BULLISH cluster actif: ${bw.displayLabel} | score=${c.score ?? bw.score ?? "?"} | verdict=${c.verdict ?? "?"}`);
    console.log(`    startDateCurrentYear=${bw.startDateCurrentYear} endDateCurrentYear=${bw.endDateCurrentYear}`);
    console.log(`    winRate=${bw.winRate} avgReturn=${bw.avgReturn}`);
  }
}
for (const c of clusters.bearish ?? []) {
  const bw = c.bestWindow ?? c;
  const active = isWindowActiveToday(
    { startMonth: bw.startMonth, startDay: bw.startDay, endMonth: bw.endMonth, endDay: bw.endDay },
    AS_OF
  );
  if (active) {
    console.log(`  BEARISH cluster actif: ${bw.displayLabel} | score=${c.score ?? "?"} | verdict=${c.verdict ?? "?"}`);
  }
}
if (!(clusters.bullish?.length || clusters.bearish?.length)) {
  console.log("  (pas de clusters dans le payload)");
}

section("8. COMPARAISON annualDisplayWindows.bullish[0] vs clusters.bullish[0]");
console.log("annualDisplayWindows.bullish[0]:");
console.log(JSON.stringify(adw.bullish?.[0] ?? null, null, 2));
console.log("\nclusters.bullish[0].bestWindow:");
console.log(JSON.stringify(clusters.bullish?.[0]?.bestWindow ?? null, null, 2));

section("9. wheel_validation_records TQQQ (échantillon)");
const wvrRows = db
  .prepare(
    `SELECT id, symbol, scanDate, seasonality_score_at_scan, seasonality_direction,
            seasonality_confidence, seasonality_best_window_start, seasonality_best_window_end,
            seasonality_snapshot_version
     FROM wheel_validation_records
     WHERE symbol = ? AND seasonality_score_at_scan IS NOT NULL
     ORDER BY scanDate DESC LIMIT 8`
  )
  .all(SYMBOL);
console.log(JSON.stringify(wvrRows, null, 2));

section("10. SECTIONS JSON UTILISÉES PAR buildSnapshotFromBundle");
console.log(`
  seasonality_score_at_scan  → header.weeklyScore.score (PRIMAIRE)
                               fallback header.annualWindowScore.score si weekly absent
  seasonality_win_rate       → shortTermData.calendarWeek.winRate (fallback windows 7j)
  seasonality_direction      → deriveDirection(score) — seuils 65/45
  seasonality_confidence     → weeklyScore.confidence (prioritaire)
  seasonality_best_window_*  → windowsData.annualDisplayWindows (via activeWindow label)
  NON utilisé pour le score  → calendarData, chart3yData, windowsData.clusters
`);
