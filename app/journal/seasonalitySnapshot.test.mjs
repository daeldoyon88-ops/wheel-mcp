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

// ── 8b. Patch V2 : champs décisionnels séparés (fixture TQQQ-like) ────────────
// Bundle calibré pour reproduire l'écran décisionnel TQQQ : weekly 44, fenêtre
// annuelle haussière forte robuste (score 87) « 15 avr. → 15 juil. ».
const TQQQ_V2_BUNDLE = {
  shortTermData: {
    calendarWeek: {
      sampleSize: 12, // confidence "mesurable"
      winRate: 0.5, // 12 pts
      medianReturn: 0.02, // 20 pts
      downsideRisk5: 0.25, // 12 pts
      worstReturn: -0.3, // 0 pt → total 44
      positiveYears: 6,
    },
    windows: [{ days: 7, winRate: 0.5, pctBelow5: 0.25, pctAbove5: 0.25 }],
  },
  windowsData: {
    annualDisplayWindows: {
      bullish: [
        {
          displayLabel: "15 avr. → 15 juil.",
          startMonth: 4, startDay: 15, endMonth: 7, endDay: 15,
          strength: "Forte",
          annualHorizons: {
            "15y": { insufficient: false, yearsCount: 15, winRateAnnual: 0.8, avgReturnAnnual: 0.05 },
          },
        },
      ],
    },
  },
};

test("buildSnapshotFromBundle expose les champs V2 sans changer seasonality_score_at_scan", () => {
  const today = new Date("2026-06-05T12:00:00.000Z");
  const snap = buildSnapshotFromBundle(TQQQ_V2_BUNDLE, { computedAt: "2026-06-05", today });
  assert.ok(snap, "snapshot should be non-null");

  // weekly = 44 ET seasonality_score_at_scan reste 44 (compat ascendante).
  assert.equal(snap.seasonality_weekly_score_at_scan, 44);
  assert.equal(snap.seasonality_score_at_scan, 44);
  assert.equal(snap.seasonality_weekly_win_rate_at_scan, snap.seasonality_win_rate_at_scan);

  // fenêtre annuelle active : score 87, label, win rate.
  assert.equal(snap.seasonality_annual_score_at_scan, 87);
  assert.equal(snap.seasonality_annual_window_label_at_scan, "15 avr. → 15 juil.");
  assert.equal(snap.seasonality_annual_win_rate_at_scan, 0.8);

  // CSP / CC : nombres dérivés du header (calculés neutres sans contexte).
  assert.equal(typeof snap.seasonality_csp_score_at_scan, "number");
  assert.equal(typeof snap.seasonality_cc_score_at_scan, "number");

  // Verdict + contexte lisibles.
  assert.equal(typeof snap.seasonality_wheel_verdict_at_scan, "string");
  assert.equal(
    snap.seasonality_context_at_scan,
    "Fenêtre annuelle favorable, score court terme neutre."
  );
});

test("buildSnapshotFromBundle : champs V2 annuels NULL si aucune fenêtre active", () => {
  // VALID_BUNDLE sans `today` actif sur la fenêtre → pas de fenêtre annuelle active.
  const today = new Date("2026-01-15T12:00:00.000Z"); // hors 05-15 → 08-15
  const snap = buildSnapshotFromBundle(VALID_BUNDLE, { computedAt: "2026-06-05", today });
  assert.ok(snap);
  assert.equal(snap.seasonality_annual_score_at_scan, null);
  assert.equal(snap.seasonality_annual_win_rate_at_scan, null);
  assert.equal(snap.seasonality_annual_window_label_at_scan, null);
  // weekly inchangé / présent
  assert.equal(typeof snap.seasonality_weekly_score_at_scan, "number");
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
