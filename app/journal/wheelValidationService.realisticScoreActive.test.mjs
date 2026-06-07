import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRealisticPreviewScore,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// J5-B3-B — Score réaliste ACTIF comme score principal du Top 20 (avec garde-fous).
// Le pipeline compétitif E2b (records présents) classe désormais par le score
// réaliste ; l'ancien score E2b est conservé en référence (dynamicTop20ScoreLegacy).
// ─────────────────────────────────────────────────────────────────────────────

let __idSeq = 0;
function rec({
  ticker = "TEST",
  expiration = "2025-01-10",
  mode = "safe",
  dte = 7,
  strike = 100,
  premium = 1, // yield% = premium / strike * 100
  assigned = false,
  close = null,
  resolved = true,
  captureClass = "primaryDaily",
  id = null,
} = {}) {
  __idSeq += 1;
  const resolution = {
    resolved,
    assigned_flag: assigned,
    expiredWorthless: assigned ? false : true,
    popPredictionCorrect: !assigned,
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

// Construit un ticker « propre » : `expirations` expirations distinctes ×
// `obsPerExp` observations (alternant SAFE / AGRESSIF), non assignées, rendement ~1 %.
function cleanTicker(ticker, expirations, obsPerExp, { premium = 1.0 } = {}) {
  const out = [];
  for (let e = 0; e < expirations; e += 1) {
    const expiration = `2025-03-${String(3 + e).padStart(2, "0")}`;
    for (let o = 0; o < obsPerExp; o += 1) {
      out.push(
        rec({
          ticker,
          expiration,
          mode: o % 2 === 0 ? "safe" : "aggressive",
          dte: [7, 4, 3, 2][o % 4],
          premium: premium + o * 0.01,
          assigned: false,
        }),
      );
    }
  }
  return out;
}

function buildE2bResult(records) {
  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-04-01" });
  return computeDynamicTop20WheelProfiles(profiles, { today: "2026-04-01", records });
}

function allRows(result) {
  return [
    ...result.top20,
    ...result.nearEntry,
    ...result.watchValidate,
    ...result.stressed,
    ...result.excludedHighYield,
    ...result.insufficientSample,
    ...result.excludedCrypto,
  ];
}

// ── A — Le Top 20 utilise le score réaliste comme dynamicTop20Score actif ───────
test("A — dynamicTop20Score actif = score réaliste (realisticPreview.score) en E2b", () => {
  const records = [
    ...cleanTicker("GOODA", 5, 2),
    ...cleanTicker("GOODB", 5, 2, { premium: 1.1 }),
    ...cleanTicker("GOODC", 6, 2, { premium: 0.95 }),
  ];
  const result = buildE2bResult(records);
  assert.ok(result.top20.length > 0, "au moins un ticker en Top 20");
  for (const row of result.top20) {
    assert.equal(row.dynamicTop20ScoreSource, "realistic");
    assert.equal(row.dynamicTop20Score, row.realisticActive?.score);
    // Le preview (recalculé sur la base legacy) reflète le score actif.
    assert.equal(row.dynamicTop20Score, row.realisticPreview?.score);
  }
});

// ── B — L'ancien score est conservé dans dynamicTop20ScoreLegacy ────────────────
test("B — dynamicTop20ScoreLegacy conserve l'ancien score compétitif E2b", () => {
  const records = [...cleanTicker("KEEP", 5, 2), ...cleanTicker("KEEP2", 5, 2)];
  const result = buildE2bResult(records);
  assert.ok(result.top20.length > 0);
  for (const row of result.top20) {
    assert.ok(row.dynamicTop20ScoreLegacy != null, "legacy présent");
    assert.equal(row.dynamicTop20ScoreLegacy, row.competitiveScoreV2);
    assert.equal(row.dynamicTop20ScoreLegacy, row.realisticActive?.baseScore);
  }
});

// ── C — selectedTradeCount < 5 empêche l'entrée Top 20 principal ────────────────
test("C — selectedTradeCount < 5 : exclu du Top 20 principal", () => {
  const records = [
    // FEW : 3 expirations seulement (selectedTradeCount = 3) mais n = 12 ≥ 10.
    ...cleanTicker("FEW", 3, 4),
    // Concurrents normaux pour peupler le Top 20.
    ...cleanTicker("MANYA", 6, 2),
    ...cleanTicker("MANYB", 6, 2, { premium: 1.05 }),
  ];
  const result = buildE2bResult(records);
  const fewInTop20 = result.top20.some((r) => r.ticker === "FEW");
  assert.equal(fewInTop20, false, "FEW (selTrades<5) ne doit pas être Top 20 principal");
  const few = allRows(result).find((r) => r.ticker === "FEW");
  assert.ok(few, "FEW reste présent dans un autre bucket");
  assert.notEqual(few.dynamicTop20Status, "top20_experimental");
  assert.equal(few.realisticActive?.eligibleForTop20, false);
});

// ── D — selectedTradeCount >= 5 permet l'entrée si le score réaliste est bon ─────
test("D — selectedTradeCount ≥ 5 + score réaliste solide : admissible Top 20", () => {
  const records = [...cleanTicker("ELIG", 5, 2), ...cleanTicker("ELIG2", 6, 2)];
  const result = buildE2bResult(records);
  const elig = result.top20.find((r) => r.ticker === "ELIG");
  assert.ok(elig, "ELIG (selTrades=5, propre) admissible Top 20");
  assert.equal(elig.realisticActive?.eligibleForTop20, true);
  assert.equal(elig.realisticDecisionMetrics?.selectedTradeCount, 5);
});

// ── E — Pas de deuxième classement : un seul Top 20, chaque ticker une fois ──────
test("E — pas de deuxième classement (un seul Top 20, ticker unique)", () => {
  const records = [
    ...cleanTicker("UNIQA", 5, 2),
    ...cleanTicker("UNIQB", 6, 2),
    ...cleanTicker("UNIQC", 3, 4),
  ];
  const result = buildE2bResult(records);
  // Aucune structure de classement réaliste parallèle.
  assert.equal(result.top20Realistic, undefined);
  assert.equal(result.realisticTop20, undefined);
  assert.equal(result.meta.scoreType, "dynamicTop20ScoreRealistic");
  assert.equal(result.meta.scoreSource, "realistic");
  // Chaque ticker apparaît dans exactement un bucket.
  const seen = new Map();
  for (const row of allRows(result)) {
    seen.set(row.ticker, (seen.get(row.ticker) ?? 0) + 1);
  }
  for (const [ticker, count] of seen) {
    assert.equal(count, 1, `${ticker} ne doit apparaître qu'une fois`);
  }
  // Le Top 20 est trié par score réaliste actif décroissant.
  const scores = result.top20.map((r) => r.dynamicTop20Score);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1] >= scores[i], "Top 20 trié par score réaliste décroissant");
  }
});

