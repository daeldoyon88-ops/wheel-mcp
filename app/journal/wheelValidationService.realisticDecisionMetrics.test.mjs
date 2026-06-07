import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRealisticDecisionMetrics,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

// ── Fabrique de records minimaux résolus pour le pool « décision réelle » ───────
let __idSeq = 0;
function rec({
  ticker = "TEST",
  expiration = "2025-01-10",
  mode = "safe",
  dte = 7,
  strike = 100,
  premium = 1, // yield% = premium / strike * 100
  assigned = false,
  close = null, // underlying close à expiration (profondeur)
  resolved = true,
  captureClass = "primaryDaily",
  id = null,
} = {}) {
  __idSeq += 1;
  const resolution = {
    resolved,
    assigned_flag: assigned,
    expiredWorthless: assigned ? false : true,
  };
  if (close != null) resolution.underlying_close_at_expiration = close;
  return {
    id: id ?? `id-${String(__idSeq).padStart(4, "0")}`,
    symbol: ticker,
    selectedExpiration: expiration,
    strikeMode: mode,
    dteAtScan: dte,
    strike: { strike, premium },
    captureClass,
    resolution,
  };
}

test("déduplication — plusieurs SAFE/AGRESSIF/DTE pour un même ticker×expiration → selectedTradeCount = 1", () => {
  const records = [
    rec({ mode: "safe", dte: 7, premium: 1.0 }),
    rec({ mode: "aggressive", dte: 7, premium: 1.2 }),
    rec({ mode: "safe", dte: 4, premium: 0.9 }),
    rec({ mode: "aggressive", dte: 3, premium: 1.3 }),
    rec({ mode: "safe", dte: 2, premium: 0.8 }),
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedTradeCount, 1);
  assert.equal(m.distinctExpirationCount, 1);
  assert.equal(m.observationResolvedCount, 5);
});

test("duplicationRatio > 1 quand plusieurs observations existent pour une seule expiration", () => {
  const records = [
    rec({ premium: 1.0 }),
    rec({ premium: 1.1 }),
    rec({ premium: 1.2 }),
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedTradeCount, 1);
  assert.equal(m.observationResolvedCount, 3);
  assert.equal(m.duplicationRatio, 3);
  assert.ok(m.duplicationRatio > 1);
});

test("BALANCED préfère non assigné à assigné (même groupe)", () => {
  const records = [
    // assigné proche mais rendement élevé
    rec({ id: "assigned", assigned: true, close: 99.5, premium: 2.0 }),
    // non assigné, rendement plus faible
    rec({ id: "clean", assigned: false, premium: 0.6 }),
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedTradeCount, 1);
  assert.equal(m.selectedAssignedCount, 0);
  assert.equal(m.selectedAssignmentRatePct, 0);
});

test("BALANCED préfère assignation proche à profonde (toutes assignées)", () => {
  const records = [
    // profonde (-10%), rendement élevé
    rec({ id: "deep", assigned: true, strike: 100, close: 90, premium: 2.0 }),
    // proche (-0.5%), rendement plus faible
    rec({ id: "near", assigned: true, strike: 100, close: 99.5, premium: 1.0 }),
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedTradeCount, 1);
  assert.equal(m.selectedAssignedCount, 1);
  assert.equal(m.selectedNearAssignmentCount, 1);
  assert.equal(m.selectedDeepAssignmentCount, 0);
});

test("BALANCED préfère SAFE si rendement presque équivalent (≤0,15 %)", () => {
  const records = [
    rec({ id: "safe", mode: "safe", assigned: false, premium: 1.0 }), // 1.0%
    rec({ id: "agg", mode: "aggressive", assigned: false, premium: 1.1 }), // 1.1% (Δ0.1 ≤ 0.15)
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedTradeCount, 1);
  assert.equal(m.selectedModeSplit.SAFE, 1);
  assert.equal(m.selectedModeSplit.AGGRESSIVE, 0);
});

test("BALANCED choisit AGRESSIF si rendement nettement supérieur (>0,15 %)", () => {
  const records = [
    rec({ id: "safe", mode: "safe", assigned: false, premium: 1.0 }), // 1.0%
    rec({ id: "agg", mode: "aggressive", assigned: false, premium: 2.0 }), // 2.0% (Δ1.0 > 0.15)
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.selectedModeSplit.AGGRESSIVE, 1);
  assert.equal(m.selectedModeSplit.SAFE, 0);
});

