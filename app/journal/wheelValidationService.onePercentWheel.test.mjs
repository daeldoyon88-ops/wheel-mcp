import test from "node:test";
import assert from "node:assert/strict";
import {
  createWheelValidationService,
  classifyLowerBoundStressForOnePercentProfile,
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
  isEligibleForExperimentalTop20,
} from "./wheelValidationService.js";

function buildResolvedRecord({
  ticker = "TEST",
  mode = "safe",
  yieldPct = 1,
  assigned = false,
  expiration = "20250110",
  scanDate = "20250101",
  optionQuoteSnapshot = null,
}) {
  const strike = 100;
  const premium = (yieldPct / 100) * strike;
  const record = {
    symbol: ticker,
    strikeMode: mode,
    expiration,
    scanDate,
    captureClass: "primaryDaily",
    strike: { strike, popEstimate: 0.92, bid: premium, ask: premium + 0.02 },
    resolution: {
      resolved: true,
      assigned,
      expiredWorthless: !assigned,
      strikeTouched: false,
      brokeLowerBound: false,
      popPredictionCorrect: !assigned,
      underlying_close_at_expiration: assigned ? strike - 0.5 : strike + 2,
    },
  };
  if (optionQuoteSnapshot) record.optionQuoteSnapshot = optionQuoteSnapshot;
  return record;
}

function buildClosedCycle({ ticker = "TEST", mode = "safe", pnl = 50, returnPct = 2 }) {
  return {
    ticker,
    strike_mode: mode,
    cycle_status: "closed",
    status: "closed_theoretical",
    close_reason: "cc_called_away",
    assignment_recovered: 1,
    cc_sold_count: 2,
    cc_not_sold_count: 0,
    total_cc_premium_conservative: 1.5,
    total_pnl_contract: pnl,
    return_on_assignment_pct: returnPct,
    days_in_cycle: 45,
    first_cc_step: { cc_sold_theoretical: 1, cc_yield_conservative_pct: 1.2 },
  };
}

function buildStoredSnapshotRow({
  ticker,
  source = "IBKR",
  dataConfidence = "observed_ibkr",
  scanTimestamp = "2026-05-25T01:37:02.572Z",
  snapshotOverrides = {},
  rowOverrides = {},
}) {
  const snapshot = {
    source,
    primaryOptionDataSource: source,
    ticker,
    expiration: "20260529",
    strike: 100,
    dteAtScan: 4,
    quote: {
      bid: 1.1,
      ask: 1.2,
      mid: 1.15,
      last: 1.08,
      mark: 1.15,
      spreadAbs: 0.1,
      spreadPct: 0.087,
      quoteTimestamp: scanTimestamp,
      scanTimestamp,
    },
    greeks: {
      impliedVolatility: 0.72,
      delta: -0.24,
      gamma: null,
      theta: null,
      vega: null,
      modelPrice: 1.16,
      modelGreeksTimestamp: scanTimestamp,
    },
    liquidity: {
      volume: 120,
      openInterest: 880,
    },
    contract: {
      conId: 123456,
      localSymbol: `${ticker}  260529P00100000`,
      tradingClass: ticker,
      exchange: "SMART",
      currency: "USD",
      multiplier: "100",
    },
    context: {
      premiumYieldPct: 1.1,
      popEstimate: 0.82,
    },
    dataConfidence,
    missingFields: ["gamma", "theta", "vega"],
    warnings: [],
    optionChain: [{ shouldNotBeExposed: true }],
    ...snapshotOverrides,
  };

  return {
    id: `${ticker}-${dataConfidence}`,
    scanTimestamp,
    symbol: ticker,
    strikeMode: "safe",
    expiration: "20260529",
    dteAtScan: 4,
    strike: 100,
    premium: 1.1,
    popEstimate: 0.82,
    option_quote_snapshot_json: JSON.stringify(snapshot),
    ...rowOverrides,
  };
}

