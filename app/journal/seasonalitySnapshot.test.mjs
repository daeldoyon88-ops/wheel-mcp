import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildSnapshotFromBundle,
  buildSeasonalitySnapshotFromCache,
  nullSeasonalitySnapshot,
  SEASONALITY_SNAPSHOT_VERSION,
} from "./seasonalitySnapshot.js";

// Bundle caché réaliste : calendarWeek robuste + une fenêtre annuelle bullish.
const VALID_BUNDLE = {
  shortTermData: {
    calendarWeek: {
      sampleSize: 12,
      winRate: 0.7,
      averageReturn: 0.02,
      medianReturn: 0.018,
      downsideRisk5: 0.1,
      worstReturn: -0.1,
      positiveYears: 8,
    },
    windows: [{ days: 7, winRate: 0.6 }],
  },
  windowsData: {
    annualDisplayWindows: {
      bullish: [
        { displayLabel: "Mi-mai → Mi-août", startMonth: 5, startDay: 15, endMonth: 8, endDay: 15 },
      ],
    },
  },
};

// ── 1. cache valide → seasonality_* non null ──────────────────────────────────
test("buildSnapshotFromBundle remplit les 7 champs depuis un bundle valide", () => {
  const snap = buildSnapshotFromBundle(VALID_BUNDLE, { computedAt: "2026-06-05" });
  assert.ok(snap, "snapshot should be non-null");
  assert.equal(typeof snap.seasonality_score_at_scan, "number");
  assert.ok(snap.seasonality_score_at_scan >= 0 && snap.seasonality_score_at_scan <= 100);
  assert.equal(snap.seasonality_win_rate_at_scan, 0.7);
  assert.equal(snap.seasonality_best_window_start, "05-15");
  assert.equal(snap.seasonality_best_window_end, "08-15");
  assert.ok(["favorable", "neutre", "défavorable"].includes(snap.seasonality_direction));
  assert.equal(typeof snap.seasonality_confidence, "string");
  assert.equal(snap.seasonality_snapshot_version, `${SEASONALITY_SNAPSHOT_VERSION}@2026-06-05`);
});

// ── 2. fallback win rate 7j quand calendarWeek absent ─────────────────────────
test("readWinRate retombe sur la fenêtre 7j si calendarWeek absent", () => {
  const bundle = {
    shortTermData: { windows: [{ days: 7, winRate: 0.55 }] },
    windowsData: VALID_BUNDLE.windowsData,
  };
  const snap = buildSnapshotFromBundle(bundle, { computedAt: "2026-06-05" });
  assert.ok(snap);
  assert.equal(snap.seasonality_win_rate_at_scan, 0.55);
});

// ── 3. bundle vide / null → snapshot null (pas d'invention de données) ─────────
test("buildSnapshotFromBundle retourne null si rien d'exploitable", () => {
  assert.equal(buildSnapshotFromBundle(null), null);
  assert.equal(buildSnapshotFromBundle({}), null);
  assert.equal(buildSnapshotFromBundle({ shortTermData: null, windowsData: null }), null);
});

// ── 4. cache absent → null, capture peut continuer ────────────────────────────
test("buildSeasonalitySnapshotFromCache → null quand le cache est vide", () => {
  const stubCache = { getCache: () => null };
  assert.equal(buildSeasonalitySnapshotFromCache("TQQQ", { cache: stubCache }), null);
});

// ── 5. cache valide via getCache → seasonality_* non null ─────────────────────
test("buildSeasonalitySnapshotFromCache lit le cache et mappe le snapshot", () => {
  const stubCache = {
    getCache: () => ({ payload: VALID_BUNDLE, computedAt: "2026-06-05" }),
  };
  const snap = buildSeasonalitySnapshotFromCache("TQQQ", { cache: stubCache });
  assert.ok(snap);
  assert.equal(typeof snap.seasonality_score_at_scan, "number");
  assert.equal(snap.seasonality_best_window_start, "05-15");
});

// ── 6. cache corrompu / getCache qui jette → null, aucune erreur propagée ──────
test("buildSeasonalitySnapshotFromCache avale les erreurs (best-effort)", () => {
  const throwingCache = {
    getCache: () => {
      throw new Error("corrupt row");
    },
  };
  assert.doesNotThrow(() => buildSeasonalitySnapshotFromCache("TQQQ", { cache: throwingCache }));
  assert.equal(buildSeasonalitySnapshotFromCache("TQQQ", { cache: throwingCache }), null);
});

// ── 7. symbole vide → null ────────────────────────────────────────────────────
test("buildSeasonalitySnapshotFromCache → null pour un symbole vide", () => {
  assert.equal(buildSeasonalitySnapshotFromCache("", { cache: { getCache: () => null } }), null);
  assert.equal(buildSeasonalitySnapshotFromCache(null, { cache: { getCache: () => null } }), null);
});

// ── 8. nullSeasonalitySnapshot expose bien les 7 champs à null ────────────────
test("nullSeasonalitySnapshot retourne les 7 champs à null", () => {
  const n = nullSeasonalitySnapshot();
  assert.deepEqual(n, {
    seasonality_score_at_scan: null,
    seasonality_win_rate_at_scan: null,
    seasonality_best_window_start: null,
    seasonality_best_window_end: null,
    seasonality_direction: null,
    seasonality_confidence: null,
    seasonality_snapshot_version: null,
  });
});

// ── 9. PREUVE : aucun appel Yahoo / réseau possible depuis le helper ──────────
test("le helper ne référence aucun import réseau / Yahoo ni appel live", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "seasonalitySnapshot.js"), "utf8");
  // On cible les IMPORTS et USAGES réels (pas les commentaires de doc).
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
  for (const line of importLines) {
    assert.doesNotMatch(line, /yahoo/i, `import réseau Yahoo interdit: ${line}`);
    assert.doesNotMatch(line, /axios|undici|node-fetch|node:https?/, `client HTTP interdit: ${line}`);
  }
  // Code sans commentaires (on ne veut pas matcher la doc qui mentionne ces noms).
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /\bfetch\s*\(/, "aucun appel fetch(");
  assert.doesNotMatch(codeOnly, /computeSeasonalityBundle\s*\(/, "aucun appel computeSeasonalityBundle()");
  // Seuls deux imports attendus : le cache persistant et les scores (purs).
  assert.equal(importLines.length, 2, "exactement 2 imports attendus");
});
