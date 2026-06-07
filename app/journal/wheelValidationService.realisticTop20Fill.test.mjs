import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRealisticPreviewScore,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// J5-B6 — Remplissage du Top 20 réaliste avec des candidats « à confirmer ».
// Le score réaliste reste le score principal (J5-B3-B). Quand les admissibles
// STRICTS (selectedTradeCount≥5 + garde-fous) sont insuffisants pour remplir 20
// lignes, des candidats « à confirmer » (3–4 décisions réelles + garde-fous OK +
// échantillon observationnel suffisant) complètent le Top 20 DERRIÈRE les stricts.
// Aucun second classement, aucun mauvais ticker réintégré comme s'il était solide.
// ─────────────────────────────────────────────────────────────────────────────

let __idSeq = 0;
function rec({
  ticker = "TEST",
  expiration = "2025-01-10",
  mode = "safe",
  dte = 7,
  strike = 100,
  premium = 1,
  assigned = false,
  close = null,
  resolved = true,
  captureClass = "primaryDaily",
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
    id: `id-${String(__idSeq).padStart(4, "0")}`,
    symbol: ticker,
    selectedExpiration: expiration,
    strikeMode: mode,
    dteAtScan: dte,
    strike: { strike, premium },
    captureClass,
    resolution,
  };
}

// Ticker STRICT : `expirations` (≥5) expirations × `obsPerExp` observations,
// non assignées, rendement ~1 % → selectedTradeCount = expirations.
function strictTicker(ticker, expirations, obsPerExp, { premium = 1.0 } = {}) {
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

// Ticker CONFIRM : 4 expirations × 4 observations = selectedTradeCount 4 (3–4)
// + observationResolvedCount 16 (≥15) + rendement ~1 % + garde-fous OK.
function confirmTicker(ticker, { premium = 1.0 } = {}) {
  return strictTicker(ticker, 4, 4, { premium });
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

// Sanity : un confirmTicker isolé est bien classé « confirm » par le preview.
test("setup — confirmTicker → bucket confirm (4 décisions, 16 observations)", () => {
  const records = confirmTicker("CHK");
  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-04-01" });
  const profile = profiles.find((p) => p.ticker === "CHK" && p.groupType === "ticker");
  assert.ok(profile, "profil CHK présent");
  const rdm = profile.realisticDecisionMetrics;
  assert.equal(rdm.selectedTradeCount, 4);
  assert.ok(rdm.observationResolvedCount >= 15, "≥15 observations résolues");
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 70,
    assignmentRate: profile?.csp?.assignmentRate ?? null,
    realisticDecisionMetrics: rdm,
  });
  assert.equal(preview.dynamicTop20RealisticBucket, "confirm");
  assert.equal(preview.eligibleForTop20Confirm, true);
  assert.equal(preview.eligibleForTop20, false); // pas strict (4 < 5)
  assert.equal(preview.selectedTradeCountGuard, "confirm");
  assert.equal(preview.dynamicTop20Confidence, "low");
});

// ── A — 9 stricts + 11 confirm valides → Top 20 contient 20 lignes ──────────────
test("A — 9 stricts + 11 confirm → Top 20 = 20 lignes", () => {
  const records = [];
  for (let i = 0; i < 9; i += 1) {
    records.push(...strictTicker(`STRICT${i}`, 6, 2, { premium: 1.2 - i * 0.02 }));
  }
  for (let i = 0; i < 11; i += 1) {
    records.push(...confirmTicker(`CONF${i}`, { premium: 1.1 - i * 0.02 }));
  }
  const result = buildE2bResult(records);
  assert.equal(result.top20.length, 20, "Top 20 rempli à 20 lignes");

  const strictRows = result.top20.filter(
    (r) => r.realisticActive?.dynamicTop20RealisticBucket === "strict",
  );
  const confirmRows = result.top20.filter(
    (r) => r.realisticActive?.dynamicTop20RealisticBucket === "confirm",
  );
  assert.equal(strictRows.length, 9, "9 stricts dans le Top 20");
  assert.equal(confirmRows.length, 11, "11 à confirmer dans le Top 20");
  assert.equal(result.meta.guardrails.strictInTop20Count, 9);
  assert.equal(result.meta.guardrails.confirmInTop20Count, 11);
});