test("selectedAssignmentRatePct repose sur selectedTradeCount, pas sur le nombre d'observations", () => {
  const records = [
    // expiration 1 : 5 observations TOUTES assignées → pick assigné
    ...Array.from({ length: 5 }, (_, i) =>
      rec({ expiration: "2025-01-10", assigned: true, strike: 100, close: 99.5, premium: 1.0 + i * 0.01 }),
    ),
    // expiration 2 : 5 observations TOUTES non assignées → pick non assigné
    ...Array.from({ length: 5 }, (_, i) =>
      rec({ expiration: "2025-01-17", assigned: false, premium: 1.0 + i * 0.01 }),
    ),
  ];
  const m = computeRealisticDecisionMetrics(records);
  // 2 décisions (1 par expiration), 1 assignée
  assert.equal(m.selectedTradeCount, 2);
  assert.equal(m.selectedAssignedCount, 1);
  assert.equal(m.selectedAssignmentRatePct, 50);
  // base observationnelle : 10 résolues, 5 assignées (≠ taux décision)
  assert.equal(m.observationResolvedCount, 10);
  assert.equal(m.observationAssignedCount, 5);
  assert.equal(m.distinctExpirationCount, 2);
  assert.equal(m.duplicationRatio, 5);
});

test("intradayRetest et records non résolus sont exclus du pool décision", () => {
  const records = [
    rec({ id: "ok", assigned: false, premium: 1.0 }),
    rec({ id: "retest", assigned: false, premium: 1.0, captureClass: "intradayRetest" }),
    rec({ id: "unresolved", assigned: false, premium: 1.0, resolved: false }),
  ];
  const m = computeRealisticDecisionMetrics(records);
  assert.equal(m.observationResolvedCount, 1);
  assert.equal(m.selectedTradeCount, 1);
});

test("additivité — realisticDecisionMetrics présent sans modifier dynamicTop20Score ni le tri", () => {
  // Échantillon multi-tickers / multi-expirations, base legacy (sans records → scoring legacy).
  const records = [];
  const tickers = ["AAA", "BBB", "CCC"];
  for (const t of tickers) {
    for (let e = 0; e < 6; e += 1) {
      const expiration = `2025-02-0${e + 1}`;
      records.push(rec({ ticker: t, expiration, mode: "safe", assigned: e === 0, close: e === 0 ? 99.5 : null, premium: 1.0 }));
      records.push(rec({ ticker: t, expiration, mode: "aggressive", assigned: false, premium: 1.2 }));
    }
  }

  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-01-01" });
  const tickerProfiles = profiles.filter((p) => p.groupType === "ticker");
  assert.ok(tickerProfiles.length >= 3);

  // Le bloc additif est présent et bien formé sur chaque profil ticker.
  for (const p of tickerProfiles) {
    assert.ok(p.realisticDecisionMetrics, `realisticDecisionMetrics manquant pour ${p.ticker}`);
    assert.equal(p.realisticDecisionMetrics.policy, "BALANCED");
    assert.equal(typeof p.realisticDecisionMetrics.selectedTradeCount, "number");
  }

  // Référence : Top 20 calculé AVEC le bloc additif présent.
  const withBlock = computeDynamicTop20WheelProfiles(profiles, { today: "2026-01-01" });

  // Contrôle : on retire le bloc additif et on recalcule.
  const stripped = profiles.map((p) => {
    const { realisticDecisionMetrics, ...rest } = p;
    void realisticDecisionMetrics;
    return rest;
  });
  const withoutBlock = computeDynamicTop20WheelProfiles(stripped, { today: "2026-01-01" });

  const order = (res) =>
    [...res.top20, ...res.nearEntry, ...res.watchValidate, ...res.insufficientSample].map((r) => ({
      ticker: r.ticker,
      score: r.dynamicTop20Score,
      status: r.dynamicTop20Status,
    }));

  assert.deepEqual(order(withBlock), order(withoutBlock));

  // Et la ligne Top 20 porte bien le champ additif.
  const allRows = [...withBlock.top20, ...withBlock.nearEntry, ...withBlock.watchValidate, ...withBlock.insufficientSample];
  for (const row of allRows) {
    assert.ok("realisticDecisionMetrics" in row);
  }
});
