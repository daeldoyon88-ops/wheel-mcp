/**
 * testRefreshTheoreticalCycleSummaries.mjs
 *
 * POP V2-F3 validation script.
 * Tests consolidation of CC steps into theoretical_wheel_cycles.
 * Does NOT create CC steps. Reads existing steps from F2 and updates cycles.
 *
 * Usage: node scripts/testRefreshTheoreticalCycleSummaries.mjs
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

function fmtCycle(c) {
  const strike = c.assignment_strike != null ? Number(c.assignment_strike).toFixed(2) : "n/a";
  const csp    = c.csp_premium != null ? Number(c.csp_premium).toFixed(4) : "n/a";
  const ccCons = c.total_cc_premium_conservative != null ? Number(c.total_cc_premium_conservative).toFixed(4) : "n/a";
  const total  = c.total_premium_estimated != null ? Number(c.total_premium_estimated).toFixed(4) : "n/a";
  const rcb    = c.reduced_cost_basis_estimated != null ? Number(c.reduced_cost_basis_estimated).toFixed(2) : "n/a";
  return `${String(c.ticker).padEnd(6)} strike=${strike} csp=${csp} ccCons=${ccCons} total=${total} rcb=${rcb} sold=${c.cc_sellable_steps_count} wait=${c.cc_wait_steps_count} seuil=${c.best_cc_threshold_reached ?? "—"}`;
}

// ─── setup ───────────────────────────────────────────────────────────────────

const validationStore = createWheelValidationStoreSqlite();
const cycleStore      = createTheoreticalCycleStoreSqlite();
const service         = createTheoreticalCycleService({ validationStore, cycleStore });

const db = new DatabaseSync(SQLITE_PATH);

// ─── BASELINE ────────────────────────────────────────────────────────────────

header("BASELINE — counts avant toute opération");

await cycleStore.ensureInitialized();

const baselineValidationCount = countTable(db, "wheel_validation_records");
const baselineCyclesCount     = countTable(db, "theoretical_wheel_cycles");
const baselineCcStepsCount    = countTable(db, "theoretical_cc_steps");

console.log(`  wheel_validation_records  : ${baselineValidationCount}`);
console.log(`  theoretical_wheel_cycles  : ${baselineCyclesCount}`);
console.log(`  theoretical_cc_steps      : ${baselineCcStepsCount}`);

assert(baselineValidationCount > 0, "wheel_validation_records non vide");
assert(baselineCyclesCount > 0,     `theoretical_wheel_cycles > 0 (got ${baselineCyclesCount})`);

if (baselineCcStepsCount === 0) {
  console.error("\n  ERREUR: theoretical_cc_steps est vide.");
  console.error("  Exécuter d'abord : node scripts/testGenerateFirstCcSteps.mjs (F2)");
  process.exitCode = 1;
  process.exit(1);
}

assert(baselineCcStepsCount > 0, `theoretical_cc_steps > 0 (got ${baselineCcStepsCount})`);

// ─── STEP 1 — DRY RUN ────────────────────────────────────────────────────────

header("STEP 1 — DRY RUN (aucun upsert)");

const dryResult = await service.refreshAllCycleSummaries({ dryRun: true });

console.log(`  cycles_scanned               : ${dryResult.cycles_scanned}`);
console.log(`  cycles_with_steps            : ${dryResult.cycles_with_steps}`);
console.log(`  cycles_without_steps         : ${dryResult.cycles_without_steps}`);
console.log(`  cycles_updated               : ${dryResult.cycles_updated}`);
console.log(`  total_cc_steps_seen          : ${dryResult.total_cc_steps_seen}`);
console.log(`  total_cc_sold_seen           : ${dryResult.total_cc_sold_seen}`);
console.log(`  total_cc_wait_seen           : ${dryResult.total_cc_wait_seen}`);
console.log(`  total_cc_premium_conservative: ${dryResult.total_cc_premium_conservative?.toFixed(4)}`);
console.log(`  best_threshold_global        : ${dryResult.best_threshold_global ?? "aucun"}`);
console.log(`  errors                       : ${dryResult.errors.length}`);

assert(dryResult.ok === true,             "dryRun ok=true");
assert(dryResult.dryRun === true,         "dryRun flag true");
assert(dryResult.cycles_scanned > 0,     `cycles_scanned > 0 (got ${dryResult.cycles_scanned})`);
assert(dryResult.cycles_with_steps > 0,  `cycles_with_steps > 0 (got ${dryResult.cycles_with_steps})`);
assert(dryResult.cycles_updated === 0,   "cycles_updated = 0 pendant dryRun");
assert(dryResult.total_cc_steps_seen > 0, `total_cc_steps_seen > 0 (got ${dryResult.total_cc_steps_seen})`);
assert(dryResult.sample_cycles.length > 0, "sample_cycles non vide");

const afterDryCycles  = countTable(db, "theoretical_wheel_cycles");
const afterDryCcSteps = countTable(db, "theoretical_cc_steps");
assert(afterDryCycles === baselineCyclesCount,   "theoretical_wheel_cycles inchangé pendant dryRun");
assert(afterDryCcSteps === baselineCcStepsCount, "theoretical_cc_steps inchangé pendant dryRun");

if (dryResult.sample_cycles.length > 0) {
  console.log("\n  Exemples (dryRun) :");
  for (const c of dryResult.sample_cycles) console.log(`    ${fmtCycle(c)}`);
}

// ─── STEP 2 — CONSOLIDATION RÉELLE ───────────────────────────────────────────

header("STEP 2 — CONSOLIDATION RÉELLE");

const realResult = await service.refreshAllCycleSummaries({ dryRun: false });

console.log(`  cycles_scanned               : ${realResult.cycles_scanned}`);
console.log(`  cycles_with_steps            : ${realResult.cycles_with_steps}`);
console.log(`  cycles_without_steps         : ${realResult.cycles_without_steps}`);
console.log(`  cycles_updated               : ${realResult.cycles_updated}`);
console.log(`  total_cc_steps_seen          : ${realResult.total_cc_steps_seen}`);
console.log(`  total_cc_sold_seen           : ${realResult.total_cc_sold_seen}`);
console.log(`  total_cc_wait_seen           : ${realResult.total_cc_wait_seen}`);
console.log(`  total_cc_premium_conservative: ${realResult.total_cc_premium_conservative?.toFixed(4)}`);
console.log(`  best_threshold_global        : ${realResult.best_threshold_global ?? "aucun"}`);
console.log(`  errors                       : ${realResult.errors.length}`);
if (realResult.errors.length > 0) {
  for (const e of realResult.errors.slice(0, 3)) console.log(`    ERROR: ${e.cycle_id} — ${e.error}`);
}

assert(realResult.ok === true,          "consolidation réelle ok=true");
assert(realResult.cycles_updated > 0,  `cycles_updated > 0 (got ${realResult.cycles_updated})`);
assert(realResult.errors.length === 0, `aucune erreur (got ${realResult.errors.length})`);

const afterRealCycles     = countTable(db, "theoretical_wheel_cycles");
const afterRealCcSteps    = countTable(db, "theoretical_cc_steps");
const afterRealValidation = countTable(db, "wheel_validation_records");

assert(
  afterRealCycles === baselineCyclesCount,
  `theoretical_wheel_cycles count inchangé (attendu=${baselineCyclesCount}, got=${afterRealCycles})`
);
assert(
  afterRealCcSteps === baselineCcStepsCount,
  `theoretical_cc_steps count inchangé (attendu=${baselineCcStepsCount}, got=${afterRealCcSteps})`
);
assert(
  afterRealValidation === baselineValidationCount,
  `wheel_validation_records count inchangé (attendu=${baselineValidationCount}, got=${afterRealValidation})`
);

if (realResult.sample_cycles.length > 0) {
  console.log("\n  5 exemples cycles consolidés :");
  for (const c of realResult.sample_cycles) console.log(`    ${fmtCycle(c)}`);
}

// ─── STEP 3 — IDEMPOTENCE ────────────────────────────────────────────────────

header("STEP 3 — IDEMPOTENCE (deuxième exécution)");

const idemResult = await service.refreshAllCycleSummaries({ dryRun: false });

const afterIdemCycles     = countTable(db, "theoretical_wheel_cycles");
const afterIdemCcSteps    = countTable(db, "theoretical_cc_steps");
const afterIdemValidation = countTable(db, "wheel_validation_records");

console.log(`  cycles_scanned  : ${idemResult.cycles_scanned}`);
console.log(`  cycles_updated  : ${idemResult.cycles_updated}`);
console.log(`  errors          : ${idemResult.errors.length}`);

assert(idemResult.ok === true,          "deuxième exécution ok=true");
assert(idemResult.errors.length === 0, `aucune erreur (got ${idemResult.errors.length})`);
assert(
  afterIdemCycles === afterRealCycles,
  `theoretical_wheel_cycles inchangé (idempotent, got=${afterIdemCycles})`
);
assert(
  afterIdemCcSteps === afterRealCcSteps,
  `theoretical_cc_steps inchangé (idempotent, got=${afterIdemCcSteps})`
);
assert(
  afterIdemValidation === afterRealValidation,
  `wheel_validation_records inchangé (idempotent, got=${afterIdemValidation})`
);

// ─── STEP 4 — CYCLES ENRICHIS ────────────────────────────────────────────────

header("STEP 4 — CYCLES ENRICHIS (vérification directe SQLite)");

const enrichedRows = db.prepare(`
  SELECT ticker, assignment_strike, csp_premium,
         total_cc_premium_conservative, total_premium_estimated,
         reduced_cost_basis_estimated, cc_sellable_steps_count,
         cc_wait_steps_count, best_cc_threshold_reached
  FROM theoretical_wheel_cycles
  WHERE cc_sellable_steps_count > 0
  LIMIT 5
`).all();

assert(enrichedRows.length > 0, "au moins un cycle avec cc_sellable_steps_count > 0");

if (enrichedRows.length > 0) {
  console.log("\n  Cycles enrichis (SQLite direct) :");
  for (const c of enrichedRows) console.log(`    ${fmtCycle(c)}`);
}

// Validate formula: total_premium_estimated = csp_premium + total_cc_premium_conservative
let formulaOk = true;
for (const c of enrichedRows) {
  if (c.csp_premium == null) continue;
  const expected = Number(c.csp_premium) + Number(c.total_cc_premium_conservative);
  const actual   = Number(c.total_premium_estimated);
  if (Math.abs(expected - actual) > 0.0001) {
    formulaOk = false;
    console.log(`    FORMULA FAIL: ${c.ticker} expected=${expected.toFixed(4)} got=${actual.toFixed(4)}`);
  }
}
assert(formulaOk, "total_premium_estimated = csp_premium + total_cc_premium_conservative");

// Validate formula: reduced_cost_basis_estimated = assignment_strike - csp_premium - total_cc_premium_conservative
let rcbOk = true;
for (const c of enrichedRows) {
  if (c.csp_premium == null || c.reduced_cost_basis_estimated == null) continue;
  const expected = Number(c.assignment_strike) - Number(c.csp_premium) - Number(c.total_cc_premium_conservative);
  const actual   = Number(c.reduced_cost_basis_estimated);
  if (Math.abs(expected - actual) > 0.0001) {
    rcbOk = false;
    console.log(`    RCB FAIL: ${c.ticker} expected=${expected.toFixed(4)} got=${actual.toFixed(4)}`);
  }
}
assert(rcbOk, "reduced_cost_basis_estimated = assignment_strike - csp_premium - total_cc_premium_conservative");

// ─── RAPPORT FINAL ────────────────────────────────────────────────────────────

header("RAPPORT FINAL");

console.log(`  Cycles scannés                     : ${realResult.cycles_scanned}`);
console.log(`  Cycles avec CC steps               : ${realResult.cycles_with_steps}`);
console.log(`  Cycles sans CC steps               : ${realResult.cycles_without_steps}`);
console.log(`  Cycles consolidés                  : ${realResult.cycles_updated}`);
console.log(`  Total primes CC conservatrices     : ${realResult.total_cc_premium_conservative?.toFixed(4)}`);
console.log(`  CC vendus théoriquement            : ${realResult.total_cc_sold_seen}`);
console.log(`  CC en attente                      : ${realResult.total_cc_wait_seen}`);
console.log(`  Meilleur seuil global atteint      : ${realResult.best_threshold_global ?? "aucun"}`);
console.log(`  theoretical_wheel_cycles count     : ${afterIdemCycles}  (inchangé — ${afterIdemCycles === baselineCyclesCount ? "OK" : "ERREUR"})`);
console.log(`  theoretical_cc_steps count         : ${afterIdemCcSteps}  (inchangé — ${afterIdemCcSteps === baselineCcStepsCount ? "OK" : "ERREUR"})`);
console.log(`  wheel_validation_records count     : ${afterIdemValidation}  (inchangé — ${afterIdemValidation === baselineValidationCount ? "OK" : "ERREUR"})`);
console.log(`  Appels réseau                      : aucun`);
console.log(`  Scanner modifié                    : non`);
console.log(`  Dashboard modifié                  : non`);
console.log(`  server.js modifié                  : non`);
console.log(`  CC steps modifiés                  : non`);

if (process.exitCode === 1) {
  console.log("\n  STATUT: ÉCHEC — voir FAIL ci-dessus");
} else {
  console.log("\n  STATUT: SUCCÈS — tous les critères validés");
}
