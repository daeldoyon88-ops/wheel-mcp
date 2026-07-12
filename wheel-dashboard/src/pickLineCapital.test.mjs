import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePickLineCapital,
  resolveDominantTickerCapital,
  resolveDominantFromCapitalRequired,
} from "./pickLineCapital.js";

function deepFreeze(obj, seen = new Set()) {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) return obj;
  seen.add(obj);
  for (const key of Object.keys(obj)) deepFreeze(obj[key], seen);
  return Object.freeze(obj);
}

test("TEST 1 — capitalUsed prioritaire", () => {
  assert.equal(
    resolvePickLineCapital({
      capitalUsed: 3300,
      capitalRequired: 1100,
      capitalPerContract: 1100,
      contracts: 3,
    }),
    3300,
  );
});

test("TEST 2 — fallback capitalPerContract × contracts", () => {
  assert.equal(
    resolvePickLineCapital({ capitalPerContract: 1100, contracts: 3 }),
    3300,
  );
});

test("TEST 3 — fallback capitalRequired × contracts", () => {
  assert.equal(
    resolvePickLineCapital({ capitalRequired: 1100, contracts: 3 }),
    3300,
  );
});

test("TEST 4 — un contrat", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: 4000, capitalRequired: 4000, contracts: 1 }),
    4000,
  );
});

test("TEST 5 — contracts absent", () => {
  assert.equal(resolvePickLineCapital({ capitalRequired: 1100 }), 1100);
});

test("TEST 6 — capitalUsed = 0", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: 0, capitalRequired: 1100, contracts: 3 }),
    0,
  );
});

test("TEST 7 — capitalUsed NaN", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: NaN, capitalRequired: 1100, contracts: 3 }),
    3300,
  );
});

test("TEST 8 — capitalUsed Infinity", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: Infinity, capitalRequired: 1100, contracts: 3 }),
    3300,
  );
});

test("TEST 9 — valeur négative", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: -100, capitalRequired: 1100, contracts: 3 }),
    3300,
  );
  assert.equal(resolvePickLineCapital({ capitalRequired: -500, contracts: 2 }), 0);
});

test("TEST 10 — pick null", () => {
  assert.equal(resolvePickLineCapital(null), 0);
  assert.equal(resolvePickLineCapital(undefined), 0);
});

test("TEST 11 — aucune double multiplication", () => {
  assert.equal(
    resolvePickLineCapital({ capitalUsed: 3300, contracts: 3 }),
    3300,
  );
});

test("TEST 12 — aucune mutation", () => {
  const pick = deepFreeze({
    capitalUsed: 3300,
    capitalRequired: 1100,
    contracts: 3,
    ticker: "NOK",
  });
  assert.equal(resolvePickLineCapital(pick), 3300);
  assert.equal(pick.capitalUsed, 3300);
});

test("TEST 13 — exemple AF-10 NOK/SOFI", () => {
  const picks = [
    { ticker: "NOK", capitalUsed: 3300, capitalRequired: 1100, contracts: 3 },
    { ticker: "SOFI", capitalUsed: 4000, capitalRequired: 4000, contracts: 1 },
  ];
  const dom = resolveDominantTickerCapital(picks);
  assert.equal(dom.ticker, "SOFI");
  assert.ok(Math.abs(dom.pct - (4000 / 7300) * 100) < 1e-9);
  assert.ok(Math.abs(dom.pct - 54.79452054794521) < 1e-9);
});

test("TEST 14 — ancien calcul capitalRequired ≈ 78,43 %", () => {
  const picks = [
    { ticker: "NOK", capitalUsed: 3300, capitalRequired: 1100, contracts: 3 },
    { ticker: "SOFI", capitalUsed: 4000, capitalRequired: 4000, contracts: 1 },
  ];
  const legacy = resolveDominantFromCapitalRequired(picks);
  assert.equal(legacy.ticker, "SOFI");
  assert.ok(Math.abs(legacy.pct - 78.43137254901961) < 1e-9);
  const fixed = resolveDominantTickerCapital(picks);
  assert.ok(Math.abs(fixed.pct - legacy.pct) > 20);
});

test("TEST 15 — même ticker en plusieurs entrées", () => {
  const picks = [
    { ticker: "AAA", capitalUsed: 2000, contracts: 2 },
    { ticker: "AAA", capitalUsed: 1500, contracts: 1 },
    { ticker: "BBB", capitalUsed: 1000, contracts: 1 },
  ];
  const dom = resolveDominantTickerCapital(picks);
  assert.equal(dom.ticker, "AAA");
  assert.equal(dom.capital, 3500);
  assert.ok(Math.abs(dom.pct - (3500 / 4500) * 100) < 1e-9);
});

test("TEST 16 — ordre inversé", () => {
  const a = [
    { ticker: "NOK", capitalUsed: 3300, capitalRequired: 1100, contracts: 3 },
    { ticker: "SOFI", capitalUsed: 4000, capitalRequired: 4000, contracts: 1 },
  ];
  const b = [...a].reverse();
  const d1 = resolveDominantTickerCapital(a);
  const d2 = resolveDominantTickerCapital(b);
  assert.deepEqual(d1, d2);
});

test("TEST 17 — total nul", () => {
  assert.equal(resolveDominantTickerCapital([]), null);
  assert.equal(
    resolveDominantTickerCapital([{ ticker: "X", capitalUsed: 0, contracts: 0 }]),
    null,
  );
});

test("TEST 18 — pourcentage borné", () => {
  const dom = resolveDominantTickerCapital([
    { ticker: "A", capitalUsed: 6000 },
    { ticker: "B", capitalUsed: 4000 },
  ]);
  assert.ok(dom.pct >= 0 && dom.pct <= 100);
  assert.equal(dom.pct, 60);
});

test("TEST 19 — capital par ligne affiché", () => {
  const pick = { capitalUsed: 3300, capitalRequired: 1100, contracts: 3 };
  assert.equal(resolvePickLineCapital(pick), 3300);
});

test("TEST 20 — répétition", () => {
  const pick = { capitalUsed: 3300, capitalRequired: 1100, contracts: 3 };
  const first = resolvePickLineCapital(pick);
  for (let i = 0; i < 20; i++) {
    assert.equal(resolvePickLineCapital(pick), first);
  }
});
