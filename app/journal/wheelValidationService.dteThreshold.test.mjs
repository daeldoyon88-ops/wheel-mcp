import test from "node:test";
import assert from "node:assert/strict";
import {
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// J6-A2 — Seuils du Top réaliste adaptés quand un filtre DTE est actif.
//
// Vue « all » (dteFilter null) : logique STRICTE inchangée (strict ≥5 décisions,
// confirm 3–4 décisions UNIQUEMENT si observationResolved≥15). Vue DTE spécifique
// (7/4/3) : seuil « dte_confirm » adapté — 3–4 décisions réelles sur l'horizon +
// garde-fous qualité OK suffisent à remplir le Top DTE DERRIÈRE les stricts, SANS
// exiger observationResolved≥15. Un profil dangereux (rendement <0,5 %, profondeur
// >50 %) ou à échantillon insuffisant (n<10 obs ou <3 décisions) reste exclu.
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
} = {}) {
  __idSeq += 1;
  const resolution = {
    resolved: true,
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
    captureClass: "primaryDaily",
    resolution,
  };
}

// Ticker mono-DTE : `expirations` expirations × `obsPerExp` observations sur un seul
// horizon. selectedTradeCount = expirations (1 décision BALANCED par expiration) ;
// n = expirations × obsPerExp.
function monoDte(
  ticker,
  dte,
  expirations,
  obsPerExp,
  { premium = 1.0, month = "03", assigned = false, close = null } = {},
) {
  const out = [];
  for (let e = 0; e < expirations; e += 1) {
    const expiration = `2025-${month}-${String(3 + e).padStart(2, "0")}`;
    for (let o = 0; o < obsPerExp; o += 1) {
      out.push(
        rec({
          ticker,
          expiration,
          mode: o % 2 === 0 ? "safe" : "aggressive",
          dte,
          premium: premium + o * 0.01,
          assigned,
          close,
        }),
      );
    }
  }
  return out;
}

