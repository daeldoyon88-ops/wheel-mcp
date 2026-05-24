/**
 * backfillWheelCcRecovery.mjs
 *
 * POP V2 Phase 1 — backfill CSP assignment recovery metrics
 * for theoretical_wheel_cycles (post-assignment close >= assignment_strike).
 *
 * Usage:
 *   node scripts/backfillWheelCcRecovery.mjs              # dry-run (default)
 *   node scripts/backfillWheelCcRecovery.mjs --write      # persist to local DB
 *   node scripts/backfillWheelCcRecovery.mjs --write --force  # recompute all cycles
 *   node scripts/backfillWheelCcRecovery.mjs --write --limit 20
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

function countRecovery(db) {
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles").get()?.cnt ?? 0;
  const recovered = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE assignment_recovered = 1")
    .get()?.cnt ?? 0;
  const notRecovered = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE assignment_recovered = 0")
    .get()?.cnt ?? 0;
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE assignment_recovered IS NULL AND days_to_strike_close_above IS NULL"
    )
    .get()?.cnt ?? 0;
  return { total, recovered, notRecovered, pending };
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const marketService = createMarketService(new YahooMarketDataProvider());
const service = createTheoreticalCycleService({ validationStore, cycleStore, marketService });

await cycleStore.ensureInitialized();
const db = new DatabaseSync(SQLITE_PATH);

header("POP V2 Phase 1 — Backfill recovery CSP assignation");
console.log(`  Mode        : ${dryRun ? "DRY-RUN (aucune écriture)" : "WRITE (local DB)"}`);
console.log(`  Force       : ${forceRefresh ? "oui" : "non"}`);
console.log(`  Limit       : ${limit ?? "aucune"}`);

const before = countRecovery(db);
console.log(`\n  Avant backfill:`);
console.log(`    cycles total          : ${before.total}`);
console.log(`    recovered (=1)        : ${before.recovered}`);
console.log(`    not recovered (=0)    : ${before.notRecovered}`);
console.log(`    pending (null)        : ${before.pending}`);

header(dryRun ? "DRY-RUN — calcul recovery" : "WRITE — calcul et persistance recovery");

const result = await service.refreshAssignmentRecoveryForCycles({
  dryRun,
  limit,
  forceRefresh,
  onlyMissing: !forceRefresh,
});

console.log(`  cycles_scanned          : ${result.cycles_scanned}`);
console.log(`  cycles_eligible         : ${result.cycles_eligible}`);
console.log(`  cycles_updated          : ${result.cycles_updated}`);
console.log(`  cycles_recovered (run)  : ${result.cycles_recovered}`);
console.log(`  cycles_not_recovered    : ${result.cycles_not_recovered}`);
console.log(`  cycles_no_ohlc          : ${result.cycles_no_ohlc}`);
console.log(`  endDateYmd              : ${result.endDateYmd}`);

if (result.errors?.length) {
  console.log(`\n  Erreurs (${result.errors.length}):`);
  for (const err of result.errors.slice(0, 10)) {
    console.log(`    - ${err.cycle_id}: ${err.error}`);
  }
}

if (result.sample_cycles?.length) {
  console.log("\n  Échantillon:");
  for (const s of result.sample_cycles) {
    const status = s.assignment_recovered === 1 ? "RECOVERED" : "NOT YET";
    console.log(
      `    ${String(s.ticker).padEnd(6)} assign=${s.assignment_date} strike=${s.assignment_strike} → recovery=${s.assignment_recovery_date ?? "—"} days=${s.days_to_strike_close_above ?? "—"} below=${s.days_below_assignment_strike ?? "—"} [${status}] candles=${s.candle_count}`
    );
  }
}

const after = countRecovery(db);
console.log(`\n  Après backfill${dryRun ? " (DB inchangée en dry-run)" : ""}:`);
console.log(`    cycles total          : ${after.total}`);
console.log(`    recovered (=1)        : ${after.recovered}`);
console.log(`    not recovered (=0)    : ${after.notRecovered}`);
console.log(`    pending (null)        : ${after.pending}`);

if (dryRun) {
  console.log("\n  Pour écrire en local: node scripts/backfillWheelCcRecovery.mjs --write");
} else {
  console.log("\n  Backfill terminé.");
}