test("latest-option-snapshots — retourne le dernier scan avec snapshots parsés et whitelistés", async () => {
  const latestScan = "2026-05-25T01:37:02.572Z";
  const service = createWheelValidationService({
    store: {
      load: async () => ({ version: "1.0", records: [] }),
      listLatestOptionSnapshotRows: async () => ({
        latestScanTimestamp: latestScan,
        totalWithSnapshot: 4,
        latestScanSnapshotCount: 3,
        latestScanTotalCount: 4,
        rows: [
          buildStoredSnapshotRow({ ticker: "IBKR", scanTimestamp: latestScan }),
          buildStoredSnapshotRow({
            ticker: "YHOO",
            source: "Yahoo",
            dataConfidence: "observed_yahoo",
            scanTimestamp: latestScan,
            snapshotOverrides: {
              greeks: {},
              liquidity: {},
              contract: {},
              missingFields: ["impliedVolatility", "delta", "volume", "openInterest", "conId", "localSymbol"],
            },
          }),
          {
            id: "BROKEN",
            scanTimestamp: latestScan,
            symbol: "BROK",
            strikeMode: "aggressive",
            expiration: "20260529",
            option_quote_snapshot_json: "{not-json",
          },
        ],
      }),
    },
  });

  const result = await service.getLatestOptionSnapshots({ limit: 50 });

  assert.equal(result.ok, true);
  assert.equal(result.latestScanTimestamp, latestScan);
  assert.equal(result.totalWithSnapshot, 4);
  assert.equal(result.latestScanSnapshotCount, 3);
  assert.equal(result.records.length, 3);
  assert.equal(result.summary.snapshotAbsentCount, 1);
  assert.equal(result.summary.ibkrObservedCount, 1);
  assert.equal(result.summary.yahooFallbackCount, 1);
  assert.equal(result.summary.ivPresentCount, 1);
  assert.equal(result.summary.deltaPresentCount, 1);
  assert.equal(result.summary.bidAskPresentCount, 2);
  assert.equal(result.summary.oiVolumePresentCount, 1);
  assert.equal(result.summary.conIdPresentCount, 1);
  assert.equal(result.summary.localSymbolPresentCount, 1);

  const ibkrRecord = result.records.find((record) => record.ticker === "IBKR");
  assert.equal(ibkrRecord.optionDataBadge, "IBKR observé");
  assert.equal(ibkrRecord.optionQuoteSnapshot.source, "IBKR");
  assert.equal(ibkrRecord.optionQuoteSnapshot.dataConfidence, "observed_ibkr");
  assert.equal(ibkrRecord.optionQuoteSnapshot.mark, 1.15);
  assert.equal(ibkrRecord.optionQuoteSnapshot.modelPrice, 1.16);
  assert.equal(ibkrRecord.optionQuoteSnapshot.modelGreeksTimestamp, latestScan);
  assert.equal(ibkrRecord.optionQuoteSnapshot.tradingClass, "IBKR");
  assert.equal(ibkrRecord.optionQuoteSnapshot.exchange, "SMART");
  assert.equal(ibkrRecord.optionQuoteSnapshot.currency, "USD");
  assert.equal(ibkrRecord.optionQuoteSnapshot.multiplier, "100");
  assert.equal(Object.hasOwn(ibkrRecord.optionQuoteSnapshot, "optionChain"), false);

  const brokenRecord = result.records.find((record) => record.ticker === "BROK");
  assert.equal(brokenRecord.optionSnapshotStorageStatus, "snapshot_parse_failed");
  assert.ok(brokenRecord.optionQuoteSnapshot.warnings.includes("option_quote_snapshot_json_parse_failed"));
});