// ── B — Les stricts restent DEVANT les confirm (jamais l'inverse) ───────────────
test("B — stricts placés avant les confirm dans le Top 20", () => {
  const records = [];
  // Stricts au score réaliste volontairement plus bas que certains confirm.
  for (let i = 0; i < 3; i += 1) {
    records.push(...strictTicker(`S${i}`, 5, 2, { premium: 0.85 }));
  }
  // Confirm au rendement plus élevé → score réaliste comparable/supérieur.
  for (let i = 0; i < 6; i += 1) {
    records.push(...confirmTicker(`C${i}`, { premium: 1.25 }));
  }
  const result = buildE2bResult(records);
  const buckets = result.top20.map(
    (r) => r.realisticActive?.dynamicTop20RealisticBucket,
  );
  const firstConfirmIdx = buckets.indexOf("confirm");
  const lastStrictIdx = buckets.lastIndexOf("strict");
  if (firstConfirmIdx !== -1 && lastStrictIdx !== -1) {
    assert.ok(
      lastStrictIdx < firstConfirmIdx,
      "tous les stricts apparaissent avant le premier confirm",
    );
  }
  // Le rang d'un strict est toujours inférieur à celui de tout confirm.
  const strictRanks = result.top20
    .filter((r) => r.realisticActive?.dynamicTop20RealisticBucket === "strict")
    .map((r) => r.rank);
  const confirmRanks = result.top20
    .filter((r) => r.realisticActive?.dynamicTop20RealisticBucket === "confirm")
    .map((r) => r.rank);
  if (strictRanks.length && confirmRanks.length) {
    assert.ok(Math.max(...strictRanks) < Math.min(...confirmRanks));
  }
});

// ── C — Un confirm n'entre QUE si les places strictes sont insuffisantes ────────
test("C — 20 stricts → aucun confirm dans le Top 20", () => {
  const records = [];
  for (let i = 0; i < 22; i += 1) {
    records.push(...strictTicker(`FULL${String(i).padStart(2, "0")}`, 6, 2, { premium: 1.3 - i * 0.01 }));
  }
  for (let i = 0; i < 5; i += 1) {
    records.push(...confirmTicker(`CX${i}`, { premium: 1.0 }));
  }
  const result = buildE2bResult(records);
  assert.equal(result.top20.length, 20);
  const confirmInTop20 = result.top20.some(
    (r) => r.realisticActive?.dynamicTop20RealisticBucket === "confirm",
  );
  assert.equal(confirmInTop20, false, "places strictes pleines → pas de confirm");
  assert.equal(result.meta.guardrails.confirmInTop20Count, 0);
  // Le confirm reste présent (admissible confirm) mais hors Top 20.
  const cx0 = allRows(result).find((r) => r.ticker === "CX0");
  assert.ok(cx0);
  assert.notEqual(cx0.dynamicTop20Status, "top20_experimental");
  assert.equal(cx0.realisticActive?.eligibleForTop20Confirm, true);
});

// ── D — Rendement réel < 0,5 % reste EXCLU (jamais confirm, jamais Top 20) ───────
test("D — rendement réel <0,5 % → rejected, hors Top 20", () => {
  const records = [
    ...strictTicker("LOWY", 6, 3, { premium: 0.4 }), // yield 0,4 % < 0,5 %
    ...strictTicker("OKY", 6, 2, { premium: 1.0 }),
  ];
  const result = buildE2bResult(records);
  assert.equal(result.top20.some((r) => r.ticker === "LOWY"), false);
  const lowy = allRows(result).find((r) => r.ticker === "LOWY");
  assert.ok(lowy);
  assert.equal(lowy.realisticActive?.dynamicTop20RealisticBucket, "rejected");
  assert.equal(lowy.realisticActive?.eligibleForTop20, false);
  assert.equal(lowy.realisticActive?.eligibleForTop20Confirm, false);
});

