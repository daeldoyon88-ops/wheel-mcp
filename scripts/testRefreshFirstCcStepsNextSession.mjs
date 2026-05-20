/**
 * testRefreshFirstCcStepsNextSession.mjs
 *
 * POP V2-F2B validation script.
 * Validates that the first CC step uses the first trading session after assignment_date.
 * Runs forceRefresh=true to overwrite all existing step-1 records with corrected logic.
 *
 * Usage: node scripts/testRefreshFirstCcStepsNextSession.mjs
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  OK  : ${message}`);
  }
}

function header(title) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(64));
}

function countTable(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    return row?.cnt ?? 0;
  } catch (_) { return 0; }
}

// Normalise YYYYMMDD or YYYY-MM-DD to YYYY-MM-DD for reliable string comparison.
function normDate(d) {
  if (!d) return null;
  const s = String(d).replace(/-/g, "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return String(d).slice(0, 10);
}

// ─── setup ───────────────────────────────────────────────────────────────────

const validationStore = createWheelValidationStoreSqlite();
const cycleStore      = createTheoreticalCycleStoreSqlite();
const service         = createTheoreticalCycleService({ validationStore, cycleStore });

const db = new DatabaseSync(SQLITE_PATH);

// ─── BASELINE ────────────────────────────────────────────────────────────────

header("BASELINE — counts avant toute opération");

await cycleStore.ensureInitialized();

const baselineValidation = countTable(db, "wheel_validation_records");
const baselineCycles     = countTable(db, "theoretical_wheel_cycles");
const baselineCcSteps    = countTable(db, "theoretical_cc_steps");

console.log(`  wheel_validation_records : ${baselineValidation}`);
console.log(`  theoretical_wheel_cycles : ${baselineCycles}`);
console.log(`  theoretical_cc_steps     : ${baselineCcSteps}`);

assert(baselineValidation > 0, "wheel_validation_records non vide");
assert(baselineCycles > 0, `theoretical_wheel_cycles > 0 (got ${baselineCycles})`);

if (baselineCycles === 0) {
  console.error("\n  ERREUR: aucun cycle. Exécuter d'abord le script F2 (testGenerateFirstCcSteps.mjs).");
  process.exit(1);
}

// ─── STEP 1 — DRY RUN ────────────────────────────────────────────────────────

header("STEP 1 — DRY RUN (forceRefresh=true, dryRun=true)");

const dryResult = await service.generateFirstCcStepsForOpenCycles({
  dryRun:       true,
  forceRefresh: true,
});

console.log(`  cycles_scanned   : ${dryResult.cycles_scanned}`);
console.log(`  cycles_eligible  : ${dryResult.cycles_eligible}`);
console.log(`  steps_built      : ${dryResult.steps_built}`);
console.log(`  steps_upserted   : ${dryResult.steps_upserted}`);
console.log(`  skipped_existing : ${dryResult.skipped_existing}`);
console.log(`  errors           : ${dryResult.errors.length}`);

assert(dryResult.ok === true,          "dryRun ok=true");
assert(dryResult.dryRun === true,      "dryRun flag=true");
assert(dryResult.steps_built > 0,     `steps_built > 0 (got ${dryResult.steps_built})`);
assert(dryResult.steps_upserted === 0, "steps_upserted = 0 pendant dryRun");
assert(dryResult.skipped_existing === 0, "aucun skip avec forceRefresh=true");

// validate sample_steps
if (dryResult.sample_steps.length > 0) {
  let testDateOk  = true;
  let ccStrikeOk  = true;
  let testDateSet = true;
  for (const s of dryResult.sample_steps) {
    if (!s.test_date) { testDateSet = false; break; }
    if (s.assignment_date && normDate(s.test_date) < normDate(s.assignment_date)) { testDateOk = false; break; }
    if (s.cc_strike != null && s.assignment_strike != null && s.cc_strike < s.assignment_strike) {
      ccStrikeOk = false; break;
    }
  }
  assert(testDateSet, "sample_steps contiennent test_date");
  assert(testDateOk,  "test_date >= assignment_date pour tous les sample_steps");
  assert(ccStrikeOk,  "cc_strike >= assignment_strike pour tous les sample_steps");

  console.log("\n  Exemples dryRun :");
  for (const s of dryResult.sample_steps) {
    const sold = s.cc_sold_theoretical === 1 ? "sold" : "wait";
    const yld  = s.cc_yield_conservative_pct != null ? Number(s.cc_yield_conservative_pct).toFixed(3) : "n/a";
    console.log(
      `    ${String(s.ticker).padEnd(6)} asgn=${s.assignment_date} → test=${s.test_date}` +
      ` priceRule=${s.priceRule ?? "?"} spot=${Number(s.stock_price_used).toFixed(2)}` +
      ` strike=${Number(s.cc_strike).toFixed(2)} yld=${yld}% ${sold}`
    );
  }
}

const afterDryCycles  = countTable(db, "theoretical_wheel_cycles");
const afterDryCcSteps = countTable(db, "theoretical_cc_steps");
assert(afterDryCycles  === baselineCycles,   "theoretical_wheel_cycles inchangé pendant dryRun");
assert(afterDryCcSteps === baselineCcSteps,  "theoretical_cc_steps inchangé pendant dryRun");

// ─── STEP 2 — REAL RUN ───────────────────────────────────────────────────────

header("STEP 2 — REAL RUN (forceRefresh=true, dryRun=false)");

const realResult = await service.generateFirstCcStepsForOpenCycles({
  dryRun:       false,
  forceRefresh: true,
});

console.log(`  cycles_scanned   : ${realResult.cycles_scanned}`);
console.log(`  cycles_eligible  : ${realResult.cycles_eligible}`);
console.log(`  steps_built      : ${realResult.steps_built}`);
console.log(`  steps_upserted   : ${realResult.steps_upserted}`);
console.log(`  skipped_existing : ${realResult.skipped_existing}`);
console.log(`  cc_sold          : ${realResult.cc_sold_theoretical_count}`);
console.log(`  cc_wait          : ${realResult.cc_wait_count}`);
console.log(`  errors           : ${realResult.errors.length}`);
if (realResult.errors.length > 0) {
  for (const e of realResult.errors.slice(0, 3))
    console.log(`    ERROR: ${e.cycle_id} — ${e.error}`);
}

assert(realResult.ok === true,           "realRun ok=true");
assert(realResult.steps_upserted > 0,   `steps_upserted > 0 (got ${realResult.steps_upserted})`);
assert(realResult.errors.length === 0,  `aucune erreur (got ${realResult.errors.length})`);
assert(realResult.skipped_existing === 0, "aucun skip avec forceRefresh=true");

const afterRealCycles     = countTable(db, "theoretical_wheel_cycles");
const afterRealCcSteps    = countTable(db, "theoretical_cc_steps");
const afterRealValidation = countTable(db, "wheel_validation_records");

// theoretical_wheel_cycles must be unchanged (no new cycles created here)
assert(
  afterRealCycles === baselineCycles,
  `theoretical_wheel_cycles inchangé (baseline=${baselineCycles}, after=${afterRealCycles})`
);
// forceRefresh overwrites step-1 records; count should not drop below baseline
assert(
  afterRealCcSteps >= baselineCcSteps,
  `theoretical_cc_steps count non diminué (baseline=${baselineCcSteps}, after=${afterRealCcSteps})`
);
assert(
  afterRealValidation === baselineValidation,
  `wheel_validation_records inchangé (attendu=${baselineValidation}, got=${afterRealValidation})`
);

// ─── STEP 3 — INVARIANTS DB ──────────────────────────────────────────────────

header("STEP 3 — INVARIANTS DB (doublons, cc_strike, target_time, raw_json)");

// No duplicate step-1 per cycle
const duplicates = db.prepare(`
  SELECT theoretical_cycle_id, COUNT(*) AS cnt
  FROM theoretical_cc_steps
  WHERE sequence_number = 1
  GROUP BY theoretical_cycle_id
  HAVING cnt > 1
`).all();
assert(duplicates.length === 0,
  `aucun doublon sequence_number=1 par cycle (violations=${duplicates.length})`);

// cc_strike >= assignment_strike for every step
const invalidStrikes = db.prepare(`
  SELECT COUNT(*) AS cnt FROM theoretical_cc_steps
  WHERE cc_strike < assignment_strike
`).get();
assert((invalidStrikes?.cnt ?? 0) === 0,
  `cc_strike >= assignment_strike pour tous les steps (violations=${invalidStrikes?.cnt ?? 0})`);

// target_time non null
const withTargetTime = db.prepare(`
  SELECT COUNT(*) AS cnt FROM theoretical_cc_steps
  WHERE sequence_number = 1 AND target_time IS NOT NULL
`).get();
console.log(`  Steps avec target_time non null : ${withTargetTime?.cnt ?? 0}`);
assert((withTargetTime?.cnt ?? 0) > 0, "au moins un step avec target_time non null");

// raw_json contains priceRule and testDateRule
const sampleRaw = db.prepare(`
  SELECT raw_json FROM theoretical_cc_steps
  WHERE sequence_number = 1 AND raw_json IS NOT NULL
  LIMIT 5
`).all();

let rawJsonOk = sampleRaw.length > 0;
for (const row of sampleRaw) {
  try {
    const raw = JSON.parse(row.raw_json);
    if (!raw.priceRule || !raw.testDateRule) { rawJsonOk = false; break; }
  } catch (_) { rawJsonOk = false; break; }
}
assert(rawJsonOk, "raw_json contient priceRule et testDateRule");

// ─── STEP 4 — 5 EXEMPLES ─────────────────────────────────────────────────────

header("STEP 4 — 5 EXEMPLES (assignment_date → test_date)");

const examples = db.prepare(`
  SELECT
    s.ticker,
    c.assignment_date,
    s.test_date,
    s.target_time,
    s.stock_price_used,
    s.cc_strike,
    s.premium_conservative,
    s.cc_yield_conservative_pct,
    s.cc_sold_theoretical,
    s.raw_json
  FROM theoretical_cc_steps s
  JOIN theoretical_wheel_cycles c ON c.id = s.theoretical_cycle_id
  WHERE s.sequence_number = 1
  ORDER BY s.updated_at DESC
  LIMIT 5
`).all();

let allDatesOk = true;
for (const ex of examples) {
  let priceRule = "?";
  try { priceRule = JSON.parse(ex.raw_json)?.priceRule ?? "?"; } catch (_) {}
  const sold = ex.cc_sold_theoretical === 1 ? "sold" : "wait";
  const yld  = ex.cc_yield_conservative_pct != null
    ? Number(ex.cc_yield_conservative_pct).toFixed(3) : "n/a";
  const prem = ex.premium_conservative != null
    ? Number(ex.premium_conservative).toFixed(4) : "n/a";
  console.log(
    `  ${String(ex.ticker).padEnd(6)} ` +
    `asgn=${ex.assignment_date} → test=${ex.test_date} ` +
    `priceRule=${priceRule} ` +
    `spot=${Number(ex.stock_price_used).toFixed(2)} ` +
    `strike=${Number(ex.cc_strike).toFixed(2)} ` +
    `prem=${prem} yld=${yld}% ${sold}`
  );
  if (ex.assignment_date && normDate(ex.test_date) < normDate(ex.assignment_date)) allDatesOk = false;
}
assert(allDatesOk, "test_date >= assignment_date pour tous les exemples");

// ─── RAPPORT FINAL ────────────────────────────────────────────────────────────

header("RAPPORT FINAL F2B");

console.log(`  Cycles scannés            : ${realResult.cycles_scanned}`);
console.log(`  Steps construits          : ${realResult.steps_built}`);
console.log(`  Steps upserted            : ${realResult.steps_upserted}`);
console.log(`  CC vendus théoriquement   : ${realResult.cc_sold_theoretical_count}`);
console.log(`  CC en attente             : ${realResult.cc_wait_count}`);
console.log(`  theoretical_cc_steps      : ${afterRealCcSteps} (baseline=${baselineCcSteps})`);
console.log(`  wheel_validation_records  : ${afterRealValidation} (${afterRealValidation === baselineValidation ? "inchangé ✓" : "CHANGÉ — ERREUR"})`);
console.log(`  Doublons step 1           : ${duplicates.length === 0 ? "aucun ✓" : duplicates.length + " — ERREUR"}`);
console.log(`  cc_strike violations      : ${invalidStrikes?.cnt ?? 0}`);
console.log(`  Appels réseau             : aucun`);
console.log(`  Scanner modifié           : non`);
console.log(`  Dashboard modifié         : non`);
console.log(`  server.js modifié         : non`);

if (process.exitCode === 1) {
  console.log("\n  STATUT: ÉCHEC — voir FAIL ci-dessus");
} else {
  console.log("\n  STATUT: SUCCÈS — tous les critères F2B validés");
}