function buildView(records, dteFilter) {
  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-04-01" });
  return computeDynamicTop20WheelProfiles(profiles, {
    today: "2026-04-01",
    records,
    ...(dteFilter !== undefined ? { dteFilter } : {}),
  });
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

function rowFor(result, ticker) {
  return allRows(result).find((r) => r.ticker === ticker) ?? null;
}

function bucketOf(result, ticker) {
  return rowFor(result, ticker)?.realisticActive?.dynamicTop20RealisticBucket ?? null;
}

function inTop20(result, ticker) {
  return result.top20.some((r) => r.ticker === ticker);
}

// Jeu de données : tickers mono-DTE couvrant chaque cas de seuil.
function dataset() {
  return [
    // STRICT7 : 6 expirations DTE 7 → 6 décisions (strict, ≥5) sur les deux vues.
    ...monoDte("STRICT7", 7, 6, 2, { premium: 1.0, month: "01" }),
    // IONQ7 : 4 décisions DTE 7, 12 obs, 0 assignation — « IONQ propre » 7 DTE.
    //   all : obs 12 < 15 → confirm global REFUSÉ → rejected.
    //   7 DTE : dte_confirm → Top DTE.
    ...monoDte("IONQ7", 7, 4, 3, { premium: 1.0, month: "03" }),
    // FOUR3 : 3 décisions DTE 4, 6 obs (5 ≤ n < 10), propre → dte_confirm en 4 DTE
    //   grâce au plancher observationnel abaissé des vues DTE (E2B_DTE_CONFIRM_MIN_N).
    ...monoDte("FOUR3", 4, 3, 2, { premium: 1.0, month: "05" }),
    // LOWN4 : 3 décisions DTE 4 mais seulement 3 obs (n < 5) → échantillon
    //   observationnel insuffisant même en vue DTE → hors Top.
    ...monoDte("LOWN4", 4, 3, 1, { premium: 1.0, month: "04" }),
    // TWODEC : 2 décisions DTE 7, 12 obs → <3 décisions → hors Top même en DTE.
    ...monoDte("TWODEC", 7, 2, 6, { premium: 1.0, month: "07" }),
    // LOWY7 : 4 décisions DTE 7 mais rendement 0,4 % < 0,5 % → exclu partout.
    ...monoDte("LOWY7", 7, 4, 3, { premium: 0.4, month: "09" }),
    // DEEP7 : 4 décisions DTE 7 toutes assignées profondément (close 88 < strike) →
    //   profondeur réelle 100 % > 50 % → exclu partout.
    ...monoDte("DEEP7", 7, 4, 3, { premium: 2.0, month: "11", assigned: true, close: 88 }),
    // IONQ4 : échantillon insuffisant DTE 4 (1 expiration, 2 obs assignées) → hors Top.
    ...monoDte("IONQ4", 4, 1, 2, { premium: 2.0, month: "06", assigned: true, close: 99.5 }),
    // IONQ3 : DTE 3 dangereux (assignations profondes) + petit échantillon → hors Top.
    ...monoDte("IONQ3", 3, 2, 2, { premium: 2.0, month: "08", assigned: true, close: 88 }),
  ];
}

// ── A — Vue « all » : comportement strict actuel inchangé ────────────────────────
test("A — vue all = vue sans filtre, aucun bucket dte_confirm", () => {
  const records = dataset();
  const noFilter = buildView(records);
  const all = buildView(records, "all");

  assert.equal(noFilter.meta.dteFilter, null, "sans filtre → dteFilter null");
  assert.equal(all.meta.dteFilter, null, "'all' → dteFilter null");
  assert.equal(all.meta.guardrails.dteConfirmEnabled, false, "all → seuil DTE désactivé");

  const project = (r) =>
    r.top20.map((row) => ({ t: row.ticker, s: row.dynamicTop20Score }));
  assert.deepEqual(project(all), project(noFilter), "Top all = Top sans filtre");

  // Aucune ligne « dte_confirm » ne doit exister dans la vue all.
  const anyDteConfirm = allRows(all).some(
    (row) => row.realisticActive?.dynamicTop20RealisticBucket === "dte_confirm",
  );
  assert.equal(anyDteConfirm, false, "vue all → jamais de bucket dte_confirm");

  // IONQ7 (4 décisions, 12 obs < 15) reste hors Top réaliste global (confirm refusé).
  assert.equal(inTop20(all, "IONQ7"), false, "IONQ7 hors Top all (obs<15)");
  assert.equal(bucketOf(all, "IONQ7"), "rejected", "IONQ7 rejected en all (obs<15)");
});

// ── B — Vue 7 DTE : un profil 4 décisions entre dans le Top DTE ──────────────────
test("B — 7 DTE : IONQ7 (4 décisions) promu dans le Top DTE (dte_confirm)", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);

  assert.equal(dte7.meta.dteFilter, 7);
  assert.equal(dte7.meta.guardrails.dteConfirmEnabled, true, "7 DTE → seuil adapté actif");

  assert.ok(inTop20(dte7, "IONQ7"), "IONQ7 dans le Top DTE 7");
  const ionq = dte7.top20.find((r) => r.ticker === "IONQ7");
  assert.equal(ionq.realisticActive.dynamicTop20RealisticBucket, "dte_confirm");
  assert.equal(ionq.realisticActive.eligibleForTop20Confirm, true);
  assert.equal(ionq.realisticActive.eligibleForTop20, false, "pas strict (<5 décisions)");
  assert.equal(ionq.realisticActive.selectedTradeCountGuard, "dte_confirm");
  assert.equal(ionq.realisticDecisionMetrics.selectedTradeCount, 4);
  assert.equal(ionq.assignmentRate, 0);
  assert.ok((dte7.meta.guardrails.dteConfirmInTop20Count ?? 0) >= 1);

  // STRICT7 (6 décisions) reste strict et DEVANT les dte_confirm.
  const strict = dte7.top20.find((r) => r.ticker === "STRICT7");
  assert.ok(strict, "STRICT7 dans le Top DTE 7");
  assert.equal(strict.realisticActive.dynamicTop20RealisticBucket, "strict");
  assert.ok(strict.rank < ionq.rank, "strict placé devant dte_confirm");
});