// ── F — Les exclusions critiques restent prioritaires (crypto-block) ────────────
test("F — crypto-block reste prioritaire sur le score réaliste", () => {
  const records = [
    ...cleanTicker("RIOT", 6, 2), // crypto/digital asset → doit être bloqué
    ...cleanTicker("OKAY", 6, 2),
  ];
  const result = buildE2bResult(records);
  assert.ok(
    result.excludedCrypto.some((r) => r.ticker === "RIOT"),
    "RIOT bloqué crypto malgré profil propre",
  );
  assert.equal(result.top20.some((r) => r.ticker === "RIOT"), false);
});

// ── G — Le tri change : ancien score haut + réaliste faible descend sous ─────────
//        ancien score moyen + réaliste fort (test contrôlé, niveau scoring).
test("G — réaliste réordonne : vieux score haut/faible réaliste passe sous moyen/fort réaliste", () => {
  const rowHighOldWeakReal = {
    ticker: "AHIGH",
    rank: 1,
    n: 50,
    dynamicTop20Score: 90, // ancien score haut
    assignmentRate: 20,
    realisticDecisionMetrics: {
      selectedTradeCount: 5,
      duplicationRatio: 6, // -10
      selectedAssignmentRatePct: 20,
      selectedDeepAssignmentRatePct: 45, // -10
      selectedAvgCspYieldPct: 0.6, // pas de bonus, pas <0.5
      selectedWinRatePct: 78,
    },
  };
  const rowMidOldStrongReal = {
    ticker: "BMID",
    rank: 2,
    n: 40,
    dynamicTop20Score: 70, // ancien score moyen
    assignmentRate: 20,
    realisticDecisionMetrics: {
      selectedTradeCount: 8,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 10, // +5 (assignation réelle inférieure)
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 1.0, // +8
      selectedWinRatePct: 95, // +8
    },
  };

  const a = computeRealisticPreviewScore(rowHighOldWeakReal);
  const b = computeRealisticPreviewScore(rowMidOldStrongReal);

  // Par ancien score : A (90) > B (70). Par score réaliste : B doit dépasser A.
  assert.ok(rowHighOldWeakReal.dynamicTop20Score > rowMidOldStrongReal.dynamicTop20Score);
  assert.equal(a.score, 70); // 90 -10 (dup≥6) -10 (deep>40)
  assert.equal(b.score, 94); // 70 +8 (assign infér.) +8 (rend.≥1) +8 (win≥90)
  assert.ok(b.score > a.score, "le score réaliste réordonne B au-dessus de A");

  const sorted = [rowHighOldWeakReal, rowMidOldStrongReal]
    .map((r) => ({ ticker: r.ticker, score: computeRealisticPreviewScore(r).score }))
    .sort((x, y) => y.score - x.score);
  assert.equal(sorted[0].ticker, "BMID");
});

