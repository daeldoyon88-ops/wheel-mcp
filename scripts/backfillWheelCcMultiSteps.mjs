/**
 * backfillWheelCcMultiSteps.mjs
 *
 * POP V2 Phase 2 — backfill multi-week CC simulation after CSP assignment.
 *
 * Usage:
 *   node scripts/backfillWheelCcMultiSteps.mjs              # dry-run (default)
 *   node scripts/backfillWheelCcMultiSteps.mjs --write      # persist to local DB
 *   node scripts/backfillWheelCcMultiSteps.mjs --write --force  # recalculate all cycles
 *   node scripts/backfillWheelCcMultiSteps.mjs --write --limit=10
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";
import { createMarketService } from "../app/services/marketService.js";
import { YahooMarketDataProvider } from "../app/data_providers/yahooMarketDataProvider.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

const args = process.argv.slice(2);
const dryRun = !args.includes("--write");
const forceRefresh = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

function header(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function countMultiCc(db) {
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles").get()?.cnt ?? 0;
  const backfilled = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE multi_cc_backfilled_at IS NOT NULL")
    .get()?.cnt ?? 0;
  const pending = total - backfilled;
  const stepsTotal = db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps").get()?.cnt ?? 0;
  const stepsSold = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_sold_theoretical = 1")
    .get()?.cnt ?? 0;
  const stepsWait = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_sold_theoretical = 0")
    .get()?.cnt ?? 0;
  const belowStrike = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_strike < assignment_strike")
    .get()?.cnt ?? 0;
  return { total, backfilled, pending, stepsTotal, stepsSold, stepsWait, belowStrike };
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const marketService = createMarketService(new YahooMarketDataProvider());
const service = createTheoreticalCycleService({ validationStore, cycleStore, marketService });

await cycleStore.ensureInitialized();
const db = new DatabaseSync(SQLITE_PATH);

header("POP V2 Phase 2 — Backfill multi-CC après assignation CSP");
console.log(`  Mode        : ${dryRun ? "DRY-RUN (aucune écriture)" : "WRITE (local DB)"}`);
console.log(`  Force       : ${forceRefresh ? "oui" : "non"}`);
console.log(`  Limit       : ${limit ?? "aucune"}`);

const before = countMultiCc(db);
console.log(`\n  Avant backfill:`);
console.log(`    cycles total              : ${before.total}`);
console.log(`    multi_cc backfilled       : ${before.backfilled}`);
console.log(`    pending multi_cc          : ${before.pending}`);
console.log(`    cc steps total            : ${before.stepsTotal}`);
console.log(`    cc sold / wait            : ${before.stepsSold} / ${before.stepsWait}`);
console.log(`    cc below assignment_strike: ${before.belowStrike}`);

header(dryRun ? "DRY-RUN — simulation multi-CC" : "WRITE — simulation et persistance multi-CC");

const result = await service.refreshMultiCcStepsForCycles({
  dryRun,
  limit,
  forceRefresh,
  onlyMissing: !forceRefresh,
});

console.log(`  cycles_scanned                    : ${result.cycles_scanned}`);
console.log(`  cycles_eligible                   : ${result.cycles_eligible}`);
console.log(`  cycles_updated                    : ${result.cycles_updated}`);
console.log(`  cc_steps_created                  : ${result.cc_steps_created}`);
console.log(`  cc_sold                           : ${result.cc_sold}`);
console.log(`  cc_not_sold                       : ${result.cc_not_sold}`);
console.log(`  total_premium_simulated           : ${result.total_premium_simulated?.toFixed(4) ?? "0"}`);
console.log(`  weeks_without_cc (sum cycles)     : ${result.weeks_without_cc}`);
console.log(`  cc_premiums_before_recovery (sum)  : ${result.cc_premiums_before_recovery?.toFixed(4) ?? "0"}`);
console.log(`  cc_count_before_recovery (sum)    : ${result.cc_count_before_recovery}`);
console.log(`  weeks_without_cc_before_recovery  : ${result.weeks_without_cc_before_recovery}`);
console.log(`  endDateYmd                        : ${result.endDateYmd}`);
console.log(`  maxWeeks                          : ${result.maxWeeks}`);

if (result.errors?.length) {
  console.log(`\n  Erreurs (${result.errors.length}):`);
  for (const err of result.errors.slice(0, 10)) {
    console.log(`    - ${err.cycle_id}: ${err.error}`);
  }
}

if (result.sample_cycles?.length) {
  console.log("\n  Échantillon:");
  for (const s of result.sample_cycles) {
    console.log(
      `    ${String(s.ticker).padEnd(6)} assign=${s.assignment_date} strike=${s.assignment_strike} → steps=${s.cc_steps_count} sold=${s.cc_sold_count} wait=${s.weeks_without_cc} premium=${s.total_cc_premium_conservative?.toFixed(4) ?? "—"} beforeRec=${s.cc_premiums_before_recovery?.toFixed(4) ?? "—"} cost=${s.reduced_cost_basis_estimated?.toFixed(2) ?? "—"} lastTest=${s.latest_cc_test_date ?? "—"}`
    );
  }
}

const after = countMultiCc(db);
console.log(`\n  Après backfill${dryRun ? " (DB inchangée en dry-run)" : ""}:`);
console.log(`    cycles total              : ${after.total}`);
console.log(`    multi_cc backfilled       : ${after.backfilled}`);
console.log(`    pending multi_cc          : ${after.pending}`);
console.log(`    cc steps total            : ${after.stepsTotal}`);
console.log(`    cc sold / wait            : ${after.stepsSold} / ${after.stepsWait}`);
console.log(`    cc below assignment_strike: ${after.belowStrike}`);

if (dryRun) {
  console.log("\n  Pour écrire en local: node scripts/backfillWheelCcMultiSteps.mjs --write");
} else {
  console.log("\n  Backfill terminé.");
}
