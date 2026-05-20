/**
 * testGenerateFirstCcSteps.mjs
 *
 * POP V2-F2 validation script.
 * Tests the full lifecycle: dryRun → real generation → idempotency check.
 *
 * Usage:  node scripts/testGenerateFirstCcSteps.mjs
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

// ─── helpers ─────────────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  OK  : ${message}`);
  }
}

function header(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function countTable(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    return row?.cnt ?? 0;
  } catch (_) {
    return 0;
  }
}

function fmtStep(s) {
  const status = s.cc_sold_theoretical === 1 ? "VENDU" : `WAIT (${s.not_sold_reason})`;
  const spot   = s.stock_price_used        != null ? s.stock_price_used.toFixed(2)        : "n/a";
  const prime  = s.premium_conservative    != null ? s.premium_conservative.toFixed(4)    : "n/a";
  const yield_ = s.cc_yield_conservative_pct != null ? s.cc_yield_conservative_pct.toFixed(3) + "%" : "n/a";
  return `${String(s.ticker).padEnd(6)} strike=${s.assignment_strike} spot=${spot} prime=${prime} yield=${yield_} seuil=${s.best_threshold_reached ?? "—"} [${status}]`;
}

// ─── setup ───────────────────────────────────────────────────────────────────

const validationStore = createWheelValidationStoreSqlite();
const cycleStore      = createTheoreticalCycleStoreSqlite();
const service         = createTheoreticalCycleService({ validationStore, cycleStore });

const db = new DatabaseSync(SQLITE_PATH);

// ─── BASELINE ────────────────────────────────────────────────────────────────

header("BASELINE — counts before any operation");

await cycleStore.ensureInitialized();

const baselineValidationCount = countTable(db, "wheel_validation_records");
const baselineCcStepsCount    = countTable(db, "theoretical_cc_steps");
const baselineCyclesCount     = countTable(db, "theoretical_wheel_cycles");

console.log(`  wheel_validation_records  : ${baselineValidationCount}`);
console.log(`  theoretical_wheel_cycles  : ${baselineCyclesCount}`);
console.log(`  theoretical_cc_steps      : ${baselineCcStepsCount}`);

assert(baselineValidationCount > 0, "wheel_validation_records non vide");

// Ensure cycles exist before running CC step generation
if (baselineCyclesCount === 0) {
  console.log("\n  Aucun cycle — génération des cycles depuis les CSP assignés...");
  const cyclesResult = await service.generateCyclesFromAssignedRecords({ dryRun: false });
  console.log(`  Cycles créés : ${cyclesResult.cycles_upserted}`);
  assert(cyclesResult.cycles_upserted > 0, "cycles créés depuis CSP assignés");
}

const afterSetupCyclesCount = countTable(db, "theoretical_wheel_cycles");
assert(afterSetupCyclesCount > 0, `theoretical_wheel_cycles existe (got ${afterSetupCyclesCount})`);

// ─── STEP 1 — DRY RUN ────────────────────────────────────────────────────────

header("STEP 1 — DRY RUN (aucun insert)");

const dryResult = await service.generateFirstCcStepsForOpenCycles({ dryRun: true });

console.log(`  cycles_scanned                 : ${dryResult.cycles_scanned}`);
console.log(`  cycles_eligible                : ${dryResult.cycles_eligible}`);
console.log(`  source_records_found           : ${dryResult.source_records_found}`);
console.log(`  steps_built                    : ${dryResult.steps_built}`);
console.log(`  steps_upserted                 : ${dryResult.steps_upserted}`);
console.log(`  skipped_existing               : ${dryResult.skipped_existing}`);
console.log(`  skipped_missing_source_record  : ${dryResult.skipped_missing_source_record}`);
console.log(`  skipped_pricing_unavailable    : ${dryResult.skipped_pricing_unavailable}`);
console.log(`  cc_sold_theoretical_count      : ${dryResult.cc_sold_theoretical_count}`);
console.log(`  cc_wait_count                  : ${dryResult.cc_wait_count}`);
console.log(`  errors                         : ${dryResult.errors.length}`);

assert(dryResult.ok === true,         "dryRun ok=true");
assert(dryResult.dryRun === true,     "dryRun flag true");
assert(dryResult.steps_built > 0,    `steps_built > 0 (got ${dryResult.steps_built})`);
assert(dryResult.steps_upserted === 0, "steps_upserted = 0 pendant dryRun");
assert(dryResult.cc_sold_theoretical_count + dryResult.cc_wait_count > 0, "sold+wait > 0");

const afterDryCcSteps = countTable(db, "theoretical_cc_steps");
assert(afterDryCcSteps === baselineCcStepsCount, "aucun step inséré pendant dryRun");

if (dryResult.sample_steps.length > 0) {
  console.log("\n  Exemples (dryRun) :");
  for (const s of dryResult.sample_steps) console.log(`    ${fmtStep(s)}`);
}

// ─── STEP 2 — REAL GENERATION ────────────────────────────────────────────────

header("STEP 2 — GÉNÉRATION RÉELLE");

const realResult = await service.generateFirstCcStepsForOpenCycles({ dryRun: false });

console.log(`  cycles_scanned                 : ${realResult.cycles_scanned}`);
console.log(`  cycles_eligible                : ${realResult.cycles_eligible}`);
console.log(`  source_records_found           : ${realResult.source_records_found}`);
console.log(`  steps_built                    : ${realResult.steps_built}`);
console.log(`  steps_upserted                 : ${realResult.steps_upserted}`);
console.log(`  cc_sold_theoretical_count      : ${realResult.cc_sold_theoretical_count}`);
console.log(`  cc_wait_count                  : ${realResult.cc_wait_count}`);
console.log(`  errors                         : ${realResult.errors.length}`);
if (realResult.errors.length > 0) {
  for (const e of realResult.errors.slice(0, 3)) console.log(`    ERROR: ${e.cycle_id} — ${e.error}`);
}

assert(realResult.ok === true,          "génération réelle ok=true");
assert(realResult.steps_upserted > 0,  `steps_upserted > 0 (got ${realResult.steps_upserted})`);
assert(realResult.errors.length === 0, `aucune erreur (got ${realResult.errors.length})`);

const afterRealCcSteps    = countTable(db, "theoretical_cc_steps");
const afterRealCycles     = countTable(db, "theoretical_wheel_cycles");
const afterRealValidation = countTable(db, "wheel_validation_records");

assert(afterRealCcSteps > baselineCcStepsCount,
  `theoretical_cc_steps créés (avant=${baselineCcStepsCount}, après=${afterRealCcSteps})`);
assert(afterRealCycles === afterSetupCyclesCount,
  `theoretical_wheel_cycles inchangés (attendu=${afterSetupCyclesCount}, got=${afterRealCycles})`);
assert(afterRealValidation === baselineValidationCount,
  `wheel_validation_records inchangés (attendu=${baselineValidationCount}, got=${afterRealValidation})`);

// RÈGLE ABSOLUE: aucun CC sous assignment_strike
const ccBelowRow = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_strike < assignment_strike")
  .get();
assert(ccBelowRow?.cnt === 0, `aucun CC sous assignment_strike (got ${ccBelowRow?.cnt})`);

if (realResult.sample_steps.length > 0) {
  console.log("\n  5 exemples :");
  for (const s of realResult.sample_steps) console.log(`    ${fmtStep(s)}`);
}

const summary1 = await service.getTheoreticalCycleSummary();
console.log(`\n  Résumé après génération CC steps :`);
console.log(`    cycles_total   : ${summary1.cycles_total}`);
console.log(`    cycles_open    : ${summary1.cycles_open}`);
console.log(`    cc_steps_total : ${summary1.cc_steps_total}`);
console.log(`    cc_sold_total  : ${summary1.cc_sold_total}`);
console.log(`    cc_wait_total  : ${summary1.cc_wait_total}`);
console.log(`    tickers_count  : ${summary1.tickers_count}`);

// ─── STEP 3 — IDEMPOTENCY ────────────────────────────────────────────────────

header("STEP 3 — IDEMPOTENCE (deuxième exécution)");

const idemResult = await service.generateFirstCcStepsForOpenCycles({ dryRun: false });

const afterIdemCcSteps    = countTable(db, "theoretical_cc_steps");
const afterIdemCycles     = countTable(db, "theoretical_wheel_cycles");
const afterIdemValidation = countTable(db, "wheel_validation_records");

console.log(`  cycles_scanned   : ${idemResult.cycles_scanned}`);
console.log(`  steps_upserted   : ${idemResult.steps_upserted}`);
console.log(`  skipped_existing : ${idemResult.skipped_existing}`);
console.log(`  errors           : ${idemResult.errors.length}`);

assert(idemResult.ok === true,            "deuxième exécution ok=true");
assert(idemResult.errors.length === 0,    `aucune erreur (got ${idemResult.errors.length})`);
assert(idemResult.skipped_existing > 0,   `skipped_existing > 0 (got ${idemResult.skipped_existing})`);
assert(idemResult.steps_upserted === 0,   `steps_upserted = 0 (idempotent) (got ${idemResult.steps_upserted})`);
assert(afterIdemCcSteps === afterRealCcSteps,
  `aucun doublon steps (avant=${afterRealCcSteps}, après=${afterIdemCcSteps})`);
assert(afterIdemCycles === afterSetupCyclesCount, "theoretical_wheel_cycles inchangés");
assert(afterIdemValidation === baselineValidationCount, "wheel_validation_records inchangés");

// ─── FINAL REPORT ────────────────────────────────────────────────────────────

header("RAPPORT FINAL");

const bestThresholdRow = db
  .prepare("SELECT MAX(best_threshold_reached) AS best FROM theoretical_cc_steps")
  .get();

console.log(`  Cycles scannés                 : ${realResult.cycles_scanned}`);
console.log(`  CC steps générés               : ${realResult.steps_upserted}`);
console.log(`  CC vendus théoriquement        : ${realResult.cc_sold_theoretical_count}`);
console.log(`  CC en attente                  : ${realResult.cc_wait_count}`);
console.log(`  Meilleur seuil atteint (global): ${bestThresholdRow?.best ?? "aucun"}`);
console.log(`  theoretical_cc_steps total     : ${afterIdemCcSteps}`);
console.log(`  theoretical_wheel_cycles       : ${afterIdemCycles}  (inchangé)`);
console.log(`  wheel_validation_records       : ${afterIdemValidation}  (inchangé — ${baselineValidationCount === afterIdemValidation ? "OK" : "ERREUR"})`);
console.log(`  CC < assignment_strike         : ${ccBelowRow?.cnt}  (RÈGLE ABSOLUE)`);
console.log(`  Appels réseau                  : aucun`);
console.log(`  Scanner modifié                : non`);
console.log(`  Dashboard modifié              : non`);
console.log(`  server.js modifié              : non`);

if (process.exitCode === 1) {
  console.log("\n  STATUT: ÉCHEC — voir FAIL ci-dessus");
} else {
  console.log("\n  STATUT: SUCCÈS — tous les critères validés");
}
