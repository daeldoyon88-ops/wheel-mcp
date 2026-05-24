/**
 * backfillWheelCcFinalExit.mjs
 *
 * POP V2 Phase 3 — backfill final exit / called away for theoretical wheel cycles.
 *
 * Usage:
 *   node scripts/backfillWheelCcFinalExit.mjs              # dry-run (default)
 *   node scripts/backfillWheelCcFinalExit.mjs --write        # persist to local DB
 *   node scripts/backfillWheelCcFinalExit.mjs --write --force
 *   node scripts/backfillWheelCcFinalExit.mjs --limit=10
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

function countFinalExit(db) {
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles").get()?.cnt ?? 0;
  const closed = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE cycle_status = 'closed'")
    .get()?.cnt ?? 0;
  const open = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE cycle_status = 'open' OR cycle_status IS NULL")
    .get()?.cnt ?? 0;
  const calledAway = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE close_reason = 'cc_called_away'")
    .get()?.cnt ?? 0;
  const belowStrike = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_price IS NOT NULL AND final_exit_price < assignment_strike"
    )
    .get()?.cnt ?? 0;
  const backfilled = db
    .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_backfilled_at IS NOT NULL")
    .get()?.cnt ?? 0;
  return { total, closed, open, calledAway, belowStrike, backfilled };
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const marketService = createMarketService(new YahooMarketDataProvider());
const service = createTheoreticalCycleService({ validationStore, cycleStore, marketService });

await cycleStore.ensureInitialized();
const db = new DatabaseSync(SQLITE_PATH);

header("POP V2 Phase 3 — Backfill sortie finale / called away");
console.log(`  Mode        : ${dryRun ? "DRY-RUN (aucune écriture)" : "WRITE (local DB)"}`);
console.log(`  Force       : ${forceRefresh ? "oui" : "non"}`);
console.log(`  Limit       : ${limit ?? "aucune"}`);

const before = countFinalExit(db);
console.log(`\n  Avant backfill:`);
console.log(`    cycles total              : ${before.total}`);
console.log(`    cycle_status closed       : ${before.closed}`);
console.log(`    cycle_status open/null    : ${before.open}`);
console.log(`    close_reason called away  : ${before.calledAway}`);
console.log(`    final_exit_backfilled     : ${before.backfilled}`);
console.log(`    final_exit < assign strike: ${before.belowStrike}`);

header(dryRun ? "DRY-RUN — évaluation sortie finale" : "WRITE — évaluation et persistance sortie finale");

const result = await service.refreshFinalExitForWheelCycles({
  dryRun,
  limit,
  forceRefresh,
  onlyMissing: !forceRefresh,
});

console.log(`  cycles_total              : ${result.cycles_total}`);
console.log(`  cycles_scanned            : ${result.cycles_scanned}`);
console.log(`  cycles_eligible           : ${result.cycles_eligible}`);
console.log(`  cycles_updated            : ${result.cycles_updated}`);
console.log(`  cycles_closed             : ${result.cycles_closed}`);
console.log(`  cycles_still_open         : ${result.cycles_still_open}`);
console.log(`  cc_steps_evaluated        : ${result.cc_steps_evaluated}`);
console.log(`  called_away_count         : ${result.called_away_count}`);
console.log(`  expired_otm_count         : ${result.expired_otm_count}`);
console.log(`  pending_expirations       : ${result.pending_expirations}`);
console.log(`  missing_expiration_price  : ${result.missing_expiration_price}`);
console.log(`  total_pnl_contract_sum    : ${result.total_pnl_contract_sum?.toFixed(2) ?? "—"}`);
console.log(
  `  avg return_on_assignment    : ${result.average_return_on_assignment_pct != null ? result.average_return_on_assignment_pct.toFixed(2) + " %" : "—"}`
);
console.log(
  `  avg days after assignment   : ${result.average_days_after_assignment_to_exit != null ? result.average_days_after_assignment_to_exit.toFixed(1) : "—"}`
);
console.log(`  final_exit < assign strike: ${result.final_exit_below_assignment_strike}`);

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
      `    ${String(s.ticker).padEnd(6)} status=${s.cycle_status} exit=${s.final_exit_date ?? "—"} @ ${s.final_exit_price ?? "—"} seq=${s.final_exit_sequence_number ?? "—"} P/L=${s.total_pnl_contract?.toFixed(2) ?? "—"} ret=${s.return_on_assignment_pct?.toFixed(2) ?? "—"}% [${s.close_reason ?? "—"}]`
    );
  }
}

const after = countFinalExit(db);
console.log(`\n  Après backfill${dryRun ? " (DB inchangée en dry-run)" : ""}:`);
console.log(`    cycles total              : ${after.total}`);
console.log(`    cycle_status closed       : ${after.closed}`);
console.log(`    cycle_status open/null    : ${after.open}`);
console.log(`    close_reason called away  : ${after.calledAway}`);
console.log(`    final_exit_backfilled     : ${after.backfilled}`);
console.log(`    final_exit < assign strike: ${after.belowStrike}`);

if (dryRun) {
  console.log("\n  Pour écrire en local: node scripts/backfillWheelCcFinalExit.mjs --write");
} else {
  console.log("\n  Backfill terminé.");
}