test("computeOnePercentWheelProfiles — n < 30 ne peut pas afficher 1 % défendable", () => {
  const records = Array.from({ length: 25 }, (_, index) =>
    buildResolvedRecord({
      ticker: "SMALL",
      expiration: `202501${String(10 + index).padStart(2, "0")}`,
      scanDate: `202501${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "SMALL" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(!profile.verdicts.includes("1 % défendable"));
  assert.notEqual(profile.primaryVerdict, "1 % défendable");
});

test("computeOnePercentWheelProfiles — cycles ouverts exclus du P/L fermé", () => {
  const records = Array.from({ length: 35 }, (_, index) =>
    buildResolvedRecord({
      ticker: "PNL",
      yieldPct: 1.1,
      assigned: index % 4 === 0,
      expiration: `202502${String(10 + (index % 20)).padStart(2, "0")}`,
      scanDate: `202502${String((index % 28) + 1).padStart(2, "0")}`,
    }),
  );
  const cycles = [
    buildClosedCycle({ ticker: "PNL", pnl: 80, returnPct: 3 }),
    {
      ticker: "PNL",
      strike_mode: "safe",
      cycle_status: "open",
      status: "open",
      assignment_recovered: 0,
      cc_sold_count: 0,
      cc_not_sold_count: 3,
      total_pnl_contract: -500,
      return_on_assignment_pct: -10,
    },
  ];
  const result = computeOnePercentWheelProfiles(records, cycles, { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "PNL" && p.groupType === "ticker");
  assert.equal(profile.wheel.cyclesOpen, 1);
  assert.equal(profile.wheel.cyclesClosed, 1);
  assert.equal(profile.wheel.avgWheelPnl, 80);
});

test("computeOnePercentWheelProfiles — exclut intradayRetest et expirations futures", () => {
  const records = [
    buildResolvedRecord({ ticker: "FILT", expiration: "20270115" }),
    {
      ...buildResolvedRecord({ ticker: "FILT", expiration: "20250105" }),
      captureClass: "intradayRetest",
    },
    {
      ...buildResolvedRecord({ ticker: "FILT", expiration: "20270101" }),
      resolution: { resolved: false },
    },
  ];
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  assert.equal(result.summary.recordsUsed, 0);
});

test("computeOnePercentWheelProfiles — profil ticker+mode seulement si échantillon suffisant", () => {
  const records = Array.from({ length: 12 }, (_, index) =>
    buildResolvedRecord({
      ticker: "MODE",
      mode: "safe",
      expiration: `202503${String(10 + index).padStart(2, "0")}`,
      scanDate: `202503${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24", minModeProfileN: 15 });
  assert.ok(result.profiles.some((p) => p.ticker === "MODE" && p.groupType === "ticker"));
  assert.ok(!result.profiles.some((p) => p.ticker === "MODE" && p.groupType === "ticker_mode"));
});

test("computeOnePercentWheelProfiles — expose optionData top-level sans changer le verdict", () => {
  const optionQuoteSnapshot = JSON.parse(
    buildStoredSnapshotRow({ ticker: "OPTDATA" }).option_quote_snapshot_json,
  );
  const baseRecords = Array.from({ length: 35 }, (_, index) =>
    buildResolvedRecord({
      ticker: "OPTDATA",
      yieldPct: 1.05,
      expiration: `202503${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202503${String((index % 24) + 1).padStart(2, "0")}`,
    }),
  );
  const recordsWithSnapshot = baseRecords.map((record) => ({ ...record, optionQuoteSnapshot }));

  const baseResult = computeOnePercentWheelProfiles(baseRecords, [], { today: "2026-05-24" });
  const enrichedResult = computeOnePercentWheelProfiles(recordsWithSnapshot, [], { today: "2026-05-24" });
  const baseProfile = baseResult.profiles.find((p) => p.ticker === "OPTDATA" && p.groupType === "ticker");
  const enrichedProfile = enrichedResult.profiles.find((p) => p.ticker === "OPTDATA" && p.groupType === "ticker");

  assert.ok(baseProfile);
  assert.ok(enrichedProfile);
  assert.equal(enrichedProfile.primaryVerdict, baseProfile.primaryVerdict);
  assert.deepEqual(enrichedProfile.verdicts, baseProfile.verdicts);
  assert.equal(enrichedProfile.hasObservedIbkrOptionData, true);
  assert.equal(enrichedProfile.optionDataBadge, "IBKR observé");
  assert.equal(enrichedProfile.optionDataSourceSummary, "IBKR");
  assert.equal(enrichedProfile.optionSnapshotStorageStatus, "snapshot_sqlite_present");
  assert.equal(typeof enrichedProfile.optionDataCompletenessPct, "number");
  assert.ok(Array.isArray(enrichedProfile.optionDataMissingFields));
});

test("computeOnePercentWheelProfiles — verdictReasons explique un profil stressé", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "STRESS",
      yieldPct: 1.1,
      expiration: `202504${String(10 + (index % 20)).padStart(2, "0")}`,
      scanDate: `202504${String((index % 28) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "STRESS" }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 3 === 0,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "STRESS" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(Array.isArray(profile.verdictReasons));
  assert.ok(profile.verdictReasons.length > 0);
  assert.ok(profile.verdictReasons.includes("Rendement CSP élevé"));
  if (profile.primaryVerdict === "1 % stressé") {
    assert.ok(
      profile.verdictReasons.some((reason) =>
        [
          "Touch élevé",
          "LB cassé élevé",
          "LB cassé avec stress",
          "LB cassé critique",
          "Wheel non disponible",
          "Assignation élevée",
        ].includes(reason),
      ),
    );
  }
});

test("classifyLowerBoundStressForOnePercentProfile — LB élevé sans dommage (profil type APLD)", () => {
  const result = classifyLowerBoundStressForOnePercentProfile({
    n: 26,
    csp: {
      recordsResolved: 26,
      lowerBoundBreakRate: 38.5,
      realWinRate: 100,
      assignmentRate: 0,
      strikeTouchRate: 23.1,
    },
    assignment: { profondeRatePct: null, profondeCount: 0 },
    wheel: { cyclesClosed: 0, cyclesAvailable: 0 },
  });
  assert.equal(result.lbStressClass, "sans_dommage");
  assert.equal(result.lbStressLabel, "LB cassé sans dommage");
});

test("classifyLowerBoundStressForOnePercentProfile — LB critique (profil type SMCI)", () => {
  const result = classifyLowerBoundStressForOnePercentProfile({
    n: 22,
    csp: {
      recordsResolved: 22,
      lowerBoundBreakRate: 90.9,
      realWinRate: 77.3,
      assignmentRate: 22.7,
      strikeTouchRate: 54.5,
    },
    assignment: { profondeRatePct: 0, profondeCount: 0 },
    wheel: { cyclesClosed: 12, cyclesAvailable: 12, avgWheelPnl: 97, recoveryRatePct: 100 },
  });
  assert.equal(result.lbStressClass, "critique");
  assert.equal(result.lbStressLabel, "LB cassé critique");
});

test("computeOnePercentWheelProfiles — LB élevé sans dommage ne force plus 1 % stressé seul", () => {
  const records = Array.from({ length: 26 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "APLD",
      yieldPct: 1.09,
      expiration: `202506${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202506${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "APLD" }).resolution,
      strikeTouched: index % 5 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: true,
      expiredWorthless: true,
      assigned: false,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "APLD" && p.groupType === "ticker");
  assert.ok(profile);
  assert.equal(profile.lowerBoundStress?.lbStressClass, "sans_dommage");
  assert.notEqual(profile.primaryVerdict, "1 % stressé");
  assert.ok(profile.verdictReasons.includes("LB cassé sans dommage"));
});

test("computeOnePercentWheelProfiles — LB critique garde 1 % stressé", () => {
  const records = Array.from({ length: 22 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "SMCI",
      yieldPct: 0.95,
      assigned: index % 4 === 0,
      expiration: `202507${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202507${String((index % 20) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "SMCI", assigned: index % 4 === 0 }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 2 === 0 || index % 3 === 0,
      popPredictionCorrect: index % 4 !== 0,
      expiredWorthless: index % 4 !== 0,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "SMCI" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(["avec_stress", "critique"].includes(profile.lowerBoundStress?.lbStressClass));
  assert.equal(profile.primaryVerdict, "1 % stressé");
});

test("computeOnePercentWheelProfiles — verdictReasons mentionne échantillon préliminaire", () => {
  const records = Array.from({ length: 20 }, (_, index) =>
    buildResolvedRecord({
      ticker: "PRELIM",
      yieldPct: 1.05,
      expiration: `202505${String(10 + index).padStart(2, "0")}`,
      scanDate: `202505${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "PRELIM" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(profile.verdictReasons.includes("Échantillon préliminaire"));
});

function buildTickerProfilesFromRecords(records, cycles = [], options = {}) {
  return computeOnePercentWheelProfiles(records, cycles, options).profiles.filter(
    (profile) => profile.groupType === "ticker",
  );
}

test("computeDynamicTop20WheelProfiles — retourne au maximum 20 profils Top 20", () => {
  const records = [];
  for (let tickerIndex = 0; tickerIndex < 30; tickerIndex += 1) {
    const ticker = `T${String(tickerIndex).padStart(2, "0")}`;
    for (let index = 0; index < 35; index += 1) {
      records.push(
        buildResolvedRecord({
          ticker,
          yieldPct: 0.85 + (tickerIndex % 5) * 0.03,
          expiration: `202508${String(10 + (index % 18)).padStart(2, "0")}`,
          scanDate: `202508${String((index % 24) + 1).padStart(2, "0")}`,
        }),
      );
    }
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.length <= 20);
  assert.equal(result.summary.top20Count, result.top20.length);
});

test("computeDynamicTop20WheelProfiles — champs snapshot enrichis ne changent pas le Top 20", () => {
  const records = [];
  for (let tickerIndex = 0; tickerIndex < 24; tickerIndex += 1) {
    const ticker = `SN${String(tickerIndex).padStart(2, "0")}`;
    records.push(...buildSolidTop20Records({ ticker, yieldPct: 0.9 + (tickerIndex % 4) * 0.02 }));
  }
  const snapshot = JSON.parse(buildStoredSnapshotRow({ ticker: "SN00" }).option_quote_snapshot_json);
  const profilesWithoutSnapshots = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const profilesWithSnapshots = buildTickerProfilesFromRecords(
    records.map((record) => ({ ...record, optionQuoteSnapshot: { ...snapshot, ticker: record.symbol } })),
    [],
    { today: "2026-05-24" },
  );

  const base = computeDynamicTop20WheelProfiles(profilesWithoutSnapshots, { today: "2026-05-24" });
  const enriched = computeDynamicTop20WheelProfiles(profilesWithSnapshots, { today: "2026-05-24" });
  assert.deepEqual(
    enriched.top20.map((row) => row.ticker),
    base.top20.map((row) => row.ticker),
  );
  assert.deepEqual(enriched.summary.top20Count, base.summary.top20Count);
});

test("computeDynamicTop20WheelProfiles — n < 15 plafonné hors Top 20 si assez de profils robustes", () => {
  const records = [];
  for (let tickerIndex = 0; tickerIndex < 25; tickerIndex += 1) {
    const ticker = `ROB${String(tickerIndex).padStart(2, "0")}`;
    const count = tickerIndex < 3 ? 12 : 35;
    for (let index = 0; index < count; index += 1) {
      records.push(
        buildResolvedRecord({
          ticker,
          yieldPct: tickerIndex < 3 ? 1.2 : 0.95,
          expiration: `202509${String(10 + (index % 18)).padStart(2, "0")}`,
          scanDate: `202509${String((index % 24) + 1).padStart(2, "0")}`,
        }),
      );
    }
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  const smallProfiles = profiles.filter((profile) => (profile.csp?.recordsResolved ?? 0) < 15);
  assert.ok(smallProfiles.length >= 3);
  for (const small of smallProfiles) {
    assert.ok(!result.top20.some((row) => row.ticker === small.ticker));
  }
  assert.ok(
    result.watchValidate.some((row) => row.dynamicTop20Status === "watch_validate") ||
      result.insufficientSample.length > 0,
  );
});

test("computeDynamicTop20WheelProfiles — profil défavorable à rendement élevé classé excludedHighYield", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "FAUX1",
      yieldPct: 1.15,
      assigned: index % 2 === 0,
      expiration: `202510${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202510${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "FAUX1", assigned: index % 2 === 0 }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: index % 2 !== 0,
      expiredWorthless: index % 2 !== 0,
    },
  }));
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const fauxProfile = profiles.find((profile) => profile.ticker === "FAUX1");
  assert.ok(fauxProfile);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(
    result.excludedHighYield.some((row) => row.ticker === "FAUX1") ||
      fauxProfile.primaryVerdict === "faux 1 %",
  );
  if (fauxProfile.primaryVerdict === "faux 1 %") {
    assert.ok(result.excludedHighYield.some((row) => row.ticker === "FAUX1"));
    assert.ok(!result.top20.some((row) => row.ticker === "FAUX1"));
  }
});

test("computeDynamicTop20WheelProfiles — profil TQQQ-like peut entrer Top 20", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "TQQQ",
      yieldPct: 0.98,
      expiration: `202511${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202511${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "TQQQ" }).resolution,
      strikeTouched: index % 8 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: true,
      expiredWorthless: true,
      assigned: false,
    },
  }));
  const cycles = [buildClosedCycle({ ticker: "TQQQ", pnl: 120, returnPct: 4.5 })];
  const profiles = buildTickerProfilesFromRecords(records, cycles, { today: "2026-05-24" });
  const tqqq = profiles.find((profile) => profile.ticker === "TQQQ");
  assert.ok(tqqq);
  assert.equal(tqqq.lowerBoundStress?.lbStressClass, "sans_dommage");
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.some((row) => row.ticker === "TQQQ"));
  const row = result.top20.find((item) => item.ticker === "TQQQ");
  assert.ok(row.dynamicTop20Score > 70);
});