// ── Garde-fous unitaires supplémentaires ────────────────────────────────────────
test("garde-fou — rendement réel < 0,5 % pénalise et rend inadmissible Top 20", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 80,
    assignmentRate: 10,
    realisticDecisionMetrics: {
      selectedTradeCount: 8,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 5,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.4, // < 0.5 %
      selectedWinRatePct: 90,
    },
  });
  assert.ok(preview.penalties.some((p) => p.reason === "rendement réel insuffisant"));
  assert.equal(preview.eligibleForTop20, false);
  assert.match(preview.eligibilityReason ?? "", /rendement réel/);
});

test("garde-fou — selectedTradeCount 5–7 → confiance faible mais admissible", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 75,
    assignmentRate: 15,
    realisticDecisionMetrics: {
      selectedTradeCount: 6,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 10,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.9,
      selectedWinRatePct: 88,
    },
  });
  assert.equal(preview.eligibleForTop20, true);
  assert.equal(preview.confidenceBadge, "confiance faible");
});

test("garde-fou — selectedTradeCount < 5 → inadmissible + badge échantillon insuffisant", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 80,
    assignmentRate: 10,
    realisticDecisionMetrics: {
      selectedTradeCount: 4,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 0,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.9,
      selectedWinRatePct: 100,
    },
  });
  assert.equal(preview.eligibleForTop20, false);
  assert.equal(preview.confidenceBadge, "échantillon insuffisant");
});

test("garde-fou — assignation profonde réelle > 50 % → inadmissible Top 20", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 80,
    assignmentRate: 20,
    realisticDecisionMetrics: {
      selectedTradeCount: 8,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 20,
      selectedDeepAssignmentRatePct: 55, // > 50 %
      selectedAvgCspYieldPct: 0.9,
      selectedWinRatePct: 85,
    },
  });
  assert.equal(preview.eligibleForTop20, false);
  assert.match(preview.eligibilityReason ?? "", /profonde/);
});
