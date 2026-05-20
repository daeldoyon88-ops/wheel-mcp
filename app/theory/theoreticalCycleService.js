import { DatabaseSync } from "node:sqlite";
import { estimateCoveredCallPremium } from "./theoryPricingService.js";

export function createTheoreticalCycleService({ validationStore, cycleStore } = {}) {
  if (!validationStore?.sqlitePath) throw new Error("createTheoreticalCycleService: validationStore with sqlitePath is required");
  if (!cycleStore?.upsertCycle) throw new Error("createTheoreticalCycleService: cycleStore with upsertCycle is required");

  const sqlitePath = validationStore.sqlitePath;

  // ─────────────────────────────────────────────
  // buildCycleFromAssignedRecord
  // Pure function — receives a flat SQLite row from wheel_validation_records.
  // Returns a cycle object compatible with cycleStore.upsertCycle(), or null if invalid.
  // ─────────────────────────────────────────────
  function buildCycleFromAssignedRecord(record) {
    if (!record?.id) return null;
    const ticker = record.symbol ?? record.ticker ?? null;
    if (!ticker) return null;
    if (record.strike == null) return null;

    const isAssigned = record.assigned_flag === 1 || record.assigned_flag === true;
    if (!isAssigned) return null;

    const strike = Number(record.strike);
    if (!Number.isFinite(strike)) return null;

    const csp_premium = record.premium != null ? Number(record.premium) : null;

    const assignment_price =
      record.underlying_close_at_expiration != null ? Number(record.underlying_close_at_expiration) :
      record.expirationClosePrice != null ? Number(record.expirationClosePrice) :
      record.expiration_close_price != null ? Number(record.expiration_close_price) :
      null;

    // Prefer expiration date, then resolution date, then resolvedAt
    const assignment_date =
      record.expiration != null ? record.expiration :
      record.resolutionDate != null ? record.resolutionDate :
      record.resolvedAt != null ? record.resolvedAt :
      null;

    const spot_at_scan =
      record.spotAtScan != null ? Number(record.spotAtScan) :
      record.underlying_price_at_scan != null ? Number(record.underlying_price_at_scan) :
      record.spot_at_scan != null ? Number(record.spot_at_scan) :
      null;

    const reduced_cost_basis_estimated =
      Number.isFinite(strike) && csp_premium != null && Number.isFinite(csp_premium)
        ? strike - csp_premium
        : null;

    // data_quality: prefer numeric score, fall back to confidence string
    const data_quality =
      record.data_quality_score != null ? String(record.data_quality_score) :
      record.resolution_confidence != null ? record.resolution_confidence :
      null;

    return {
      id: `theoretical_cycle_${record.id}`,
      candidate_record_id: String(record.id),
      trade_signature: record.trade_signature ?? null,
      scan_session_id: record.scanSessionId ?? record.scan_session_id ?? null,
      scan_timestamp: record.scanTimestamp ?? record.scan_timestamp ?? null,
      scan_date: record.scanDate ?? record.scan_date ?? null,
      ticker,
      expiration: record.expiration ?? record.selectedExpiration ?? null,
      assignment_date,
      assignment_strike: strike,
      assignment_price,
      spot_at_scan,
      spot_at_assignment: assignment_price,
      strike_mode: record.strikeMode ?? record.strike_mode ?? null,
      csp_strike: strike,
      csp_premium,
      csp_yield_pct: record.annualizedYield != null ? Number(record.annualizedYield) : null,
      pop_estimate:
        record.popEstimate != null ? Number(record.popEstimate) :
        record.pop_estimate != null ? Number(record.pop_estimate) :
        null,
      distance_strike_from_spot_pct:
        record.distance_strike_from_spot_pct != null ? Number(record.distance_strike_from_spot_pct) : null,
      status: "open",
      current_step: 0,
      days_to_strike_touch: null,
      days_to_strike_close_above: null,
      days_below_assignment_strike: null,
      max_drawdown_pct:
        record.drawdownPct != null ? Number(record.drawdownPct) :
        record.drawdown_pct != null ? Number(record.drawdown_pct) :
        null,
      total_cc_premium_estimated: 0,
      total_cc_premium_conservative: 0,
      total_premium_estimated: csp_premium ?? 0,
      reduced_cost_basis_estimated,
      cc_sellable_steps_count: 0,
      cc_wait_steps_count: 0,
      best_cc_threshold_reached: null,
      source_prime_method: "not_priced_yet",
      confidence_level: record.resolution_confidence ?? "unknown",
      data_quality,
      raw: {
        source: "wheel_validation_records",
        assigned_flag: record.assigned_flag,
        resolved_source: record.resolved_source ?? null,
        resultStatus: record.resultStatus ?? null,
        outcomeStatus: record.outcomeStatus ?? null,
      },
    };
  }

  // ─────────────────────────────────────────────
  // generateCyclesFromAssignedRecords
  // Reads assigned CSP records from wheel_validation_records and creates
  // theoretical_wheel_cycles entries. Safe to re-run (idempotent via upsert).
  // ─────────────────────────────────────────────
  async function generateCyclesFromAssignedRecords({ limit = null, dryRun = false, includeExisting = false } = {}) {
    await cycleStore.ensureInitialized();

    // Open a read connection against the validation store's SQLite file.
    // Both stores share the same DB file; this is a read-only usage.
    const db = new DatabaseSync(sqlitePath);

    const totalRow = db.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records").get();
    const scanned_records = totalRow?.cnt ?? 0;

    const assignedCountRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE resolved = 1 AND assigned_flag = 1"
    ).get();
    const assigned_records = assignedCountRow?.cnt ?? 0;

    let sql =
      "SELECT * FROM wheel_validation_records WHERE resolved = 1 AND assigned_flag = 1 " +
      "AND strike IS NOT NULL AND symbol IS NOT NULL ORDER BY scanTimestamp DESC";
    if (limit != null) sql += ` LIMIT ${Number(limit)}`;

    const rows = db.prepare(sql).all();

    const errors = [];
    const built = [];
    let cycles_upserted = 0;
    let skipped_not_assigned = 0;
    let skipped_missing_required = 0;

    for (const row of rows) {
      const cycle = buildCycleFromAssignedRecord(row);
      if (!cycle) {
        skipped_missing_required++;
        continue;
      }
      built.push(cycle);

      if (!dryRun) {
        try {
          await cycleStore.upsertCycle(cycle);
          cycles_upserted++;
        } catch (err) {
          errors.push({ id: cycle.id, error: String(err?.message ?? err) });
        }
      }
    }

    const sample_cycles = built.slice(0, 5).map((c) => ({
      id: c.id,
      ticker: c.ticker,
      assignment_strike: c.assignment_strike,
      csp_premium: c.csp_premium,
      assignment_date: c.assignment_date,
      strike_mode: c.strike_mode,
      status: c.status,
    }));

    return {
      ok: true,
      dryRun,
      scanned_records,
      assigned_records,
      eligible_records: built.length,
      cycles_built: built.length,
      cycles_upserted,
      skipped_not_assigned,
      skipped_missing_required,
      errors,
      sample_cycles,
    };
  }

  // ─────────────────────────────────────────────
  // getFirstCcTestDateAfterAssignment
  // Pure — returns the first realistic CC sale session after assignment.
  // Rule V1 (no holiday calendar): Fri/Sat/Sun → Monday, else next day.
  // ─────────────────────────────────────────────
  function getFirstCcTestDateAfterAssignment(assignmentDate) {
    if (!assignmentDate) {
      return { testDate: new Date().toISOString().slice(0, 10), rule: "next_session_simple", daysAdded: 0 };
    }
    try {
      // Normalise YYYYMMDD (compact, no dashes) or YYYY-MM-DD to a local Date.
      // Using local ctor (year, month-1, day) avoids new Date("YYYYMMDD") being
      // parsed as UTC-midnight which can shift the day-of-week in non-UTC zones.
      const s = String(assignmentDate).replace(/-/g, "");
      if (!/^\d{8}$/.test(s)) throw new Error("unrecognised date format");
      const d = new Date(
        parseInt(s.slice(0, 4), 10),
        parseInt(s.slice(4, 6), 10) - 1,
        parseInt(s.slice(6, 8), 10)
      );
      const dow = d.getDay(); // 0=Sun,1=Mon,...,5=Fri,6=Sat
      const daysAdded = dow === 5 ? 3 : dow === 6 ? 2 : 1; // Fri→+3=Mon, Sat→+2=Mon, else→+1
      d.setDate(d.getDate() + daysAdded);
      // Format with local accessors to avoid UTC offset shifting the date back.
      const y   = d.getFullYear();
      const mo  = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return { testDate: `${y}-${mo}-${day}`, rule: "next_session_simple", daysAdded };
    } catch (_) {
      return { testDate: new Date().toISOString().slice(0, 10), rule: "next_session_simple", daysAdded: 0 };
    }
  }

  // ─────────────────────────────────────────────
  // selectFirstCcSpot
  // Pure — selects the best available spot for CC pricing on testDate.
  // V1: no post-assignment OHLC in SQLite → always falls back to assignment-era prices.
  // Returns null if no usable price is found.
  // ─────────────────────────────────────────────
  function selectFirstCcSpot({ cycle, sourceRecord, testDate: _testDate, options: _options = {} }) {
    const candidates = [
      { value: cycle.spot_at_assignment,                        rule: "fallback_assignment_close" },
      { value: sourceRecord?.underlying_close_at_expiration,   rule: "fallback_expiration_close" },
      { value: cycle.assignment_price,                          rule: "fallback_expiration_close" },
      { value: cycle.spot_at_scan,                              rule: "fallback_spot_at_scan"     },
    ];
    for (const { value, rule } of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        return {
          spot:        n,
          stock_open:  null,
          stock_high:  null,
          stock_low:   null,
          stock_close: n,
          priceRule:   rule,
          priceQuality: "fallback_no_post_assignment_price",
        };
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────
  // getCcExpirationFromTestDate
  // Pure — returns testDate + dte calendar days, formatted YYYY-MM-DD.
  // ─────────────────────────────────────────────
  function getCcExpirationFromTestDate(testDate, dte = 7) {
    try {
      // Parse YYYY-MM-DD parts directly (local ctor) to avoid UTC offset shifting.
      const [y, mo, day] = String(testDate).split("-").map(Number);
      const d = new Date(y, mo - 1, day);
      d.setDate(d.getDate() + dte);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } catch (_) {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // buildFirstCcStepForCycle
  // Pure function — receives a cycle and its source validation record.
  // Returns { step, pricing, error } or { step: null, pricing: null, error } if spot is unavailable.
  // RULE: cc_strike is always set to assignment_strike (never below).
  // ─────────────────────────────────────────────
  function buildFirstCcStepForCycle({ cycle, sourceRecord, options = {} }) {
    const defaultCcDte       = options.defaultCcDte       ?? 7;
    const riskFreeRate       = options.riskFreeRate       ?? 0.045;
    const dividendYield      = options.dividendYield      ?? 0;
    const conservativeFactor = options.conservativeFactor ?? 0.8;

    const assignment_strike = Number(cycle.assignment_strike);
    const cc_strike = assignment_strike; // RULE: never below assignment_strike

    // test_date: first trading session after assignment (Fri/Sat/Sun → Monday)
    const testDateInfo = getFirstCcTestDateAfterAssignment(cycle.assignment_date);
    const test_date = testDateInfo.testDate;

    // spot: V1 fallback chain — no post-assignment OHLC stored yet
    const spotInfo = selectFirstCcSpot({ cycle, sourceRecord, testDate: test_date, options });
    if (!spotInfo) {
      return { step: null, pricing: null, error: "no_valid_spot" };
    }
    const spot = spotInfo.spot;

    // cc_expiration: test_date + dte calendar days
    const cc_expiration = getCcExpirationFromTestDate(test_date, defaultCcDte);

    // target_time reflects the actual price rule used
    const target_time =
      spotInfo.priceRule === "next_session_open"  ? "next_session_open"  :
      spotInfo.priceRule === "next_session_close" ? "next_session_close" :
      spotInfo.priceRule;

    const hv30         = sourceRecord?.hv30_at_scan          != null ? Number(sourceRecord.hv30_at_scan)          : null;
    const atmIv        = sourceRecord?.atm_iv_at_scan         != null ? Number(sourceRecord.atm_iv_at_scan)         : null;
    const safeStrikeIv = sourceRecord?.safe_strike_iv_at_scan != null ? Number(sourceRecord.safe_strike_iv_at_scan) : null;

    const pricing = estimateCoveredCallPremium({
      spot,
      assignmentStrike: assignment_strike,
      ccStrike:         cc_strike,
      dte:              defaultCcDte,
      hv30,
      atmIv,
      safeStrikeIv,
      riskFreeRate,
      dividendYield,
      conservativeFactor,
    });

    const baseStep = {
      id:                   `theoretical_cc_step_${cycle.id}_1`,
      theoretical_cycle_id: cycle.id,
      candidate_record_id:  cycle.candidate_record_id,
      ticker:               cycle.ticker,
      sequence_number:      1,
      test_date,
      target_time,
      cc_expiration,
      dte:                  defaultCcDte,
      stock_price_used:     spot,
      stock_open:           spotInfo.stock_open,
      stock_high:           spotInfo.stock_high,
      stock_low:            spotInfo.stock_low,
      stock_close:          spotInfo.stock_close,
      assignment_strike,
      cc_strike,
      risk_free_rate:       riskFreeRate,
      dividend_yield:       dividendYield,
      conservative_factor:  conservativeFactor,
      data_quality:         "estimated_black_scholes",
    };

    const rawExtra = {
      testDateRule:   testDateInfo.rule,
      priceRule:      spotInfo.priceRule,
      priceQuality:   spotInfo.priceQuality,
      assignmentDate: cycle.assignment_date,
      testDate:       test_date,
      usedFallback:   spotInfo.priceQuality === "fallback_no_post_assignment_price",
    };

    if (!pricing.ok) {
      return {
        step: {
          ...baseStep,
          volatility_used:           null,
          volatility_source:         null,
          bs_call_premium:           null,
          premium_estimated:         null,
          premium_conservative:      null,
          cc_yield_pct:              null,
          cc_yield_conservative_pct: null,
          cc_sold_theoretical:       0,
          not_sold_reason:           "pricing_unavailable",
          best_threshold_reached:    null,
          threshold_0_5_hit: 0, threshold_0_75_hit: 0, threshold_1_0_hit: 0,
          threshold_1_5_hit: 0, threshold_2_0_hit: 0,  threshold_2_5_hit: 0,
          threshold_3_0_hit: 0, threshold_4_0_hit: 0,  threshold_5_0_hit: 0,
          threshold_6_0_hit: 0,
          raw: {
            source:         "black_scholes_first_cc_step",
            pricing_source: null,
            error:          pricing.error,
            inputs:         { hv30, atmIv, safeStrikeIv, spot, assignment_strike, cc_strike, dte: defaultCcDte },
            thresholds:     null,
            sourceRecordId: cycle.candidate_record_id,
            ...rawExtra,
          },
        },
        pricing,
        error: pricing.error,
      };
    }

    // Map thresholds by pct
    const thresholdMap = {};
    for (const t of pricing.thresholds) thresholdMap[t.thresholdPct] = t.reached;

    let best_threshold_reached = null;
    for (const t of [...pricing.thresholds].reverse()) {
      if (t.reached) { best_threshold_reached = t.thresholdPct; break; }
    }

    const cc_yield_conservative_pct = pricing.ccYieldConservativePct;
    const cc_sold_theoretical = cc_yield_conservative_pct >= 0.5 ? 1 : 0;
    const not_sold_reason     = cc_sold_theoretical === 1 ? null : "yield_below_0_5_pct";

    return {
      step: {
        ...baseStep,
        volatility_used:           pricing.volatilityUsed,
        volatility_source:         pricing.volatilitySource,
        bs_call_premium:           pricing.bsPremium,
        premium_estimated:         pricing.premiumEstimated,
        premium_conservative:      pricing.premiumConservative,
        cc_yield_pct:              pricing.ccYieldPct,
        cc_yield_conservative_pct,
        cc_sold_theoretical,
        not_sold_reason,
        best_threshold_reached,
        threshold_0_5_hit:  thresholdMap[0.5]  ? 1 : 0,
        threshold_0_75_hit: thresholdMap[0.75] ? 1 : 0,
        threshold_1_0_hit:  thresholdMap[1.0]  ? 1 : 0,
        threshold_1_5_hit:  thresholdMap[1.5]  ? 1 : 0,
        threshold_2_0_hit:  thresholdMap[2.0]  ? 1 : 0,
        threshold_2_5_hit:  thresholdMap[2.5]  ? 1 : 0,
        threshold_3_0_hit:  thresholdMap[3.0]  ? 1 : 0,
        threshold_4_0_hit:  thresholdMap[4.0]  ? 1 : 0,
        threshold_5_0_hit:  thresholdMap[5.0]  ? 1 : 0,
        threshold_6_0_hit:  thresholdMap[6.0]  ? 1 : 0,
        raw: {
          source:            "black_scholes_first_cc_step",
          pricing_source:    pricing.source,
          volatility_source: pricing.volatilitySource,
          inputs:            pricing.inputs,
          thresholds:        pricing.thresholds,
          sourceRecordId:    cycle.candidate_record_id,
          ...rawExtra,
        },
      },
      pricing,
      error: null,
    };
  }

  // ─────────────────────────────────────────────
  // generateFirstCcStepsForOpenCycles
  // Iterates all open theoretical cycles, builds a CC step at sequence_number=1,
  // and upserts it. Safe to re-run (idempotent via UNIQUE constraint + skip logic).
  // ─────────────────────────────────────────────
  async function generateFirstCcStepsForOpenCycles({
    dryRun             = false,
    limit              = null,
    defaultCcDte       = 7,
    conservativeFactor = 0.8,
    riskFreeRate       = 0.045,
    dividendYield      = 0,
    includeExisting    = false,
    forceRefresh       = false, // overwrite existing step 1 (upsert) without skipping
  } = {}) {
    await cycleStore.ensureInitialized();

    const db = new DatabaseSync(sqlitePath);
    let cyclesSql = "SELECT * FROM theoretical_wheel_cycles WHERE status = 'open' ORDER BY created_at DESC";
    if (limit != null) cyclesSql += ` LIMIT ${Number(limit)}`;
    const openCycles = db.prepare(cyclesSql).all();

    const cycles_scanned = openCycles.length;
    let cycles_eligible              = 0;
    let source_records_found         = 0;
    let steps_built                  = 0;
    let steps_upserted               = 0;
    let skipped_existing             = 0;
    let skipped_missing_source_record = 0;
    let skipped_pricing_unavailable  = 0;
    let cc_sold_theoretical_count    = 0;
    let cc_wait_count                = 0;
    const errors       = [];
    const sample_steps = [];

    const options = { defaultCcDte, conservativeFactor, riskFreeRate, dividendYield };

    for (const cycle of openCycles) {
      if (!includeExisting && !forceRefresh) {
        const existingSteps = await cycleStore.listCcSteps(cycle.id);
        if (existingSteps.some((s) => s.sequence_number === 1)) {
          skipped_existing++;
          continue;
        }
      }

      cycles_eligible++;

      const sourceRow = db
        .prepare("SELECT * FROM wheel_validation_records WHERE id = @id")
        .get({ id: String(cycle.candidate_record_id) });
      if (!sourceRow) {
        skipped_missing_source_record++;
        continue;
      }
      source_records_found++;

      const result = buildFirstCcStepForCycle({ cycle, sourceRecord: sourceRow, options });

      if (!result.step) {
        skipped_pricing_unavailable++;
        continue;
      }

      steps_built++;
      if (result.step.cc_sold_theoretical === 1) cc_sold_theoretical_count++;
      else cc_wait_count++;

      if (sample_steps.length < 5) {
        const raw = result.step.raw ?? {};
        sample_steps.push({
          ticker:                    result.step.ticker,
          assignment_date:           cycle.assignment_date,
          test_date:                 result.step.test_date,
          priceRule:                 raw.priceRule ?? null,
          stock_price_used:          result.step.stock_price_used,
          assignment_strike:         result.step.assignment_strike,
          cc_strike:                 result.step.cc_strike,
          premium_conservative:      result.step.premium_conservative,
          cc_yield_conservative_pct: result.step.cc_yield_conservative_pct,
          best_threshold_reached:    result.step.best_threshold_reached,
          cc_sold_theoretical:       result.step.cc_sold_theoretical,
          not_sold_reason:           result.step.not_sold_reason,
        });
      }

      if (!dryRun) {
        try {
          await cycleStore.upsertCcStep(result.step);
          steps_upserted++;
        } catch (err) {
          errors.push({ cycle_id: cycle.id, error: String(err?.message ?? err) });
        }
      }
    }

    return {
      ok: true,
      dryRun,
      cycles_scanned,
      cycles_eligible,
      source_records_found,
      steps_built,
      steps_upserted,
      skipped_existing,
      skipped_missing_source_record,
      skipped_pricing_unavailable,
      cc_sold_theoretical_count,
      cc_wait_count,
      errors,
      sample_steps,
    };
  }

  // ─────────────────────────────────────────────
  // summarizeCycleFromCcSteps
  // Pure function — receives a cycle and its CC steps array.
  // Returns consolidated summary fields for theoretical_wheel_cycles update.
  // Does NOT touch DB, does NOT create/modify cc_steps.
  // ─────────────────────────────────────────────
  function summarizeCycleFromCcSteps({ cycle, ccSteps }) {
    const soldSteps = ccSteps.filter((s) => s.cc_sold_theoretical === 1);
    const waitSteps = ccSteps.filter((s) => s.cc_sold_theoretical !== 1);

    const total_cc_premium_estimated = soldSteps.reduce((sum, s) => {
      const p = s.premium_estimated != null ? Number(s.premium_estimated) : 0;
      return sum + (Number.isFinite(p) ? p : 0);
    }, 0);

    // Conservative prime per step: premium_conservative > premium_estimated > bs_call_premium
    const total_cc_premium_conservative = soldSteps.reduce((sum, s) => {
      let p = null;
      if (s.premium_conservative != null) p = Number(s.premium_conservative);
      else if (s.premium_estimated != null) p = Number(s.premium_estimated);
      else if (s.bs_call_premium != null) p = Number(s.bs_call_premium);
      return sum + (p != null && Number.isFinite(p) ? p : 0);
    }, 0);

    const cc_sellable_steps_count = soldSteps.length;
    const cc_wait_steps_count = waitSteps.length;

    let best_cc_threshold_reached = null;
    for (const s of soldSteps) {
      const t = s.best_threshold_reached != null ? Number(s.best_threshold_reached) : null;
      if (t != null && Number.isFinite(t)) {
        if (best_cc_threshold_reached === null || t > best_cc_threshold_reached) {
          best_cc_threshold_reached = t;
        }
      }
    }

    const current_step = ccSteps.length;

    const cspPremium = cycle.csp_premium != null ? Number(cycle.csp_premium) : null;
    const assignmentStrike = Number(cycle.assignment_strike);

    const total_premium_estimated = (cspPremium ?? 0) + total_cc_premium_conservative;

    const reduced_cost_basis_estimated =
      cspPremium != null && Number.isFinite(assignmentStrike)
        ? assignmentStrike - cspPremium - total_cc_premium_conservative
        : null;

    const hasCalled = ccSteps.some((s) => s.called_away_theoretical === 1);
    const status = hasCalled ? "closed_theoretical" : "open";

    return {
      total_cc_premium_estimated,
      total_cc_premium_conservative,
      total_premium_estimated,
      reduced_cost_basis_estimated,
      cc_sellable_steps_count,
      cc_wait_steps_count,
      best_cc_threshold_reached,
      current_step,
      status,
      data_quality: cycle.data_quality ?? "estimated_black_scholes",
      source_prime_method: "black_scholes_first_cc_step",
    };
  }

  // ─────────────────────────────────────────────
  // updateCycleSummaryFromCcSteps
  // Updates a single cycle's summary fields from its CC steps.
  // If dryRun=true, computes but does not upsert.
  // ─────────────────────────────────────────────
  async function updateCycleSummaryFromCcSteps({ cycle, ccSteps, dryRun = false }) {
    const summary = summarizeCycleFromCcSteps({ cycle, ccSteps });
    const updatedCycle = { ...cycle, ...summary };

    if (!dryRun) {
      await cycleStore.upsertCycle(updatedCycle);
    }

    return {
      ok: true,
      dryRun,
      cycle_id: cycle.id,
      ticker: cycle.ticker,
      updated: !dryRun,
      summary,
    };
  }

  // ─────────────────────────────────────────────
  // refreshAllCycleSummaries
  // POP V2-F3 consolidation: reads all theoretical_wheel_cycles + their
  // cc_steps, computes summary fields, upserts each cycle (unless dryRun).
  // Does NOT create, modify, or delete theoretical_cc_steps.
  // ─────────────────────────────────────────────
  async function refreshAllCycleSummaries({
    dryRun = false,
    limit = null,
    includeCyclesWithoutSteps = true,
  } = {}) {
    await cycleStore.ensureInitialized();

    const cycles = await cycleStore.listCycles(limit != null ? Number(limit) : 999999);

    let cycles_scanned = cycles.length;
    let cycles_with_steps = 0;
    let cycles_without_steps = 0;
    let cycles_updated = 0;
    let total_cc_steps_seen = 0;
    let total_cc_sold_seen = 0;
    let total_cc_wait_seen = 0;
    let total_cc_premium_conservative = 0;
    let best_threshold_global = null;
    const errors = [];
    const sample_cycles = [];

    for (const cycle of cycles) {
      try {
        const ccSteps = await cycleStore.listCcSteps(cycle.id);

        if (ccSteps.length === 0) {
          cycles_without_steps++;
          if (!includeCyclesWithoutSteps) continue;
          const summary = summarizeCycleFromCcSteps({ cycle, ccSteps: [] });
          if (!dryRun) {
            await cycleStore.upsertCycle({ ...cycle, ...summary });
            cycles_updated++;
          }
          continue;
        }

        cycles_with_steps++;
        total_cc_steps_seen += ccSteps.length;

        const soldSteps = ccSteps.filter((s) => s.cc_sold_theoretical === 1);
        const waitSteps = ccSteps.filter((s) => s.cc_sold_theoretical !== 1);
        total_cc_sold_seen += soldSteps.length;
        total_cc_wait_seen += waitSteps.length;

        const summary = summarizeCycleFromCcSteps({ cycle, ccSteps });

        total_cc_premium_conservative += summary.total_cc_premium_conservative;

        if (summary.best_cc_threshold_reached != null) {
          if (
            best_threshold_global === null ||
            summary.best_cc_threshold_reached > best_threshold_global
          ) {
            best_threshold_global = summary.best_cc_threshold_reached;
          }
        }

        if (sample_cycles.length < 5) {
          sample_cycles.push({
            ticker: cycle.ticker,
            assignment_strike: cycle.assignment_strike,
            csp_premium: cycle.csp_premium,
            total_cc_premium_conservative: summary.total_cc_premium_conservative,
            total_premium_estimated: summary.total_premium_estimated,
            reduced_cost_basis_estimated: summary.reduced_cost_basis_estimated,
            cc_sellable_steps_count: summary.cc_sellable_steps_count,
            cc_wait_steps_count: summary.cc_wait_steps_count,
            best_cc_threshold_reached: summary.best_cc_threshold_reached,
          });
        }

        if (!dryRun) {
          await cycleStore.upsertCycle({ ...cycle, ...summary });
          cycles_updated++;
        }
      } catch (err) {
        errors.push({ cycle_id: cycle.id, error: String(err?.message ?? err) });
      }
    }

    return {
      ok: true,
      dryRun,
      cycles_scanned,
      cycles_with_steps,
      cycles_without_steps,
      cycles_updated,
      total_cc_steps_seen,
      total_cc_sold_seen,
      total_cc_wait_seen,
      total_cc_premium_conservative,
      best_threshold_global,
      errors,
      sample_cycles,
    };
  }

  async function listTheoreticalCycles(limit = 100) {
    return cycleStore.listCycles(limit);
  }

  async function getTheoreticalCycleSummary() {
    return cycleStore.getSummary();
  }

  return {
    buildCycleFromAssignedRecord,
    generateCyclesFromAssignedRecords,
    listTheoreticalCycles,
    getTheoreticalCycleSummary,
    buildFirstCcStepForCycle,
    generateFirstCcStepsForOpenCycles,
    summarizeCycleFromCcSteps,
    updateCycleSummaryFromCcSteps,
    refreshAllCycleSummaries,
  };
}