test("computeDynamicTop20WheelProfiles — contextAvailability indique IV/saisonnalité non intégrés", () => {
  const profiles = buildTickerProfilesFromRecords(
    Array.from({ length: 35 }, (_, index) =>
      buildResolvedRecord({
        ticker: "CTX",
        expiration: `202512${String(10 + (index % 18)).padStart(2, "0")}`,
        scanDate: `202512${String((index % 24) + 1).padStart(2, "0")}`,
      }),
    ),
    [],
    { today: "2026-05-24" },
  );
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.equal(result.summary.contextAvailability.ivIntegrated, false);
  assert.equal(result.summary.contextAvailability.seasonalityIntegrated, false);
  assert.equal(result.summary.contextAvailability.marketContextIntegrated, false);
  assert.match(result.summary.contextAvailability.note, /non encore intégrés/i);
});

function buildStressedHighYieldRecords({
  ticker,
  yieldPct = 0.92,
  assignedEvery = 4,
  lbBreakEvery = 2,
  count = 22,
  prefix = "202507",
}) {
  return Array.from({ length: count }, (_, index) => ({
    ...buildResolvedRecord({
      ticker,
      yieldPct,
      assigned: index % assignedEvery === 0,
      expiration: `${prefix}${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `${prefix}${String((index % 20) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker, assigned: index % assignedEvery === 0 }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % lbBreakEvery === 0 || index % 3 === 0,
      popPredictionCorrect: index % assignedEvery !== 0,
      expiredWorthless: index % assignedEvery !== 0,
    },
  }));
}

function buildSolidTop20Records({
  ticker,
  yieldPct = 0.98,
  assigned = false,
  lbBreakEvery = 12,
  count = 40,
  prefix = "202511",
}) {
  return Array.from({ length: count }, (_, index) => ({
    ...buildResolvedRecord({
      ticker,
      yieldPct,
      assigned,
      expiration: `${prefix}${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `${prefix}${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker, assigned }).resolution,
      strikeTouched: index % 8 === 0,
      brokeLowerBound: index % lbBreakEvery === 0,
      popPredictionCorrect: true,
      expiredWorthless: !assigned,
    },
  }));
}

test("V1B — LB critique exclu du Top 20 malgré rendement Wheel positif", () => {
  const records = buildStressedHighYieldRecords({ ticker: "SMCI", count: 22 });
  const cycles = [buildClosedCycle({ ticker: "SMCI", pnl: 120, returnPct: 5 })];
  const profiles = buildTickerProfilesFromRecords(records, cycles, { today: "2026-05-24" });
  const smci = profiles.find((profile) => profile.ticker === "SMCI");
  assert.ok(smci);
  assert.equal(smci.lowerBoundStress?.lbStressClass, "critique");
  assert.equal(isEligibleForExperimentalTop20(smci).eligible, false);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(!result.top20.some((row) => row.ticker === "SMCI"));
  assert.ok(result.excludedHighYield.some((row) => row.ticker === "SMCI"));
});

test("V1B — winRate < 80 % exclu du Top 20", () => {
  const records = buildStressedHighYieldRecords({ ticker: "LOWWIN", count: 35, lbBreakEvery: 6 });
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const profile = profiles.find((p) => p.ticker === "LOWWIN");
  assert.ok(profile);
  assert.ok((profile.csp?.realWinRate ?? 100) < 80);
  assert.equal(isEligibleForExperimentalTop20(profile).eligible, false);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(!result.top20.some((row) => row.ticker === "LOWWIN"));
});

test("V1B — assignmentRate > 20 % exclu du Top 20", () => {
  const records = Array.from({ length: 35 }, (_, index) =>
    buildResolvedRecord({
      ticker: "HIGHAS",
      yieldPct: 0.95,
      assigned: index % 3 === 0,
      expiration: `202508${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202508${String((index % 24) + 1).padStart(2, "0")}`,
    }),
  );
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const profile = profiles.find((p) => p.ticker === "HIGHAS");
  assert.ok(profile);
  assert.ok((profile.csp?.assignmentRate ?? 0) > 20);
  assert.equal(isEligibleForExperimentalTop20(profile).eligible, false);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(!result.top20.some((row) => row.ticker === "HIGHAS"));
});

test("V1B — verdict 1 % stressé exclu du Top 20", () => {
  const records = buildStressedHighYieldRecords({ ticker: "STRESSV1B", count: 22 });
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const profile = profiles.find((p) => p.ticker === "STRESSV1B");
  assert.ok(profile);
  assert.equal(profile.primaryVerdict, "1 % stressé");
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(!result.top20.some((row) => row.ticker === "STRESSV1B"));
});

test("V1B — aucun doublon Top 20 / excludedHighYield", () => {
  const records = [];
  records.push(...buildStressedHighYieldRecords({ ticker: "SMCI", count: 22, prefix: "202507" }));
  records.push(...buildStressedHighYieldRecords({ ticker: "AAL", count: 22, prefix: "202508" }));
  for (let tickerIndex = 0; tickerIndex < 25; tickerIndex += 1) {
    const ticker = `GOOD${String(tickerIndex).padStart(2, "0")}`;
    records.push(...buildSolidTop20Records({ ticker, yieldPct: 0.9 + (tickerIndex % 3) * 0.03, prefix: "202509" }));
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  const top20Tickers = new Set(result.top20.map((row) => row.ticker));
  const excludedTickers = new Set(result.excludedHighYield.map((row) => row.ticker));
  const stressedTickers = new Set(result.stressed.map((row) => row.ticker));
  for (const ticker of top20Tickers) {
    assert.ok(!excludedTickers.has(ticker), `${ticker} ne doit pas être à la fois Top 20 et exclusion`);
    assert.ok(!stressedTickers.has(ticker), `${ticker} ne doit pas être à la fois Top 20 et stressé`);
  }
});

test("V1B — remplaçants admissibles remplissent le Top 20 après exclusions", () => {
  const records = [];
  records.push(...buildStressedHighYieldRecords({ ticker: "SMCI", count: 22, prefix: "202507" }));
  records.push(...buildStressedHighYieldRecords({ ticker: "AAL", count: 22, prefix: "202508" }));
  for (let tickerIndex = 0; tickerIndex < 25; tickerIndex += 1) {
    const ticker = `ALT${String(tickerIndex).padStart(2, "0")}`;
    records.push(
      ...buildSolidTop20Records({
        ticker,
        yieldPct: 0.88 + (tickerIndex % 4) * 0.02,
        prefix: "202510",
      }),
    );
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(!result.top20.some((row) => row.ticker === "SMCI"));
  assert.ok(!result.top20.some((row) => row.ticker === "AAL"));
  assert.equal(result.top20.length, 20);
  assert.ok(result.top20.some((row) => row.ticker.startsWith("ALT")));
});

test("V1B — profil TQQQ-like reste admissible Top 20", () => {
  const records = buildSolidTop20Records({ ticker: "TQQQ", yieldPct: 0.98, count: 40 });
  const cycles = [buildClosedCycle({ ticker: "TQQQ", pnl: 120, returnPct: 4.5 })];
  const profiles = buildTickerProfilesFromRecords(records, cycles, { today: "2026-05-24" });
  const tqqq = profiles.find((profile) => profile.ticker === "TQQQ");
  assert.ok(tqqq);
  assert.equal(isEligibleForExperimentalTop20(tqqq).eligible, true);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.some((row) => row.ticker === "TQQQ"));
});

test("V1B — profil CCL-like reste admissible Top 20", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "CCL",
      yieldPct: 0.85,
      assigned: index % 10 === 0,
      expiration: `202512${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202512${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "CCL", assigned: index % 10 === 0 }).resolution,
      strikeTouched: index % 6 === 0,
      brokeLowerBound: index % 15 === 0,
      popPredictionCorrect: index % 10 !== 0,
      expiredWorthless: index % 10 !== 0,
    },
  }));
  const cycles = [buildClosedCycle({ ticker: "CCL", pnl: 60, returnPct: 2.5 })];
  const profiles = buildTickerProfilesFromRecords(records, cycles, { today: "2026-05-24" });
  const ccl = profiles.find((profile) => profile.ticker === "CCL");
  assert.ok(ccl);
  assert.ok((ccl.csp?.avgYieldPct ?? 0) >= 0.8);
  assert.equal(isEligibleForExperimentalTop20(ccl).eligible, true);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.some((row) => row.ticker === "CCL"));
});