// ── C — Vue 4 DTE : un profil 3 décisions entre dans le Top DTE ──────────────────
test("C — 4 DTE : FOUR3 (3 décisions, n=6) promu si garde-fous OK", () => {
  const records = dataset();
  const dte4 = buildView(records, 4);

  assert.equal(dte4.meta.dteFilter, 4);
  assert.ok(inTop20(dte4, "FOUR3"), "FOUR3 dans le Top DTE 4");
  const four = dte4.top20.find((r) => r.ticker === "FOUR3");
  assert.equal(four.realisticActive.dynamicTop20RealisticBucket, "dte_confirm");
  assert.equal(four.realisticDecisionMetrics.selectedTradeCount, 3);
  assert.ok(four.n >= 5 && four.n < 10, "plancher observationnel DTE abaissé (5 ≤ n < 10)");

  // LOWN4 : 3 décisions mais n=3 < 5 → échantillon observationnel insuffisant → hors Top.
  assert.equal(inTop20(dte4, "LOWN4"), false, "LOWN4 hors Top (n < 5)");
});

// ── D — selectedTradeCount < 3 reste hors Top même en vue DTE ────────────────────
test("D — 7 DTE : TWODEC (2 décisions) reste hors Top", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);
  assert.equal(inTop20(dte7, "TWODEC"), false, "TWODEC hors Top (2 décisions)");
  assert.notEqual(
    bucketOf(dte7, "TWODEC"),
    "dte_confirm",
    "2 décisions → jamais dte_confirm",
  );
});

// ── E — Rendement réel < 0,5 % reste exclu en vue DTE ────────────────────────────
test("E — 7 DTE : LOWY7 (rendement 0,4 %) reste exclu", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);
  assert.equal(inTop20(dte7, "LOWY7"), false, "LOWY7 hors Top (rendement <0,5 %)");
  assert.equal(bucketOf(dte7, "LOWY7"), "rejected");
});

// ── F — Profondeur réelle > 50 % reste exclue en vue DTE ─────────────────────────
test("F — 7 DTE : DEEP7 (profondeur 100 %) reste exclu", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);
  assert.equal(inTop20(dte7, "DEEP7"), false, "DEEP7 hors Top (profondeur >50 %)");
  assert.equal(bucketOf(dte7, "DEEP7"), "rejected");
});

// ── G — IONQ 7 DTE classé selon le nouveau seuil (Top DTE, à confirmer) ──────────
test("G — IONQ7 : Top DTE en 7 DTE, à confirmer, 4 décisions, 0 % assignation", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);
  const ionq = dte7.top20.find((r) => r.ticker === "IONQ7");
  assert.ok(ionq, "IONQ7 présent dans le Top DTE 7");
  assert.equal(ionq.realisticActive.dynamicTop20RealisticBucket, "dte_confirm");
  assert.equal(ionq.realisticDecisionMetrics.selectedTradeCount, 4);
  assert.equal(ionq.assignmentRate, 0);
  assert.ok(ionq.dynamicTop20Score >= 35, "score réaliste acceptable (≥ seuil exploitable)");
});

// ── H — IONQ 4 DTE / 3 DTE dangereux ou insuffisants ne sont pas promus ──────────
test("H — IONQ4 (échantillon insuffisant) et IONQ3 (dangereux) hors Top DTE", () => {
  const records = dataset();
  const dte4 = buildView(records, 4);
  const dte3 = buildView(records, 3);

  assert.equal(inTop20(dte4, "IONQ4"), false, "IONQ4 hors Top (échantillon insuffisant)");
  assert.notEqual(bucketOf(dte4, "IONQ4"), "dte_confirm");

  assert.equal(inTop20(dte3, "IONQ3"), false, "IONQ3 hors Top (dangereux/insuffisant)");
  assert.notEqual(bucketOf(dte3, "IONQ3"), "dte_confirm");
});

// ── I — Le Top global Tous DTE reste inchangé après calcul des vues DTE ──────────
test("I — vue all identique avant/après calcul des vues DTE", () => {
  const records = dataset();
  const before = buildView(records);
  buildView(records, 7);
  buildView(records, 4);
  buildView(records, 3);
  const after = buildView(records);

  const project = (r) =>
    r.top20.map((row) => ({
      t: row.ticker,
      s: row.dynamicTop20Score,
      b: row.realisticActive?.dynamicTop20RealisticBucket ?? null,
    }));
  assert.deepEqual(project(after), project(before), "Top all stable malgré les vues DTE");
});