// ── E — Profondeur réelle > 50 % reste EXCLUE ───────────────────────────────────
test("E — assignation profonde réelle >50 % → rejected, hors Top 20", () => {
  const records = [];
  // DEEP : 6 expirations, toutes assignées profondément (close 12 % sous le strike).
  for (let e = 0; e < 6; e += 1) {
    const expiration = `2025-03-${String(3 + e).padStart(2, "0")}`;
    for (let o = 0; o < 3; o += 1) {
      records.push(
        rec({
          ticker: "DEEP",
          expiration,
          mode: o % 2 === 0 ? "safe" : "aggressive",
          dte: [7, 4, 3][o % 3],
          premium: 1.0,
          assigned: true,
          close: 88, // strike 100 → -12 % → profonde
        }),
      );
    }
  }
  records.push(...strictTicker("CLEAN", 6, 2, { premium: 1.0 }));
  const result = buildE2bResult(records);
  assert.equal(result.top20.some((r) => r.ticker === "DEEP"), false);
  const deep = allRows(result).find((r) => r.ticker === "DEEP");
  assert.ok(deep);
  assert.equal(deep.realisticActive?.dynamicTop20RealisticBucket, "rejected");
  assert.equal(deep.realisticActive?.eligibleForTop20, false);
  assert.equal(deep.realisticActive?.eligibleForTop20Confirm, false);
});

// ── F — Crypto-block / exclusions critiques restent prioritaires ────────────────
test("F — crypto-block prioritaire même sur un profil confirm propre", () => {
  const records = [
    ...confirmTicker("RIOT", { premium: 1.2 }), // crypto/digital → bloqué
    ...strictTicker("OKAY", 6, 2, { premium: 1.0 }),
  ];
  const result = buildE2bResult(records);
  assert.ok(result.excludedCrypto.some((r) => r.ticker === "RIOT"));
  assert.equal(result.top20.some((r) => r.ticker === "RIOT"), false);
});

// ── G — Le score réaliste reste le score principal ──────────────────────────────
test("G — score réaliste principal inchangé (source = realistic)", () => {
  const records = [
    ...strictTicker("MAINA", 6, 2, { premium: 1.1 }),
    ...confirmTicker("MAINB", { premium: 1.05 }),
  ];
  const result = buildE2bResult(records);
  assert.equal(result.meta.scoreType, "dynamicTop20ScoreRealistic");
  assert.equal(result.meta.scoreSource, "realistic");
  for (const row of result.top20) {
    assert.equal(row.dynamicTop20ScoreSource, "realistic");
    assert.equal(row.dynamicTop20Score, row.realisticActive?.score);
  }
});

// ── H — Aucun second classement n'est créé ──────────────────────────────────────
test("H — un seul Top 20 (pas de classement parallèle), ticker unique", () => {
  const records = [
    ...strictTicker("UA", 6, 2, { premium: 1.1 }),
    ...confirmTicker("UB", { premium: 1.0 }),
    ...confirmTicker("UC", { premium: 0.95 }),
  ];
  const result = buildE2bResult(records);
  assert.equal(result.top20Realistic, undefined);
  assert.equal(result.realisticTop20, undefined);
  assert.equal(result.confirmTop20, undefined);
  const seen = new Map();
  for (const row of allRows(result)) {
    seen.set(row.ticker, (seen.get(row.ticker) ?? 0) + 1);
  }
  for (const [ticker, count] of seen) {
    assert.equal(count, 1, `${ticker} ne doit apparaître qu'une fois`);
  }
});
