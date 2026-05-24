import { DatabaseSync } from "node:sqlite";
import { estimateCoveredCallPremium } from "./theoryPricingService.js";
import { createMarketService } from "../services/marketService.js";
import { YahooMarketDataProvider } from "../data_providers/yahooMarketDataProvider.js";

export function createTheoreticalCycleService({ validationStore, cycleStore, marketService } = {}) {
  if (!validationStore?.sqlitePath) throw new Error("createTheoreticalCycleService: validationStore with sqlitePath is required");
  if (!cycleStore?.upsertCycle) throw new Error("createTheoreticalCycleService: cycleStore with upsertCycle is required");

  const sqlitePath = validationStore.sqlitePath;
  const effectiveMarketService = marketService ?? createMarketService(new YahooMarketDataProvider());

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
      assignment_recovery_date: null,
      assignment_recovered: null,
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
  function normalizePositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function buildFallbackFirstCcSpot({ cycle, sourceRecord, officialPriceRule }) {
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
          usedPostAssignmentOhlc: false,
          ohlcSource: null,
          ohlcDate: null,
          usedFallback: true,
          officialPriceRule,
        };
      }
    }
    return null;
  }

  function selectSpotFromOfficialPriceRule({ ohlc, officialPriceRule }) {
    const stock_open = normalizePositiveNumber(ohlc?.open);
    const stock_high = normalizePositiveNumber(ohlc?.high);
    const stock_low = normalizePositiveNumber(ohlc?.low);
    const stock_close = normalizePositiveNumber(ohlc?.close);
    const midpoint =
      stock_high != null && stock_low != null
        ? (stock_high + stock_low) / 2
        : null;

    const prioritiesByRule = {
      open: [
        { spot: stock_open, priceRule: "next_session_open" },
        { spot: stock_close, priceRule: "next_session_close" },
        { spot: midpoint, priceRule: "next_session_high_low_midpoint" },
      ],
      close: [
        { spot: stock_close, priceRule: "next_session_close" },
        { spot: stock_open, priceRule: "next_session_open" },
        { spot: midpoint, priceRule: "next_session_high_low_midpoint" },
      ],
      midpoint: [
        { spot: midpoint, priceRule: "next_session_high_low_midpoint" },
        { spot: stock_open, priceRule: "next_session_open" },
        { spot: stock_close, priceRule: "next_session_close" },
      ],
    };

    const priorities = prioritiesByRule[officialPriceRule] ?? prioritiesByRule.open;
    for (const candidate of priorities) {
      if (candidate.spot != null) {
        return {
          spot: candidate.spot,
          stock_open,
          stock_high,
          stock_low,
          stock_close,
          priceRule: candidate.priceRule,
          priceQuality: "post_assignment_daily_ohlc",
          usedPostAssignmentOhlc: true,
          ohlcSource: ohlc?.source ?? "yahoo_daily",
          ohlcDate: ohlc?.date ?? null,
          usedFallback: false,
          officialPriceRule,
        };
      }
    }

    return null;
  }

  async function selectFirstCcSpot({ cycle, sourceRecord, testDate, options = {} }) {
    const usePostAssignmentOhlc = options.usePostAssignmentOhlc !== false;
    const officialPriceRule =
      options.officialPriceRule === "close" || options.officialPriceRule === "midpoint"
        ? options.officialPriceRule
        : "open";

    if (usePostAssignmentOhlc && effectiveMarketService?.getDailyOhlcForDate && cycle?.ticker && testDate) {
      const ohlc = await effectiveMarketService.getDailyOhlcForDate(cycle.ticker, testDate);
      if (ohlc?.ok) {
        const ohlcSpot = selectSpotFromOfficialPriceRule({ ohlc, officialPriceRule });
        if (ohlcSpot) return ohlcSpot;
      }
    }

    return buildFallbackFirstCcSpot({ cycle, sourceRecord, officialPriceRule });
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
  // addCalendarDaysToYmd / computeCalendarDaysBetween
  // Pure date helpers (local timezone, no UTC shift).
  // ─────────────────────────────────────────────
  function parseYmdToLocalDate(ymd) {
    const normalized = normalizeDateToYmd(ymd);
    if (!normalized) return null;
    const [y, mo, day] = normalized.split("-").map(Number);
    return new Date(y, mo - 1, day);
  }

  function formatLocalDateToYmd(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addCalendarDaysToYmd(ymd, days) {
    const d = parseYmdToLocalDate(ymd);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return formatLocalDateToYmd(d);
  }

  function computeCalendarDaysBetween(startYmd, endYmd) {
    const start = parseYmdToLocalDate(startYmd);
    const end = parseYmdToLocalDate(endYmd);
    if (!start || !end) return null;
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  }

  // ─────────────────────────────────────────────
  // getWeeklyCcExpirationFromTestDate
  // Pure — weekly CC expiration on the following Friday.
  // ─────────────────────────────────────────────
  function getWeeklyCcExpirationFromTestDate(testDate) {
    const d = parseYmdToLocalDate(testDate);
    if (!d) return { cc_expiration: null, dte: null };
    const dow = d.getDay(); // 0=Sun, 5=Fri
    let daysToFriday;
    if (dow === 5) {
      daysToFriday = 7;
    } else if (dow < 5) {
      daysToFriday = 5 - dow;
    } else {
      daysToFriday = 5 + (7 - dow);
    }
    d.setDate(d.getDate() + daysToFriday);
    return {
      cc_expiration: formatLocalDateToYmd(d),
      dte: daysToFriday,
    };
  }

  // ─────────────────────────────────────────────
  // getNextMarketSessionAfter
  // Pure — first market session after a calendar date (Fri/Sat/Sun → Monday).
  // ─────────────────────────────────────────────
  function getNextMarketSessionAfter(dateYmd) {
    return getFirstCcTestDateAfterAssignment(dateYmd);
  }

  // ─────────────────────────────────────────────
  // computeBeforeRecoveryFlagsForStep
  // Pure — before_recovery_flag and assignment_recovered_at_step_flag.
  // ─────────────────────────────────────────────
  function computeBeforeRecoveryFlagsForStep({
    testDate,
    assignmentRecoveryDate,
    assignmentRecovered,
    firstAfterRecoveryMarkedRef,
  }) {
    const recoveryYmd = normalizeDateToYmd(assignmentRecoveryDate);
    const recovered = assignmentRecovered === 1 || assignmentRecovered === true;

    if (!recovered || !recoveryYmd) {
      return {
        before_recovery_flag: 1,
        assignment_recovered_at_step_flag: 0,
      };
    }

    const testYmd = normalizeDateToYmd(testDate);
    const before_recovery_flag = testYmd && testYmd < recoveryYmd ? 1 : 0;

    let assignment_recovered_at_step_flag = 0;
    if (testYmd && testYmd >= recoveryYmd && firstAfterRecoveryMarkedRef && !firstAfterRecoveryMarkedRef.value) {
      assignment_recovered_at_step_flag = 1;
      firstAfterRecoveryMarkedRef.value = true;
    }

    return { before_recovery_flag, assignment_recovered_at_step_flag };
  }

  // ─────────────────────────────────────────────
  // buildCcStepForCycle
  // Builds one CC step at a given sequence / test date.
  // RULE: cc_strike >= assignment_strike (always assignment_strike in V2).
  // ─────────────────────────────────────────────
  async function buildCcStepForCycle({
    cycle,
    sourceRecord,
    sequenceNumber = 1,
    testDate,
    ccExpiration = null,
    dte = null,
    options = {},
  }) {
    const defaultCcDte       = options.defaultCcDte       ?? 7;
    const riskFreeRate       = options.riskFreeRate       ?? 0.045;
    const dividendYield      = options.dividendYield      ?? 0;
    const conservativeFactor = options.conservativeFactor ?? 0.8;
    const officialPriceRule =
      options.officialPriceRule === "close" || options.officialPriceRule === "midpoint"
        ? options.officialPriceRule
        : "open";

    const assignment_strike = Number(cycle.assignment_strike);
    const cc_strike = assignment_strike;

    const test_date = normalizeDateToYmd(testDate);
    if (!test_date) {
      return { step: null, pricing: null, error: "invalid_test_date" };
    }

    const weeklyExp = ccExpiration && dte != null
      ? { cc_expiration: ccExpiration, dte }
      : getWeeklyCcExpirationFromTestDate(test_date);
    const cc_expiration = weeklyExp.cc_expiration ?? getCcExpirationFromTestDate(test_date, defaultCcDte);
    const stepDte = weeklyExp.dte ?? defaultCcDte;

    const spotInfo = await selectFirstCcSpot({ cycle, sourceRecord, testDate: test_date, options });
    if (!spotInfo) {
      return { step: null, pricing: null, error: "no_valid_spot" };
    }
    const spot = spotInfo.spot;
    const target_time = spotInfo.priceRule;

    const hv30         = sourceRecord?.hv30_at_scan          != null ? Number(sourceRecord.hv30_at_scan)          : null;
    const atmIv        = sourceRecord?.atm_iv_at_scan         != null ? Number(sourceRecord.atm_iv_at_scan)         : null;
    const safeStrikeIv = sourceRecord?.safe_strike_iv_at_scan != null ? Number(sourceRecord.safe_strike_iv_at_scan) : null;

    const pricing = estimateCoveredCallPremium({
      spot,
      assignmentStrike: assignment_strike,
      ccStrike:         cc_strike,
      dte:              stepDte,
      hv30,
      atmIv,
      safeStrikeIv,
      riskFreeRate,
      dividendYield,
      conservativeFactor,
    });

    const stepSource = sequenceNumber === 1 ? "black_scholes_first_cc_step" : "black_scholes_multi_cc_step";

    const baseStep = {
      id:                   `theoretical_cc_step_${cycle.id}_${sequenceNumber}`,
      theoretical_cycle_id: cycle.id,
      candidate_record_id:  cycle.candidate_record_id,
      ticker:               cycle.ticker,
      sequence_number:      sequenceNumber,
      test_date,
      target_time,
      cc_expiration,
      dte:                  stepDte,
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
      assignmentDate: cycle.assignment_date,
      testDate: test_date,
      testDateRule: sequenceNumber === 1 ? getFirstCcTestDateAfterAssignment(cycle.assignment_date).rule : "weekly_next_session",
      priceRule: spotInfo.priceRule,
      priceQuality: spotInfo.priceQuality,
      usedPostAssignmentOhlc: spotInfo.usedPostAssignmentOhlc === true,
      ohlcSource: spotInfo.ohlcSource ?? null,
      ohlcDate: spotInfo.ohlcDate ?? null,
      usedFallback: spotInfo.usedFallback === true,
      officialPriceRule,
      sequenceNumber,
    };

    if (!pricing.ok) {
      return {
        step: {
          ...baseStep,
          premium_mid:               null,
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
            source:         stepSource,
            pricing_source: null,
            error:          pricing.error,
            inputs:         { hv30, atmIv, safeStrikeIv, spot, assignment_strike, cc_strike, dte: stepDte },
            thresholds:     null,
            sourceRecordId: cycle.candidate_record_id,
            ...rawExtra,
          },
        },
        pricing,
        error: pricing.error,
      };
    }

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
        premium_mid:               pricing.premiumEstimated,
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
          source:            stepSource,
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
  // buildFirstCcStepForCycle
  // Wrapper — first CC step after assignment (sequence 1).
  // ─────────────────────────────────────────────
  async function buildFirstCcStepForCycle({ cycle, sourceRecord, options = {} }) {
    const testDateInfo = getFirstCcTestDateAfterAssignment(cycle.assignment_date);
    return buildCcStepForCycle({
      cycle,
      sourceRecord,
      sequenceNumber: 1,
      testDate: testDateInfo.testDate,
      options,
    });
  }

  // ─────────────────────────────────────────────
  // simulateMultiCcStepsForCycle
  // POP V2-Phase2 — weekly CC attempts after CSP assignment.
  // Does NOT handle called away / cycle closure.
  // ─────────────────────────────────────────────
  async function simulateMultiCcStepsForCycle({ cycle, sourceRecord, options = {} }) {
    const maxWeeks = options.maxWeeks ?? 12;
    const endDateYmd = normalizeDateToYmd(options.endDateYmd) ?? new Date().toISOString().slice(0, 10);
    const assignmentYmd = normalizeDateToYmd(cycle.assignment_date);

    if (!assignmentYmd) {
      return { steps: [], error: "invalid_assignment_date" };
    }

    const steps = [];
    const firstAfterRecoveryMarkedRef = { value: false };
    let testDateInfo = getFirstCcTestDateAfterAssignment(assignmentYmd);
    let test_date = testDateInfo.testDate;
    let sequence_number = 1;

    while (sequence_number <= maxWeeks) {
      if (test_date > endDateYmd) break;

      const weeklyExp = getWeeklyCcExpirationFromTestDate(test_date);
      const result = await buildCcStepForCycle({
        cycle,
        sourceRecord,
        sequenceNumber: sequence_number,
        testDate: test_date,
        ccExpiration: weeklyExp.cc_expiration,
        dte: weeklyExp.dte,
        options,
      });

      if (!result.step) break;

      const recoveryFlags = computeBeforeRecoveryFlagsForStep({
        testDate: test_date,
        assignmentRecoveryDate: cycle.assignment_recovery_date,
        assignmentRecovered: cycle.assignment_recovered,
        firstAfterRecoveryMarkedRef,
      });

      steps.push({
        ...result.step,
        days_after_assignment: computeCalendarDaysBetween(assignmentYmd, test_date),
        before_recovery_flag: recoveryFlags.before_recovery_flag,
        assignment_recovered_at_step_flag: recoveryFlags.assignment_recovered_at_step_flag,
        premium_mid: result.step.premium_estimated ?? result.step.premium_mid ?? null,
      });

      const dayAfterExp = addCalendarDaysToYmd(weeklyExp.cc_expiration, 1);
      if (!dayAfterExp) break;
      const nextSession = getNextMarketSessionAfter(dayAfterExp);
      test_date = nextSession.testDate;
      sequence_number += 1;
    }

    return { steps, error: null };
  }

  // ─────────────────────────────────────────────
  // refreshMultiCcStepsForCycles
  // POP V2-Phase2 — backfill multi-week CC simulation for assigned cycles.
  // ─────────────────────────────────────────────
  async function refreshMultiCcStepsForCycles({
    dryRun             = false,
    limit              = null,
    forceRefresh       = false,
    onlyMissing        = true,
    maxWeeks           = 12,
    endDateYmd         = null,
    defaultCcDte       = 7,
    conservativeFactor = 0.8,
    riskFreeRate       = 0.045,
    dividendYield      = 0,
    usePostAssignmentOhlc = true,
    officialPriceRule = "open",
  } = {}) {
    await cycleStore.ensureInitialized();

    const endYmd = normalizeDateToYmd(endDateYmd) ?? new Date().toISOString().slice(0, 10);
    const db = new DatabaseSync(sqlitePath);

    let cycles = await cycleStore.listCycles(limit != null ? Number(limit) : 999999);
    cycles = cycles.filter((c) => c.assignment_date && c.assignment_strike != null && c.ticker);

    if (onlyMissing && !forceRefresh) {
      cycles = cycles.filter((c) => !c.multi_cc_backfilled_at);
    }

    const options = {
      maxWeeks,
      endDateYmd: endYmd,
      defaultCcDte,
      conservativeFactor,
      riskFreeRate,
      dividendYield,
      usePostAssignmentOhlc,
      officialPriceRule,
    };

    let cycles_scanned = cycles.length;
    let cycles_eligible = 0;
    let cycles_updated = 0;
    let cc_steps_created = 0;
    let cc_sold = 0;
    let cc_not_sold = 0;
    let total_premium_simulated = 0;
    let weeks_without_cc_total = 0;
    let cc_premiums_before_recovery_total = 0;
    let cc_count_before_recovery_total = 0;
    let weeks_without_cc_before_recovery_total = 0;
    const errors = [];
    const sample_cycles = [];

    for (const cycle of cycles) {
      cycles_eligible++;

      const sourceRow = db
        .prepare("SELECT * FROM wheel_validation_records WHERE id = @id")
        .get({ id: String(cycle.candidate_record_id) });

      if (!sourceRow) {
        errors.push({ cycle_id: cycle.id, error: "missing_source_record" });
        continue;
      }

      try {
        if (!dryRun && cycleStore.deleteCcStepsForCycle) {
          await cycleStore.deleteCcStepsForCycle(cycle.id);
        }

        const simulation = await simulateMultiCcStepsForCycle({
          cycle,
          sourceRecord: sourceRow,
          options,
        });

        if (simulation.error) {
          errors.push({ cycle_id: cycle.id, error: simulation.error });
          continue;
        }

        const steps = simulation.steps ?? [];
        cc_steps_created += steps.length;

        for (const step of steps) {
          if (step.cc_sold_theoretical === 1) {
            cc_sold++;
            const p = step.premium_conservative != null ? Number(step.premium_conservative) : 0;
            if (Number.isFinite(p)) total_premium_simulated += p;
          } else {
            cc_not_sold++;
          }
        }

        const summary = summarizeCycleFromCcSteps({ cycle, ccSteps: steps });
        weeks_without_cc_total += summary.weeks_without_cc ?? 0;
        cc_premiums_before_recovery_total += summary.cc_premiums_before_recovery ?? 0;
        cc_count_before_recovery_total += summary.cc_count_before_recovery ?? 0;
        weeks_without_cc_before_recovery_total += summary.weeks_without_cc_before_recovery ?? 0;

        if (sample_cycles.length < 8) {
          sample_cycles.push({
            ticker: cycle.ticker,
            assignment_date: cycle.assignment_date,
            assignment_strike: cycle.assignment_strike,
            cc_steps_count: summary.cc_steps_count,
            cc_sold_count: summary.cc_sold_count,
            weeks_without_cc: summary.weeks_without_cc,
            total_cc_premium_conservative: summary.total_cc_premium_conservative,
            cc_premiums_before_recovery: summary.cc_premiums_before_recovery,
            reduced_cost_basis_estimated: summary.reduced_cost_basis_estimated,
            latest_cc_test_date: summary.latest_cc_test_date,
          });
        }

        if (!dryRun) {
          for (const step of steps) {
            await cycleStore.upsertCcStep(step);
          }
          await cycleStore.upsertCycle({
            ...cycle,
            ...summary,
            multi_cc_backfilled_at: new Date().toISOString(),
          });
          cycles_updated++;
        }
      } catch (err) {
        errors.push({ cycle_id: cycle.id, error: String(err?.message ?? err) });
      }
    }

    return {
      ok: true,
      dryRun,
      endDateYmd: endYmd,
      maxWeeks,
      cycles_scanned,
      cycles_eligible,
      cycles_updated,
      cc_steps_created,
      cc_sold,
      cc_not_sold,
      total_premium_simulated,
      weeks_without_cc: weeks_without_cc_total,
      cc_premiums_before_recovery: cc_premiums_before_recovery_total,
      cc_count_before_recovery: cc_count_before_recovery_total,
      weeks_without_cc_before_recovery: weeks_without_cc_before_recovery_total,
      errors,
      sample_cycles,
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
    usePostAssignmentOhlc = true,
    officialPriceRule = "open",
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

    const options = {
      defaultCcDte,
      conservativeFactor,
      riskFreeRate,
      dividendYield,
      usePostAssignmentOhlc,
      officialPriceRule,
    };

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

      const result = await buildFirstCcStepForCycle({ cycle, sourceRecord: sourceRow, options });

      if (!result.step) {
        skipped_pricing_unavailable++;
        continue;
      }

      steps_built++;
      if (result.step.cc_sold_theoretical === 1) cc_sold_theoretical_count++;
      else cc_wait_count++;

      if (sample_steps.length < 10) {
        const raw = result.step.raw ?? {};
        sample_steps.push({
          ticker:                    result.step.ticker,
          assignment_date:           cycle.assignment_date,
          test_date:                 result.step.test_date,
          priceRule:                 raw.priceRule ?? null,
          priceQuality:              raw.priceQuality ?? null,
          stock_open:                result.step.stock_open,
          stock_close:               result.step.stock_close,
          stock_price_used:          result.step.stock_price_used,
          assignment_strike:         result.step.assignment_strike,
          cc_strike:                 result.step.cc_strike,
          premium_conservative:      result.step.premium_conservative,
          cc_yield_conservative_pct: result.step.cc_yield_conservative_pct,
          best_threshold_reached:    result.step.best_threshold_reached,
          cc_sold_theoretical:       result.step.cc_sold_theoretical,
          not_sold_reason:           result.step.not_sold_reason,
          usedPostAssignmentOhlc:    raw.usedPostAssignmentOhlc ?? null,
          usedFallback:              raw.usedFallback ?? null,
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
    const cc_steps_count = ccSteps.length;
    const cc_sold_count = soldSteps.length;
    const cc_not_sold_count = waitSteps.length;
    const weeks_without_cc = waitSteps.length;

    const beforeRecoverySold = soldSteps.filter((s) => Number(s.before_recovery_flag) === 1);
    const beforeRecoveryWait = waitSteps.filter((s) => Number(s.before_recovery_flag) === 1);

    const cc_premiums_before_recovery = beforeRecoverySold.reduce((sum, s) => {
      let p = null;
      if (s.premium_conservative != null) p = Number(s.premium_conservative);
      else if (s.premium_estimated != null) p = Number(s.premium_estimated);
      else if (s.bs_call_premium != null) p = Number(s.bs_call_premium);
      return sum + (p != null && Number.isFinite(p) ? p : 0);
    }, 0);

    const cc_count_before_recovery = beforeRecoverySold.length;
    const weeks_without_cc_before_recovery = beforeRecoveryWait.length;

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

    const initial_net_cost_basis =
      cspPremium != null && Number.isFinite(assignmentStrike)
        ? assignmentStrike - cspPremium
        : null;

    const reduced_cost_basis_estimated =
      cspPremium != null && Number.isFinite(assignmentStrike)
        ? assignmentStrike - cspPremium - total_cc_premium_conservative
        : null;

    const latest_cc_test_date =
      ccSteps.length > 0 ? ccSteps[ccSteps.length - 1].test_date ?? null : null;

    const hasCalled = ccSteps.some((s) => s.called_away_theoretical === 1);
    const status = hasCalled ? "closed_theoretical" : "open";

    const source_prime_method =
      ccSteps.length > 1 ? "black_scholes_multi_cc_step" : "black_scholes_first_cc_step";

    return {
      total_cc_premium_estimated,
      total_cc_premium_conservative,
      total_premium_estimated,
      initial_net_cost_basis,
      reduced_cost_basis_estimated,
      cc_sellable_steps_count,
      cc_wait_steps_count,
      cc_steps_count,
      cc_sold_count,
      cc_not_sold_count,
      weeks_without_cc,
      cc_premiums_before_recovery,
      cc_count_before_recovery,
      weeks_without_cc_before_recovery,
      best_cc_threshold_reached,
      current_step,
      latest_cc_test_date,
      status,
      data_quality: cycle.data_quality ?? "estimated_black_scholes",
      source_prime_method,
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

  // ─────────────────────────────────────────────
  // normalizeDateToYmd
  // Pure — normalizes YYYY-MM-DD or YYYYMMDD to YYYY-MM-DD.
  // ─────────────────────────────────────────────
  function normalizeDateToYmd(value) {
    if (value == null || value === "") return null;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const compact = raw.replace(/-/g, "");
    if (/^\d{8}$/.test(compact)) {
      return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return null;
  }

  // ─────────────────────────────────────────────
  // computeAssignmentRecoveryMetrics
  // Pure — scans daily candles AFTER assignment_date for return to assignment_strike.
  // Recovery principal: first close >= assignment_strike.
  // Touch optionnel: first high >= assignment_strike.
  // ─────────────────────────────────────────────
  function computeAssignmentRecoveryMetrics({
    assignmentDate,
    assignmentStrike,
    candles = [],
    endDateYmd = null,
  } = {}) {
    const strike = Number(assignmentStrike);
    const assignYmd = normalizeDateToYmd(assignmentDate);
    const endYmd = normalizeDateToYmd(endDateYmd) ?? new Date().toISOString().slice(0, 10);

    if (!Number.isFinite(strike) || !assignYmd) {
      return {
        days_to_strike_touch: null,
        days_to_strike_close_above: null,
        days_below_assignment_strike: null,
        assignment_recovery_date: null,
        assignment_recovered: null,
        data_quality: "recovery_inputs_invalid",
      };
    }

    const sorted = (Array.isArray(candles) ? candles : [])
      .filter((c) => c?.date && c.date > assignYmd && c.date <= endYmd)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    if (sorted.length === 0) {
      return {
        days_to_strike_touch: null,
        days_to_strike_close_above: null,
        days_below_assignment_strike: null,
        assignment_recovery_date: null,
        assignment_recovered: null,
        data_quality: "recovery_no_post_assignment_candles",
      };
    }

    let tradingDayIndex = 0;
    let days_to_strike_touch = null;
    let days_to_strike_close_above = null;
    let days_below_assignment_strike = 0;
    let assignment_recovery_date = null;

    for (const candle of sorted) {
      tradingDayIndex += 1;
      const close = Number(candle.close);
      const high = Number(candle.high);
      const closeAbove = Number.isFinite(close) && close >= strike;
      const highTouch = Number.isFinite(high) && high >= strike;

      if (days_to_strike_touch == null && highTouch) {
        days_to_strike_touch = tradingDayIndex;
      }

      if (closeAbove) {
        days_to_strike_close_above = tradingDayIndex;
        assignment_recovery_date = candle.date;
        break;
      }

      if (Number.isFinite(close) && close < strike) {
        days_below_assignment_strike += 1;
      }
    }

    return {
      days_to_strike_touch,
      days_to_strike_close_above,
      days_below_assignment_strike,
      assignment_recovery_date,
      assignment_recovered: assignment_recovery_date ? 1 : 0,
      data_quality: "recovery_computed",
    };
  }

  // ─────────────────────────────────────────────
  // refreshAssignmentRecoveryForCycles
  // POP V2-Phase1: fetches post-assignment daily OHLC and stores recovery metrics.
  // Does NOT modify CC steps or wheel_validation_records.
  // ─────────────────────────────────────────────
  async function refreshAssignmentRecoveryForCycles({
    dryRun = false,
    limit = null,
    endDateYmd = null,
    forceRefresh = false,
    onlyMissing = true,
  } = {}) {
    await cycleStore.ensureInitialized();

    const endYmd = normalizeDateToYmd(endDateYmd) ?? new Date().toISOString().slice(0, 10);
    let cycles = await cycleStore.listCycles(limit != null ? Number(limit) : 999999);

    if (onlyMissing && !forceRefresh) {
      cycles = cycles.filter(
        (c) => c.assignment_recovered == null && c.days_to_strike_close_above == null
      );
    }

    let cycles_scanned = cycles.length;
    let cycles_eligible = 0;
    let cycles_updated = 0;
    let cycles_recovered = 0;
    let cycles_not_recovered = 0;
    let cycles_no_ohlc = 0;
    const errors = [];
    const sample_cycles = [];

    for (const cycle of cycles) {
      if (!cycle?.assignment_date || cycle?.assignment_strike == null || !cycle?.ticker) {
        continue;
      }
      cycles_eligible++;

      const assignYmd = normalizeDateToYmd(cycle.assignment_date);
      if (!assignYmd) {
        errors.push({ cycle_id: cycle.id, error: "invalid_assignment_date" });
        continue;
      }

      let candles = [];
      if (effectiveMarketService?.getDailyOhlcRange) {
        const range = await effectiveMarketService.getDailyOhlcRange(cycle.ticker, assignYmd, endYmd);
        if (range?.ok && Array.isArray(range.candles)) {
          candles = range.candles;
        }
      }

      if (candles.length === 0) {
        cycles_no_ohlc++;
      }

      const recovery = computeAssignmentRecoveryMetrics({
        assignmentDate: assignYmd,
        assignmentStrike: cycle.assignment_strike,
        candles,
        endDateYmd: endYmd,
      });

      if (recovery.assignment_recovered === 1) cycles_recovered++;
      else if (recovery.assignment_recovered === 0) cycles_not_recovered++;

      if (sample_cycles.length < 8) {
        sample_cycles.push({
          ticker: cycle.ticker,
          assignment_date: assignYmd,
          assignment_strike: cycle.assignment_strike,
          assignment_recovery_date: recovery.assignment_recovery_date,
          days_to_strike_close_above: recovery.days_to_strike_close_above,
          days_to_strike_touch: recovery.days_to_strike_touch,
          days_below_assignment_strike: recovery.days_below_assignment_strike,
          assignment_recovered: recovery.assignment_recovered,
          candle_count: candles.length,
        });
      }

      if (!dryRun) {
        try {
          await cycleStore.upsertCycle({
            ...cycle,
            ...recovery,
          });
          cycles_updated++;
        } catch (err) {
          errors.push({ cycle_id: cycle.id, error: String(err?.message ?? err) });
        }
      }
    }

    return {
      ok: true,
      dryRun,
      endDateYmd: endYmd,
      cycles_scanned,
      cycles_eligible,
      cycles_updated,
      cycles_recovered,
      cycles_not_recovered,
      cycles_no_ohlc,
      errors,
      sample_cycles,
    };
  }

  // ─────────────────────────────────────────────
  // fetchCcExpirationOhlcCandles
  // Phase 3 only — daily OHLC for CC expiration eval (US market calendar dates).
  // Requests one extra calendar day then filters to endYmd (never uses dates after expiration).
  // ─────────────────────────────────────────────
  async function fetchCcExpirationOhlcCandles(ticker, startYmd, endYmd) {
    const effectiveEnd = normalizeDateToYmd(endYmd);
    const rangeStart = normalizeDateToYmd(startYmd);
    if (!ticker || !rangeStart || !effectiveEnd) return [];

    const fetchEnd = addCalendarDaysToYmd(effectiveEnd, 1) ?? effectiveEnd;
    if (!effectiveMarketService?.getDailyOhlcRange) return [];

    const range = await effectiveMarketService.getDailyOhlcRange(
      ticker,
      rangeStart,
      fetchEnd,
      { usMarketDates: true }
    );
    if (!range?.ok || !Array.isArray(range.candles)) return [];

    return range.candles.filter((c) => {
      const ymd = normalizeDateToYmd(c?.date);
      return ymd && ymd <= effectiveEnd && Number.isFinite(Number(c?.close));
    });
  }

  // ─────────────────────────────────────────────
  // resolveExpirationClosePrice
  // Pure — close at CC expiration (exact day or previous market day fallback).
  // Never uses a price date after cc_expiration.
  // ─────────────────────────────────────────────
  function resolveExpirationClosePrice({ ccExpirationYmd, candles = [], todayYmd = null } = {}) {
    const expYmd = normalizeDateToYmd(ccExpirationYmd);
    const today = normalizeDateToYmd(todayYmd) ?? new Date().toISOString().slice(0, 10);

    if (!expYmd) {
      return { close: null, priceDate: null, source: "missing", pending: false };
    }

    if (expYmd > today) {
      return { close: null, priceDate: null, source: "pending", pending: true };
    }

    const sorted = (Array.isArray(candles) ? candles : [])
      .map((c) => ({
        ...c,
        date: normalizeDateToYmd(c?.date),
        close: Number(c?.close),
      }))
      .filter((c) => c.date && c.date <= expYmd && Number.isFinite(c.close))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const exact = sorted.find((c) => c.date === expYmd);
    if (exact) {
      return {
        close: Number(exact.close),
        priceDate: expYmd,
        source: "expiration_daily_close",
        pending: false,
      };
    }

    const lookbackStart = addCalendarDaysToYmd(expYmd, -5);
    const candidates = sorted.filter((c) => c.date <= expYmd && (!lookbackStart || c.date >= lookbackStart));
    if (candidates.length > 0) {
      const last = candidates[candidates.length - 1];
      return {
        close: Number(last.close),
        priceDate: last.date,
        source: "previous_market_close_fallback",
        pending: false,
      };
    }

    return { close: null, priceDate: null, source: "missing", pending: false };
  }

  // ─────────────────────────────────────────────
  // computeCcStepExpirationOutcome
  // Pure — evaluates one CC step at expiration (sold steps only get price test).
  // ─────────────────────────────────────────────
  function computeCcStepExpirationOutcome({ step, priceResolution, todayYmd = null } = {}) {
    const ccStrike = Number(step?.cc_strike);
    const assignmentStrike = Number(step?.assignment_strike ?? step?.assignmentStrike);

    if (step?.cc_sold_theoretical !== 1) {
      return {
        expiration_close: null,
        expiration_price_source: null,
        called_away_theoretical: 0,
        expired_otm: 0,
        result_at_expiration: "not_sold",
      };
    }

    const expYmd = normalizeDateToYmd(step?.cc_expiration);
    const today = normalizeDateToYmd(todayYmd) ?? new Date().toISOString().slice(0, 10);

    if (!expYmd) {
      return {
        expiration_close: null,
        expiration_price_source: "missing",
        called_away_theoretical: 0,
        expired_otm: 0,
        result_at_expiration: "missing_expiration_price",
      };
    }

    if (expYmd > today) {
      return {
        expiration_close: null,
        expiration_price_source: "pending",
        called_away_theoretical: 0,
        expired_otm: 0,
        result_at_expiration: "pending_expiration",
      };
    }

    const price = priceResolution ?? { close: null, source: "missing", pending: false };
    if (price.pending || price.close == null || !Number.isFinite(Number(price.close))) {
      return {
        expiration_close: null,
        expiration_price_source: price.source ?? "missing",
        called_away_theoretical: 0,
        expired_otm: 0,
        result_at_expiration: "missing_expiration_price",
      };
    }

    const expirationClose = Number(price.close);
    const calledAway = Number.isFinite(ccStrike) && expirationClose >= ccStrike;

    // Safety: never mark called away if cc_strike is below assignment_strike
    if (calledAway && Number.isFinite(assignmentStrike) && ccStrike < assignmentStrike) {
      return {
        expiration_close: expirationClose,
        expiration_price_source: price.source ?? "missing",
        called_away_theoretical: 0,
        expired_otm: 1,
        result_at_expiration: "expired_otm",
      };
    }

    if (calledAway) {
      return {
        expiration_close: expirationClose,
        expiration_price_source: price.source ?? "expiration_daily_close",
        called_away_theoretical: 1,
        expired_otm: 0,
        result_at_expiration: "called_away",
      };
    }

    return {
      expiration_close: expirationClose,
      expiration_price_source: price.source ?? "expiration_daily_close",
      called_away_theoretical: 0,
      expired_otm: 1,
      result_at_expiration: "expired_otm",
    };
  }

  // ─────────────────────────────────────────────
  // sumSoldCcPremiumConservative
  // Pure — sum conservative premium from sold CC steps.
  // ─────────────────────────────────────────────
  function sumSoldCcPremiumConservative(ccSteps) {
    const soldSteps = (Array.isArray(ccSteps) ? ccSteps : []).filter((s) => s.cc_sold_theoretical === 1);
    return soldSteps.reduce((sum, s) => {
      let p = null;
      if (s.premium_conservative != null) p = Number(s.premium_conservative);
      else if (s.premium_estimated != null) p = Number(s.premium_estimated);
      else if (s.bs_call_premium != null) p = Number(s.bs_call_premium);
      return sum + (p != null && Number.isFinite(p) ? p : 0);
    }, 0);
  }

  // ─────────────────────────────────────────────
  // computeFinalExitForCycle
  // Pure — walks CC steps in sequence, detects called away, computes cycle P/L.
  // Does NOT fetch market data.
  // ─────────────────────────────────────────────
  function computeFinalExitForCycle({ cycle, ccSteps, candles = [], todayYmd = null } = {}) {
    const today = normalizeDateToYmd(todayYmd) ?? new Date().toISOString().slice(0, 10);
    const sortedSteps = [...(Array.isArray(ccSteps) ? ccSteps : [])].sort(
      (a, b) => (Number(a.sequence_number) || 0) - (Number(b.sequence_number) || 0)
    );

    const assignmentStrike = Number(cycle?.assignment_strike);
    const cspPremium = cycle?.csp_premium != null ? Number(cycle.csp_premium) : 0;
    const assignmentYmd = normalizeDateToYmd(cycle?.assignment_date);
    const cycleStartYmd = normalizeDateToYmd(cycle?.scan_date) ?? assignmentYmd;

    let called_away_count = 0;
    let expired_otm_count = 0;
    let pending_expiration_count = 0;
    let missing_expiration_price_count = 0;
    let last_evaluated_cc_expiration = null;

    const evaluatedSteps = [];
    let finalExitStep = null;
    let finalExitOutcome = null;

    for (const step of sortedSteps) {
      const expYmd = normalizeDateToYmd(step?.cc_expiration);
      if (expYmd) last_evaluated_cc_expiration = expYmd;

      let priceResolution = null;
      if (step.cc_sold_theoretical === 1 && expYmd) {
        priceResolution = resolveExpirationClosePrice({ ccExpirationYmd: expYmd, candles, todayYmd: today });
      }

      const outcome = computeCcStepExpirationOutcome({ step, priceResolution, todayYmd: today });
      evaluatedSteps.push({ step, outcome });

      if (outcome.result_at_expiration === "called_away") {
        called_away_count += 1;
        if (!finalExitStep) {
          finalExitStep = step;
          finalExitOutcome = outcome;
        }
        break;
      }

      if (outcome.result_at_expiration === "expired_otm") expired_otm_count += 1;
      if (outcome.result_at_expiration === "pending_expiration") pending_expiration_count += 1;
      if (outcome.result_at_expiration === "missing_expiration_price") missing_expiration_price_count += 1;
    }

    const soldStepsForPremium = sortedSteps.filter((s) => {
      const ev = evaluatedSteps.find((e) => e.step.id === s.id || e.step.sequence_number === s.sequence_number);
      if (finalExitStep && Number(s.sequence_number) > Number(finalExitStep.sequence_number)) return false;
      return s.cc_sold_theoretical === 1;
    });
    const total_cc_premium_conservative = sumSoldCcPremiumConservative(soldStepsForPremium);

    const initial_net_cost_basis =
      Number.isFinite(assignmentStrike) && Number.isFinite(cspPremium)
        ? assignmentStrike - cspPremium
        : cycle?.initial_net_cost_basis != null
          ? Number(cycle.initial_net_cost_basis)
          : null;

    const reduced_cost_basis_estimated =
      Number.isFinite(assignmentStrike)
        ? assignmentStrike - cspPremium - total_cc_premium_conservative
        : null;

    const isClosed = finalExitStep != null && finalExitOutcome?.result_at_expiration === "called_away";
    const final_exit_price = isClosed ? Number(finalExitStep.cc_strike) : null;
    const final_exit_date = isClosed ? normalizeDateToYmd(finalExitStep.cc_expiration) : null;

    // Safety guard: never exit below assignment_strike
    const safeFinalExitPrice =
      isClosed && Number.isFinite(final_exit_price) && Number.isFinite(assignmentStrike) && final_exit_price < assignmentStrike
        ? null
        : final_exit_price;

    const actuallyClosed = isClosed && safeFinalExitPrice != null;

    let gross_stock_pnl_per_share = null;
    let premium_pnl_per_share = null;
    let total_pnl_per_share = null;
    let total_pnl_contract = null;
    let return_on_assignment_pct = null;
    let return_on_net_cost_pct = null;
    let days_in_cycle = null;
    let days_after_assignment_to_exit = null;
    let annualized_return_after_assignment_pct = null;

    if (actuallyClosed) {
      gross_stock_pnl_per_share = safeFinalExitPrice - assignmentStrike;
      premium_pnl_per_share = cspPremium + total_cc_premium_conservative;
      total_pnl_per_share = gross_stock_pnl_per_share + premium_pnl_per_share;
      total_pnl_contract = total_pnl_per_share * 100;

      if (Number.isFinite(assignmentStrike) && assignmentStrike !== 0) {
        return_on_assignment_pct = (total_pnl_per_share / assignmentStrike) * 100;
      }
      if (initial_net_cost_basis != null && Number.isFinite(initial_net_cost_basis) && initial_net_cost_basis !== 0) {
        return_on_net_cost_pct = (total_pnl_per_share / initial_net_cost_basis) * 100;
      }

      if (cycleStartYmd && final_exit_date) {
        days_in_cycle = computeCalendarDaysBetween(cycleStartYmd, final_exit_date);
      }
      if (assignmentYmd && final_exit_date) {
        days_after_assignment_to_exit = computeCalendarDaysBetween(assignmentYmd, final_exit_date);
        if (
          days_after_assignment_to_exit != null &&
          days_after_assignment_to_exit > 0 &&
          return_on_assignment_pct != null
        ) {
          annualized_return_after_assignment_pct =
            (return_on_assignment_pct / days_after_assignment_to_exit) * 365;
        }
      }
    }

    return {
      evaluatedSteps,
      cycle_status: actuallyClosed ? "closed" : "open",
      status: actuallyClosed ? "closed_theoretical" : "open",
      close_reason: actuallyClosed ? "cc_called_away" : pending_expiration_count > 0 ? null : "still_holding",
      final_exit_date: actuallyClosed ? final_exit_date : null,
      final_exit_price: actuallyClosed ? safeFinalExitPrice : null,
      final_exit_step_id: actuallyClosed ? finalExitStep.id : null,
      final_exit_sequence_number: actuallyClosed ? Number(finalExitStep.sequence_number) : null,
      called_away_count,
      expired_otm_count,
      last_evaluated_cc_expiration,
      total_cc_premium_conservative,
      reduced_cost_basis_estimated,
      initial_net_cost_basis,
      gross_stock_pnl_per_share,
      premium_pnl_per_share,
      total_pnl_per_share,
      total_pnl_contract,
      return_on_assignment_pct,
      return_on_net_cost_pct,
      days_in_cycle,
      days_after_assignment_to_exit,
      annualized_return_after_assignment_pct,
      pending_expiration_count,
      missing_expiration_price_count,
    };
  }

  // ─────────────────────────────────────────────
  // refreshFinalExitForWheelCycles
  // POP V2 Phase 3: evaluates CC expiration outcomes, called away, cycle P/L.
  // Does NOT modify CSP selection, multi-CC generation, or recovery logic.
  // ─────────────────────────────────────────────
  async function refreshFinalExitForWheelCycles({
    cycles: inputCycles = null,
    dryRun = false,
    limit = null,
    endDateYmd = null,
    forceRefresh = false,
    onlyMissing = true,
  } = {}) {
    await cycleStore.ensureInitialized();

    const todayYmd = normalizeDateToYmd(endDateYmd) ?? new Date().toISOString().slice(0, 10);
    let cycles = inputCycles ?? (await cycleStore.listCycles(limit != null ? Number(limit) : 999999));

    if (onlyMissing && !forceRefresh) {
      cycles = cycles.filter((c) => !c.final_exit_backfilled_at);
    }

    let cycles_scanned = cycles.length;
    let cycles_eligible = 0;
    let cycles_updated = 0;
    let cycles_closed = 0;
    let cycles_still_open = 0;
    let cc_steps_evaluated = 0;
    let called_away_total = 0;
    let expired_otm_total = 0;
    let pending_expirations = 0;
    let missing_expiration_price = 0;
    let total_pnl_contract_sum = 0;
    let return_on_assignment_sum = 0;
    let return_on_assignment_count = 0;
    let days_after_assignment_sum = 0;
    let days_after_assignment_count = 0;
    let final_exit_below_assignment_strike = 0;
    const errors = [];
    const sample_cycles = [];

    for (const cycle of cycles) {
      if (!cycle?.id || !cycle?.ticker) continue;

      try {
        const ccSteps = await cycleStore.listCcSteps(cycle.id);
        if (ccSteps.length === 0) continue;
        cycles_eligible++;

        const expDates = ccSteps
          .map((s) => normalizeDateToYmd(s.cc_expiration))
          .filter(Boolean)
          .sort();
        const minExp = expDates[0] ?? todayYmd;
        const maxExp = expDates[expDates.length - 1] ?? todayYmd;
        const rangeStart = addCalendarDaysToYmd(minExp, -5) ?? minExp;
        const effectiveEnd = maxExp > todayYmd ? todayYmd : maxExp;

        const candles = await fetchCcExpirationOhlcCandles(cycle.ticker, rangeStart, effectiveEnd);

        const result = computeFinalExitForCycle({ cycle, ccSteps, candles, todayYmd });
        cc_steps_evaluated += result.evaluatedSteps.length;

        for (const { outcome } of result.evaluatedSteps) {
          if (outcome.result_at_expiration === "called_away") called_away_total += 1;
          if (outcome.result_at_expiration === "expired_otm") expired_otm_total += 1;
          if (outcome.result_at_expiration === "pending_expiration") pending_expirations += 1;
          if (outcome.result_at_expiration === "missing_expiration_price") missing_expiration_price += 1;
        }

        if (result.cycle_status === "closed") {
          cycles_closed += 1;
          if (result.total_pnl_contract != null) total_pnl_contract_sum += result.total_pnl_contract;
          if (result.return_on_assignment_pct != null) {
            return_on_assignment_sum += result.return_on_assignment_pct;
            return_on_assignment_count += 1;
          }
          if (result.days_after_assignment_to_exit != null) {
            days_after_assignment_sum += result.days_after_assignment_to_exit;
            days_after_assignment_count += 1;
          }
          if (
            result.final_exit_price != null &&
            Number.isFinite(Number(cycle.assignment_strike)) &&
            result.final_exit_price < Number(cycle.assignment_strike)
          ) {
            final_exit_below_assignment_strike += 1;
          }
        } else {
          cycles_still_open += 1;
        }

        if (sample_cycles.length < 8) {
          sample_cycles.push({
            ticker: cycle.ticker,
            cycle_status: result.cycle_status,
            close_reason: result.close_reason,
            final_exit_date: result.final_exit_date,
            final_exit_price: result.final_exit_price,
            final_exit_sequence_number: result.final_exit_sequence_number,
            total_pnl_contract: result.total_pnl_contract,
            return_on_assignment_pct: result.return_on_assignment_pct,
            called_away_count: result.called_away_count,
            expired_otm_count: result.expired_otm_count,
          });
        }

        if (!dryRun) {
          const nowIso = new Date().toISOString();
          for (const { step, outcome } of result.evaluatedSteps) {
            await cycleStore.upsertCcStep({
              ...step,
              expiration_close: outcome.expiration_close,
              expiration_price_source: outcome.expiration_price_source,
              called_away_theoretical: outcome.called_away_theoretical,
              expired_otm: outcome.expired_otm,
              result_at_expiration: outcome.result_at_expiration,
            });
          }

          await cycleStore.upsertCycle({
            ...cycle,
            cycle_status: result.cycle_status,
            status: result.status,
            close_reason: result.close_reason,
            final_exit_date: result.final_exit_date,
            final_exit_price: result.final_exit_price,
            final_exit_step_id: result.final_exit_step_id,
            final_exit_sequence_number: result.final_exit_sequence_number,
            called_away_count: result.called_away_count,
            expired_otm_count: result.expired_otm_count,
            last_evaluated_cc_expiration: result.last_evaluated_cc_expiration,
            total_cc_premium_conservative: result.total_cc_premium_conservative,
            reduced_cost_basis_estimated: result.reduced_cost_basis_estimated,
            initial_net_cost_basis: result.initial_net_cost_basis,
            gross_stock_pnl_per_share: result.gross_stock_pnl_per_share,
            premium_pnl_per_share: result.premium_pnl_per_share,
            total_pnl_per_share: result.total_pnl_per_share,
            total_pnl_contract: result.total_pnl_contract,
            return_on_assignment_pct: result.return_on_assignment_pct,
            return_on_net_cost_pct: result.return_on_net_cost_pct,
            days_in_cycle: result.days_in_cycle,
            days_after_assignment_to_exit: result.days_after_assignment_to_exit,
            annualized_return_after_assignment_pct: result.annualized_return_after_assignment_pct,
            final_exit_backfilled_at: nowIso,
          });
          cycles_updated += 1;
        }
      } catch (err) {
        errors.push({ cycle_id: cycle.id, error: String(err?.message ?? err) });
      }
    }

    return {
      ok: true,
      dryRun,
      todayYmd,
      cycles_total: inputCycles ? inputCycles.length : cycles_scanned,
      cycles_scanned,
      cycles_eligible,
      cycles_updated,
      cycles_closed,
      cycles_still_open,
      cc_steps_evaluated,
      called_away_count: called_away_total,
      expired_otm_count: expired_otm_total,
      pending_expirations,
      missing_expiration_price,
      total_pnl_contract_sum,
      average_return_on_assignment_pct:
        return_on_assignment_count > 0 ? return_on_assignment_sum / return_on_assignment_count : null,
      average_days_after_assignment_to_exit:
        days_after_assignment_count > 0 ? days_after_assignment_sum / days_after_assignment_count : null,
      final_exit_below_assignment_strike,
      errors,
      sample_cycles,
    };
  }

  return {
    buildCycleFromAssignedRecord,
    generateCyclesFromAssignedRecords,
    listTheoreticalCycles,
    getTheoreticalCycleSummary,
    getFirstCcTestDateAfterAssignment,
    getWeeklyCcExpirationFromTestDate,
    getNextMarketSessionAfter,
    computeBeforeRecoveryFlagsForStep,
    computeCalendarDaysBetween,
    buildCcStepForCycle,
    buildFirstCcStepForCycle,
    simulateMultiCcStepsForCycle,
    refreshMultiCcStepsForCycles,
    generateFirstCcStepsForOpenCycles,
    summarizeCycleFromCcSteps,
    updateCycleSummaryFromCcSteps,
    refreshAllCycleSummaries,
    normalizeDateToYmd,
    computeAssignmentRecoveryMetrics,
    refreshAssignmentRecoveryForCycles,
    fetchCcExpirationOhlcCandles,
    resolveExpirationClosePrice,
    computeCcStepExpirationOutcome,
    computeFinalExitForCycle,
    refreshFinalExitForWheelCycles,
  };
}
