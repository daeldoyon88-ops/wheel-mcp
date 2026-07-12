/**
 * AF-18 — Tests parsing strict des flags Optimizer V2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY,
  CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA,
  normalizeCapitalOptimizerV2Boolean,
  normalizeCapitalOptimizerV2Number,
  normalizeCapitalOptimizerV2Flags,
  resolveCapitalOptimizerV2Flags,
  parseCapitalOptimizerV2FlagsFromJson,
  readCapitalOptimizerV2FlagsFromLocalStorage,
} from "./capitalComboEngineV2.js";

function frozenEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function defaultsSnapshot() {
  return { ...CAPITAL_COMBO_OPTIMIZER_DEFAULTS };
}

// ── A. Defaults et structure ─────────────────────────────────────────────────

test("A1 defaults inchangés", () => {
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverDensityPassEnabled, true);
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.safeLeftoverDensityPassEnabled, false);
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.capDiagnosticsEnabled, true);
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.maxLeftoverIterations, 22);
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinPctOfUsable, 0.012);
  assert.equal(CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinAbsoluteUsd, 320);
});

test("A2 resolver sans argument retourne defaults", () => {
  assert.ok(frozenEqual(resolveCapitalOptimizerV2Flags(), defaultsSnapshot()));
  assert.ok(frozenEqual(resolveCapitalOptimizerV2Flags(undefined), defaultsSnapshot()));
  assert.ok(frozenEqual(resolveCapitalOptimizerV2Flags(null), defaultsSnapshot()));
});

test("A3 objet vide retourne defaults", () => {
  assert.ok(frozenEqual(normalizeCapitalOptimizerV2Flags({}), defaultsSnapshot()));
  assert.ok(frozenEqual(resolveCapitalOptimizerV2Flags({}), defaultsSnapshot()));
});

test("A4 clés inconnues ignorées", () => {
  const r = normalizeCapitalOptimizerV2Flags({ unknownFlag: true, leftoverDensityPassEnabled: false });
  assert.equal(r.leftoverDensityPassEnabled, false);
  assert.equal("unknownFlag" in r, false);
});

test("A5 defaults non mutés", () => {
  const before = defaultsSnapshot();
  normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: false });
  assert.ok(frozenEqual(CAPITAL_COMBO_OPTIMIZER_DEFAULTS, before));
});

test("A6 input non muté", () => {
  const input = { leftoverDensityPassEnabled: false, extra: 1 };
  const copy = { ...input };
  normalizeCapitalOptimizerV2Flags(input);
  assert.deepEqual(input, copy);
});

test("schéma — 6 flags connus", () => {
  assert.equal(Object.keys(CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA).length, 6);
  assert.equal(Object.keys(CAPITAL_COMBO_OPTIMIZER_DEFAULTS).length, 6);
});

test("A7 cohérence bijective DEFAULTS ↔ FLAG_SCHEMA", () => {
  const defaultKeys = Object.keys(CAPITAL_COMBO_OPTIMIZER_DEFAULTS).sort();
  const schemaKeys = Object.keys(CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA).sort();
  assert.deepEqual(defaultKeys, schemaKeys, "chaque default doit avoir une entrée schéma et réciproquement");
  for (const key of defaultKeys) {
    assert.ok(key in CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA, `schéma manquant pour ${key}`);
    assert.ok(key in CAPITAL_COMBO_OPTIMIZER_DEFAULTS, `default manquant pour ${key}`);
    const schema = CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA[key];
    const def = CAPITAL_COMBO_OPTIMIZER_DEFAULTS[key];
    if (schema.type === "boolean") assert.equal(typeof def, "boolean");
    if (schema.type === "number") assert.equal(typeof def, "number");
  }
});

test("A8 normalizeCapitalOptimizerV2Flags couvre toutes les clés DEFAULTS", () => {
  const normalized = normalizeCapitalOptimizerV2Flags({});
  for (const key of Object.keys(CAPITAL_COMBO_OPTIMIZER_DEFAULTS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(normalized, key), `clé manquante: ${key}`);
    assert.equal(normalized[key], CAPITAL_COMBO_OPTIMIZER_DEFAULTS[key]);
  }
});

test("A9 readCapitalOptimizerV2FlagsFromLocalStorage — nouvel objet, contenu stable", () => {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  store.set(CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY, JSON.stringify({ leftoverDensityPassEnabled: false }));
  const a = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  const b = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  assert.notEqual(a, b, "nouvel objet à chaque appel");
  assert.ok(frozenEqual(a, b), "contenu identique pour LS identique");
  assert.equal(a.leftoverDensityPassEnabled, false);
});

test("clé localStorage exportée", () => {
  assert.equal(CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY, "wheelCapitalComboOptimizerV2Flags");
});

// ── B. Booléens (leftoverDensityPassEnabled représentatif) ───────────────────

const BOOL_TRUE = [true, "true", "TRUE", 1, "1"];
const BOOL_FALSE = [false, "false", "FALSE", 0, "0"];
const BOOL_DEFAULT = ["", "maybe", null, undefined, {}, [], 2, -1];

for (const v of BOOL_TRUE) {
  test(`B leftoverDensityPassEnabled true ← ${JSON.stringify(v)}`, () => {
    const r = normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: v });
    assert.equal(r.leftoverDensityPassEnabled, true);
  });
}

for (const v of BOOL_FALSE) {
  test(`B leftoverDensityPassEnabled false ← ${JSON.stringify(v)}`, () => {
    const r = normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: v });
    assert.equal(r.leftoverDensityPassEnabled, false);
  });
}

for (const v of BOOL_DEFAULT) {
  test(`B leftoverDensityPassEnabled défaut ← ${JSON.stringify(v)}`, () => {
    const r = normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: v });
    assert.equal(r.leftoverDensityPassEnabled, true);
  });
}

test("B safeLeftoverDensityPassEnabled — parsing strict comme autres booléens", () => {
  assert.equal(normalizeCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: true }).safeLeftoverDensityPassEnabled, true);
  assert.equal(normalizeCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: "true" }).safeLeftoverDensityPassEnabled, true);
  assert.equal(normalizeCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: 1 }).safeLeftoverDensityPassEnabled, true);
  assert.equal(normalizeCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: false }).safeLeftoverDensityPassEnabled, false);
  assert.equal(normalizeCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: "false" }).safeLeftoverDensityPassEnabled, false);
});

test("B normalizeCapitalOptimizerV2Boolean unitaire", () => {
  assert.equal(normalizeCapitalOptimizerV2Boolean("false", true), false);
  assert.equal(normalizeCapitalOptimizerV2Boolean("FALSE", true), false);
  assert.equal(normalizeCapitalOptimizerV2Boolean("0", true), false);
  assert.equal(normalizeCapitalOptimizerV2Boolean("true", false), true);
});

// ── C. Nombres ───────────────────────────────────────────────────────────────

test("C maxLeftoverIterations valide", () => {
  assert.equal(normalizeCapitalOptimizerV2Flags({ maxLeftoverIterations: 10 }).maxLeftoverIterations, 10);
  assert.equal(normalizeCapitalOptimizerV2Flags({ maxLeftoverIterations: "15" }).maxLeftoverIterations, 15);
});

test("C maxLeftoverIterations invalide → défaut", () => {
  for (const v of [0, -5, NaN, Infinity, -Infinity, "", "abc", null, undefined, 99999]) {
    const r = normalizeCapitalOptimizerV2Flags({ maxLeftoverIterations: v });
    assert.equal(r.maxLeftoverIterations, 22, `fallback pour ${JSON.stringify(v)}`);
  }
});

test("C leftoverMinPctOfUsable bornes", () => {
  assert.equal(normalizeCapitalOptimizerV2Flags({ leftoverMinPctOfUsable: 0.05 }).leftoverMinPctOfUsable, 0.05);
  assert.equal(normalizeCapitalOptimizerV2Flags({ leftoverMinPctOfUsable: -0.1 }).leftoverMinPctOfUsable, 0.012);
  assert.equal(normalizeCapitalOptimizerV2Flags({ leftoverMinPctOfUsable: 2 }).leftoverMinPctOfUsable, 0.012);
});

test("C leftoverMinAbsoluteUsd bornes", () => {
  assert.equal(normalizeCapitalOptimizerV2Flags({ leftoverMinAbsoluteUsd: 500 }).leftoverMinAbsoluteUsd, 500);
  assert.equal(normalizeCapitalOptimizerV2Flags({ leftoverMinAbsoluteUsd: -1 }).leftoverMinAbsoluteUsd, 320);
});

test("C normalizeCapitalOptimizerV2Number unitaire", () => {
  assert.equal(normalizeCapitalOptimizerV2Number("12.5", 0, { min: 0, max: 100 }), 12.5);
  assert.equal(normalizeCapitalOptimizerV2Number(NaN, 7, { min: 0 }), 7);
});

// ── D. JSON localStorage ─────────────────────────────────────────────────────

test("D clé absente → defaults", () => {
  const ls = { getItem: () => null };
  assert.ok(frozenEqual(readCapitalOptimizerV2FlagsFromLocalStorage(ls), defaultsSnapshot()));
});

test("D JSON valide objet", () => {
  const raw = JSON.stringify({ leftoverDensityPassEnabled: false });
  assert.ok(frozenEqual(parseCapitalOptimizerV2FlagsFromJson(raw), {
    ...defaultsSnapshot(),
    leftoverDensityPassEnabled: false,
  }));
});

test("D JSON invalide", () => {
  assert.ok(frozenEqual(parseCapitalOptimizerV2FlagsFromJson("{bad"), defaultsSnapshot()));
});

for (const raw of ["true", "false", "42", '"x"', "[]", "null"]) {
  test(`D JSON non-objet ${raw} → defaults`, () => {
    assert.ok(frozenEqual(parseCapitalOptimizerV2FlagsFromJson(raw), defaultsSnapshot()));
  });
}

test("D objet avec clé inconnue", () => {
  const r = parseCapitalOptimizerV2FlagsFromJson('{"unknownFlag":true,"capDiagnosticsEnabled":false}');
  assert.equal(r.capDiagnosticsEnabled, false);
  assert.equal("unknownFlag" in r, false);
});

test("D objet avec string false pour booléen", () => {
  const r = parseCapitalOptimizerV2FlagsFromJson('{"leftoverDensityPassEnabled":"false"}');
  assert.equal(r.leftoverDensityPassEnabled, false);
});

test("D objet avec string 0 pour booléen", () => {
  const r = parseCapitalOptimizerV2FlagsFromJson('{"leftoverDensityPassEnabled":"0"}');
  assert.equal(r.leftoverDensityPassEnabled, false);
});

// ── E. Priorité (resolver pur) ───────────────────────────────────────────────

test("E options true contre override false dans même objet", () => {
  const r = normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: true });
  assert.equal(r.leftoverDensityPassEnabled, true);
});

test("E options false explicites", () => {
  const r = resolveCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: false });
  assert.equal(r.leftoverDensityPassEnabled, false);
});

test("E objet vide → defaults, pas de fusion localStorage", () => {
  const ls = {
    getItem: () => JSON.stringify({ leftoverDensityPassEnabled: false }),
  };
  const fromResolver = resolveCapitalOptimizerV2Flags({});
  const fromLs = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  assert.equal(fromResolver.leftoverDensityPassEnabled, true);
  assert.equal(fromLs.leftoverDensityPassEnabled, false);
});

test("E sans options → defaults déterministes", () => {
  const a = resolveCapitalOptimizerV2Flags();
  const b = resolveCapitalOptimizerV2Flags(undefined);
  assert.ok(frozenEqual(a, b));
});

// ── F. Environnements ───────────────────────────────────────────────────────

test("F Node sans localStorage", () => {
  const prev = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.ok(frozenEqual(readCapitalOptimizerV2FlagsFromLocalStorage(), defaultsSnapshot()));
  } finally {
    if (prev !== undefined) globalThis.localStorage = prev;
  }
});

test("F navigateur simulé", () => {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  ls.setItem(CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY, JSON.stringify({ safeLeftoverDensityPassEnabled: true }));
  const r = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  assert.equal(r.safeLeftoverDensityPassEnabled, true);
});

test("F getItem exception → defaults sans crash", () => {
  const ls = { getItem: () => { throw new Error("boom"); } };
  assert.ok(frozenEqual(readCapitalOptimizerV2FlagsFromLocalStorage(ls), defaultsSnapshot()));
});

test("F localStorage getter exception → defaults sans crash", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assert.ok(frozenEqual(readCapitalOptimizerV2FlagsFromLocalStorage(), defaultsSnapshot()));
  } finally {
    delete globalThis.localStorage;
  }
});

test("F config effective identique Node vs simulé", () => {
  const raw = JSON.stringify({ leftoverDensityPassEnabled: false, maxLeftoverIterations: 5 });
  const ls = { getItem: () => raw };
  const fromSim = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  const fromParse = parseCapitalOptimizerV2FlagsFromJson(raw);
  assert.ok(frozenEqual(fromSim, fromParse));
});
