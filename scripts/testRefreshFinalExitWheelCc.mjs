/**
 * testRefreshFinalExitWheelCc.mjs
 *
 * POP V2 Phase 3 validation — final exit / called away logic.
 *
 * Usage: node scripts/testRefreshFinalExitWheelCc.mjs
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
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function countTable(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get()?.cnt ?? 0;
  } catch (_) {
    return 0;
  }
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const service = createTheoreticalCycleService({ validationStore, cycleStore });
const db = new DatabaseSync(SQLITE_PATH);

await cycleStore.ensureInitialized();

const mockCycle = {
  id: "test_final_exit_cycle",
  ticker: "TEST",
  assignment_date: "2025-01-10",
  scan_date: "2025-01-03",
  assignment_strike: 100,
  csp_premium: 1.5,
};

function makeStep({ seq, exp, sold = 1, strike = 100, premium = 0.6 }) {
  return {
    id: `step_${seq}`,
    theoretical_cycle_id: mockCycle.id,
    sequence_number: seq,
    cc_expiration: exp,
    cc_strike: strike,
    assignment_strike: 100,
    cc_sold_theoretical: sold,
    premium_conservative: premium,
    not_sold_reason: sold === 1 ? null : "yield_below_0_5_pct",
  };
}

function candlesFor(exp, close) {
  return [{ date: exp, open: close, high: close, low: close, close }];
}

header("TEST 1 — CC vendu, close >= cc_strike → called away, cycle closed");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 100 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 102),
    todayYmd: "2025-01-20",
  });
  assert(result.cycle_status === "closed", "cycle_status = closed");
  assert(result.close_reason === "cc_called_away", "close_reason = cc_called_away");
  assert(result.final_exit_price === 100, "final_exit_price = cc_strike");
  assert(result.evaluatedSteps[0].outcome.result_at_expiration === "called_away", "step called away");
}

header("TEST 2 — CC vendu, close < cc_strike → expired OTM, cycle open");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 100 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 98),
    todayYmd: "2025-01-20",
  });
  assert(result.cycle_status === "open", "cycle_status = open");
  assert(result.final_exit_date == null, "no final_exit_date");
  assert(result.evaluatedSteps[0].outcome.result_at_expiration === "expired_otm", "expired OTM");
  assert(result.expired_otm_count === 1, "expired_otm_count = 1");
}

header("TEST 3 — CC non vendu → pas de called away");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", sold: 0 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 110),
    todayYmd: "2025-01-20",
  });
  assert(result.cycle_status === "open", "cycle open");
  assert(result.called_away_count === 0, "called_away_count = 0");
  assert(result.evaluatedSteps[0].outcome.result_at_expiration === "not_sold", "not_sold");
}

header("TEST 4 — Premier OTM, deuxième called away → final_exit_sequence_number = 2");
{
  const steps = [
    makeStep({ seq: 1, exp: "2025-01-17", strike: 100, premium: 0.55 }),
    makeStep({ seq: 2, exp: "2025-01-24", strike: 100, premium: 0.58 }),
  ];
  const candles = [
    ...candlesFor("2025-01-17", 99),
    ...candlesFor("2025-01-24", 101),
  ];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles,
    todayYmd: "2025-01-30",
  });
  assert(result.cycle_status === "closed", "cycle closed on step 2");
  assert(result.final_exit_sequence_number === 2, "final_exit_sequence_number = 2");
  assert(result.expired_otm_count === 1, "first step expired OTM");
  assert(result.called_away_count === 1, "second step called away");
}

header("TEST 5 — final_exit_price jamais sous assignment_strike");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 100 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 105),
    todayYmd: "2025-01-20",
  });
  assert(
    result.final_exit_price == null || result.final_exit_price >= mockCycle.assignment_strike,
    "final_exit_price >= assignment_strike"
  );
  const belowInDb = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_price IS NOT NULL AND final_exit_price < assignment_strike"
    )
    .get()?.cnt ?? 0;
  assert(belowInDb === 0, `aucun final_exit_price < assignment_strike en DB (got ${belowInDb})`);
}

header("TEST 6 — total_pnl_per_share correct");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 105, premium: 0.6 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 106),
    todayYmd: "2025-01-20",
  });
  const expectedGross = 105 - 100;
  const expectedPremium = 1.5 + 0.6;
  const expectedTotal = expectedGross + expectedPremium;
  assert(Math.abs(result.gross_stock_pnl_per_share - expectedGross) < 0.0001, "gross_stock_pnl correct");
  assert(Math.abs(result.premium_pnl_per_share - expectedPremium) < 0.0001, "premium_pnl correct");
  assert(Math.abs(result.total_pnl_per_share - expectedTotal) < 0.0001, "total_pnl_per_share correct");
  assert(Math.abs(result.total_pnl_contract - expectedTotal * 100) < 0.01, "total_pnl_contract correct");
}

header("TEST 7 — return_on_assignment_pct correct");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 105, premium: 0.6 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: candlesFor("2025-01-17", 106),
    todayYmd: "2025-01-20",
  });
  const expectedReturn = (result.total_pnl_per_share / mockCycle.assignment_strike) * 100;
  assert(Math.abs(result.return_on_assignment_pct - expectedReturn) < 0.0001, "return_on_assignment_pct correct");
}

header("TEST 8 — expiration future ne ferme pas le cycle");
{
  const futureExp = "2099-12-31";
  const steps = [makeStep({ seq: 1, exp: futureExp, strike: 100 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: [],
    todayYmd: "2025-01-20",
  });
  assert(result.cycle_status === "open", "cycle reste open");
  assert(result.evaluatedSteps[0].outcome.result_at_expiration === "pending_expiration", "pending_expiration");
}

header("TEST 9 — missing expiration price ne ferme pas le cycle");
{
  const steps = [makeStep({ seq: 1, exp: "2025-01-17", strike: 100 })];
  const result = service.computeFinalExitForCycle({
    cycle: mockCycle,
    ccSteps: steps,
    candles: [],
    todayYmd: "2025-01-20",
  });
  assert(result.cycle_status === "open", "cycle open sans OHLC");
  assert(
    result.evaluatedSteps[0].outcome.result_at_expiration === "missing_expiration_price",
    "missing_expiration_price"
  );
}

header("TEST 12 — IREN-like: close 56.83 >= strike 53 → called away");
{
  const irenCycle = {
    id: "test_iren_called_away",
    ticker: "IREN",
    assignment_date: "2026-05-15",
    scan_date: "2026-05-10",
    assignment_strike: 53,
    csp_premium: 0.85,
  };
  const steps = [
    {
      ...makeStep({ seq: 1, exp: "2026-05-22", strike: 53, premium: 0.55 }),
      theoretical_cycle_id: irenCycle.id,
      assignment_strike: 53,
    },
  ];
  const result = service.computeFinalExitForCycle({
    cycle: irenCycle,
    ccSteps: steps,
    candles: [{ date: "2026-05-22", open: 55, high: 57, low: 54, close: 56.83 }],
    todayYmd: "2026-05-24",
  });
  assert(result.cycle_status === "closed", "IREN-like cycle closed");
  assert(result.close_reason === "cc_called_away", "IREN-like cc_called_away");
  assert(result.final_exit_date === "2026-05-22", "IREN-like final_exit_date");
  assert(result.final_exit_price === 53, "IREN-like final_exit_price = cc_strike");
  assert(result.evaluatedSteps[0].outcome.result_at_expiration === "called_away", "IREN-like called_away");
  assert(result.evaluatedSteps[0].outcome.expiration_price_source === "expiration_daily_close", "IREN-like exact close source");
}

header("TEST 13 — cc_expiration format YYYYMMDD");
{
  const steps = [
    {
      ...makeStep({ seq: 1, exp: "20260522", strike: 53, premium: 0.55 }),
      assignment_strike: 53,
    },
  ];
  const resolution = service.resolveExpirationClosePrice({
    ccExpirationYmd: steps[0].cc_expiration,
    candles: [{ date: "2026-05-22", close: 56.83 }],
    todayYmd: "2026-05-24",
  });
  assert(resolution.close === 56.83, "YYYYMMDD exp → close trouvé");
  assert(resolution.source === "expiration_daily_close", "YYYYMMDD exp → source exacte");
}

header("TEST 14 — resolveExpirationClosePrice: close exact à la date d'expiration");
{
  const resolution = service.resolveExpirationClosePrice({
    ccExpirationYmd: "2026-05-22",
    candles: [
      { date: "2026-05-20", close: 54 },
      { date: "2026-05-21", close: 55 },
      { date: "2026-05-22", close: 56.83 },
    ],
    todayYmd: "2026-05-24",
  });
  assert(resolution.close === 56.83, "close exact 2026-05-22");
  assert(resolution.priceDate === "2026-05-22", "priceDate = expiration");
  assert(resolution.source === "expiration_daily_close", "source expiration_daily_close");
}

header("TEST 15 — resolveExpirationClosePrice: fallback jour de marché précédent seulement");
{
  const resolution = service.resolveExpirationClosePrice({
    ccExpirationYmd: "2026-05-22",
    candles: [
      { date: "2026-05-20", close: 54 },
      { date: "2026-05-21", close: 55.5 },
    ],
    todayYmd: "2026-05-24",
  });
  assert(resolution.close === 55.5, "fallback = dernier close <= expiration");
  assert(resolution.priceDate === "2026-05-21", "fallback priceDate = 2026-05-21");
  assert(resolution.source === "previous_market_close_fallback", "source fallback");
}

header("TEST 16 — resolveExpirationClosePrice: ignore les dates après expiration");
{
  const resolution = service.resolveExpirationClosePrice({
    ccExpirationYmd: "2026-05-22",
    candles: [{ date: "2026-05-23", close: 99 }],
    todayYmd: "2026-05-24",
  });
  assert(resolution.close == null, "date post-expiration ignorée");
  assert(resolution.source === "missing", "missing si seulement post-expiration");
}

header("TEST 10 — dry-run n'écrit rien");
const baselineBackfilled = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_backfilled_at IS NOT NULL")
  .get()?.cnt ?? 0;
const dryResult = await service.refreshFinalExitForWheelCycles({ dryRun: true, limit: 3 });
assert(dryResult.ok === true, "dryRun ok");
assert(dryResult.cycles_updated === 0, "dryRun: cycles_updated = 0");
const afterDryBackfilled = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_backfilled_at IS NOT NULL")
  .get()?.cnt ?? 0;
assert(afterDryBackfilled === baselineBackfilled, "dryRun: final_exit_backfilled inchangé");

header("TEST 11 — write persiste les changements");
const beforeWriteBackfilled =
  db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_backfilled_at IS NOT NULL").get()?.cnt ?? 0;
const writeResult = await service.refreshFinalExitForWheelCycles({
  dryRun: false,
  limit: 1,
  forceRefresh: true,
  onlyMissing: false,
});
assert(writeResult.ok === true, "write ok");
if (writeResult.cycles_eligible >= 1) {
  assert(writeResult.cycles_updated >= 1, "au moins 1 cycle mis à jour");
  const afterWriteBackfilled =
    db.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE final_exit_backfilled_at IS NOT NULL").get()?.cnt ?? 0;
  assert(afterWriteBackfilled >= beforeWriteBackfilled, "final_exit_backfilled persisté");
} else {
  console.log("  WARN: aucun cycle éligible avec cc_steps pour test write");
}

const ccBelowStrike = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_strike < assignment_strike")
  .get()?.cnt ?? 0;
assert(ccBelowStrike === 0, `aucun CC sous assignment_strike (got ${ccBelowStrike})`);

console.log("\n  Tests terminés.");
