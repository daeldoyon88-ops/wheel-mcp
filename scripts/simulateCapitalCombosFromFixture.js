/**
 * Simulateur capital combos (read-only, pas de réseau).
 *
 * Usage:
 *   node scripts/simulateCapitalCombosFromFixture.js data/fixtures/latest-capital-combo-export.json
 *   node scripts/simulateCapitalCombosFromFixture.js data/fixtures/minimal-capital-combo-replay.json
 *
 * Export JSON doit inclure comboReplayCandidates (Inspecteur Combinaisons → Export JSON après MAJ dashboard).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  formatCapBlockerReason,
} from "../wheel-dashboard/src/capitalComboEngineV2.js";
import { buildPortfolioCombos } from "../wheel-dashboard/src/capitalComboPortfolio.js";

const CAP_GRID = [25500, 30000, 35000, 50000];
const POS_GRID = [5, 6, 8, 10];
const BUCKET_KEYS = ["SAFE", "BALANCED", "AGGRESSIVE"];

function weightedMetricByCapital(picks, pickMetricAccessor) {
  let sumWx = 0;
  let sumW = 0;
  for (const p of picks || []) {
    const w = Number(p?.capitalUsed ?? p?.capitalRequired ?? NaN);
    const x = Number(pickMetricAccessor(p));
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(x)) continue;
    sumWx += x * w;
    sumW += w;
  }
  return sumW > 0 ? sumWx / sumW : null;
}

function loadFixture(filepath) {
  const abs = path.isAbsolute(filepath) ? filepath : path.resolve(process.cwd(), filepath);
  const raw = readFileSync(abs, "utf-8");
  return { abs, payload: JSON.parse(raw) };
}

function mergeOptimizerBase(fixture) {
  const snap = fixture?.optimizerV2FlagsSnapshot ?? {};
  return { ...CAPITAL_COMBO_OPTIMIZER_DEFAULTS, ...snap };
}

function blockerSummaryMain(combo) {
  const rows = combo?.capDiagnosticsV2?.blockerSummaryMerged ?? [];
  return rows.slice(0, 3).map((r) => `${formatCapBlockerReason(r.reason)} × ${r.count ?? 0}`);
}

function tickerConcentrationMax(combo, usedCapital) {
  const m = new Map();
  for (const p of combo?.picks ?? []) {
    const t = String(p?.ticker ?? "").trim().toUpperCase();
    if (!t) continue;
    const w = Number(p?.capitalUsed ?? p?.capitalRequired ?? NaN);
    if (!Number.isFinite(w) || w <= 0) continue;
    m.set(t, (m.get(t) ?? 0) + w);
  }
  const used = usedCapital > 0 ? usedCapital : [...m.values()].reduce((s, x) => s + x, 0);
  if (!(used > 0) || !m.size) return { maxTicker: "", maxPct: 0 };
  let maxTicker = "";
  let maxUsd = -1;
  for (const [t, cap] of m) {
    if (cap > maxUsd) {
      maxUsd = cap;
      maxTicker = t;
    }
  }
  return { maxTicker, maxPct: (maxUsd / used) * 100 };
}

function pickComboByLabel(results, label) {
  const up = label.toUpperCase();
  const found =
    results.find((c) => String(c?.label ?? "").trim().toUpperCase() === up) ?? null;
  return found || null;
}

function buildRow(fixtureLabel, combo, scenario) {
  const usable = scenario.usableCapital;
  const used = combo?.totalCapital ?? 0;
  const freeDeploy = Math.max(0, usable - used);
  const fillPct = usable > 0 ? (used / usable) * 100 : 0;
  const picks = combo?.picks ?? [];
  const prime = picks.reduce((s, p) => s + Number(p.premiumCollected || 0), 0);
  const portRet = usable > 0 ? (prime / usable) * 100 : null;
  const popW = weightedMetricByCapital(picks, (p) => Number(p.popEstimate));
  const otmW = weightedMetricByCapital(picks, (p) => Number(p.distancePct));

  const { maxTicker, maxPct } = tickerConcentrationMax(combo, used);
  const divScore = combo?.diversificationHealthScore ?? null;

  return {
    bucket: combo?.label ?? fixtureLabel.toUpperCase(),
    capitalScenario: scenario.capital,
    maxPositions: scenario.maxPositions,
    leftoverVariant: scenario.leftoverVariant,
    positions: picks.length,
    capitalUsed: used,
    deployableCapital: usable,
    freeCapital: freeDeploy,
    fillPct,
    primeTotal: prime,
    portReturnPct: portRet,
    popMean: popW,
    otmMean: otmW,
    concentrationTickerPct: Number.isFinite(maxPct) ? maxPct : null,
    concentrationTickerSymbol: maxTicker || null,
    diversificationScore01: Number.isFinite(divScore) ? divScore : null,
    tickers: picks.map((p) => `${p.ticker}`).join(", "),
    mainBlockages: blockerSummaryMain(combo),
    capitalShortfallReason: combo?.capitalShortfallReason ?? null,
  };
}

function printTable(rows) {
  /**
   * @type {Record<string,string>}
   */
  const col = {
    bucket: "bucket",
    leftover: "LV2",
    cap: "capital",
    posN: "maxPos",
    npos: "#pos",
    used: "utilisé",
    freeUsd: "libre$",
    freeRel: "libre%",
    fill: "fill%",
    prime: "prime",
    rend: "rend%",
    pop: "POP",
    otm: "OTM",
    cmax: "conc%",
    ticker: "top tk",
    div: "div/100",
    block: "blocages",
    picks: "tickers",
  };

  console.log("");
  console.log(
    `${col.bucket.padEnd(13)} ${col.leftover.padEnd(5)} ${col.cap.padStart(7)} ${col.posN.padStart(7)} ${col.npos.padStart(5)} ` +
      `${col.used.padStart(9)} ${col.freeUsd.padStart(8)} ${col.freeRel.padStart(7)} ${col.fill.padStart(7)} ${col.prime.padStart(8)} ` +
      `${col.rend.padStart(8)} ${col.pop.padStart(6)} ${col.otm.padStart(6)} ${col.cmax.padStart(6)} ` +
      `${col.div.padStart(9)}`,
  );

  const fmtUsd = (n, w = 8) =>
    Number.isFinite(n) ? String(Math.round(Number(n))).padStart(w) : "n/a".padStart(w);
  const fmtPct = (n, w = 7) =>
    Number.isFinite(n) ? `${Number(n).toFixed(1)}%`.padStart(w) : "n/a".padStart(w);
  const fmt2 = (n, w = 8) =>
    Number.isFinite(n) ? `${Number(n).toFixed(2)}%`.padStart(w) : "n/a".padStart(w);
  const fmtInt = (n, w = 7) =>
    Number.isFinite(n) ? String(Math.round(Number(n))).padStart(w) : "n/a".padStart(w);

  for (const r of rows) {
    const bloc = r.mainBlockages.join(" | ").slice(0, 140);
    const freeRel = r.deployableCapital > 0 ? (100 * r.freeCapital) / r.deployableCapital : 0;

    console.log(
      `${String(r.bucket ?? "").slice(0, 12).padEnd(13)} ` +
        `${String(r.leftoverVariant).slice(0, 4).padEnd(5)} ` +
        `${fmtUsd(r.capitalScenario)} ` +
        `${String(r.maxPositions).padStart(7)} ` +
        `${String(r.positions).padStart(5)} ` +
        `${fmtUsd(r.capitalUsed, 9)} ` +
        `${fmtUsd(r.freeCapital, 8)} ` +
        `${fmtPct(freeRel, 7)} ` +
        `${fmtPct(r.fillPct, 7)} ` +
        `${fmtUsd(r.primeTotal)} ` +
        `${fmt2(r.portReturnPct, 8)} ` +
        `${fmtInt(r.popMean, 6)} ` +
        `${fmtInt(r.otmMean, 6)} ` +
        `${fmtInt(r.concentrationTickerPct ?? NaN, 6)} ` +
        `${fmtInt((r.diversificationScore01 ?? NaN) * 100, 9)}`,
    );
    console.log(`  ${col.block}: ${bloc}`);
    console.log(`  ${col.ticker}: ${r.concentrationTickerSymbol ?? "—"}`);
    const tickLine = String(r.tickers || "").slice(0, 460);
    console.log(`  ${col.picks}: ${tickLine}`);
    console.log("");
  }
}

async function main() {
  const positional = process.argv.slice(2).filter(Boolean);
  const filepath = positional[0] ?? "data/fixtures/latest-capital-combo-export.json";

  console.log("");
  console.log("=== Simulateur capital combos — Wheel Dashboard ===");
  console.log("Fichier:", path.resolve(filepath));
  console.log("Grilles: capital [%s] · maxPositions [%s] · leftover Bal/Agg ± Safe", CAP_GRID.join(", "), POS_GRID.join(", "));
  console.log(
    "(SAFE : passe leftover désactivée par défaut tant que safeLeftoverDensityPassEnabled=false — les runs LV2=ON respectent aussi ce flag depuis le fixture.)",
  );

  let payload;
  let abs;
  try {
    ({ abs, payload } = loadFixture(filepath));
  } catch (e) {
    console.error("Impossible de lire le fichier JSON:", e?.message ?? e);
    process.exitCode = 1;
    return;
  }

  const candidates = payload?.comboReplayCandidates;
  const maxPct = Number(payload?.maxCapitalPct);
  const maxPctUse = Number.isFinite(maxPct) && maxPct > 0 ? maxPct : 100;
  const ibkrRejected = Array.isArray(payload?.ibkrRejectedSymbolsSnapshot)
    ? new Set(
        payload.ibkrRejectedSymbolsSnapshot.map((s) =>
          String(s || "").trim().toUpperCase(),
        ).filter(Boolean),
      )
    : new Set();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.warn("");
    console.warn("ERREUR: comboReplayCandidates manquant ou vide.");
    console.warn("- Rouvre une version récente du dashboard, Inspecteur Combinaisons capital → Export JSON.");
    console.warn("- Le fichier téléchargé AVANT cette version ne contient pas les cartes nécessaires.");
    console.warn(`Lecture brute: ${abs}`);
    process.exitCode = 1;
    return;
  }

  const baseOptimizer = mergeOptimizerBase(payload);

  const results = [];

  /** @typedef {{ capital: number, maxPositions: number, leftoverVariant: string, leftoverOn: boolean, usableCapital: number }} Scenario */

  /** @type {Scenario[]} */
  const scenarios = [];
  for (const capitalScenario of CAP_GRID) {
    for (const maxPositions of POS_GRID) {
      const usable = capitalScenario * (maxPctUse / 100);
      scenarios.push({
        capital: capitalScenario,
        maxPositions,
        leftoverVariant: "ON",
        leftoverOn: true,
        usableCapital: usable,
      });
      scenarios.push({
        capital: capitalScenario,
        maxPositions,
        leftoverVariant: "OFF",
        leftoverOn: false,
        usableCapital: usable,
      });
    }
  }

  for (const sc of scenarios) {
    const optimizerV2Override = sc.leftoverOn
      ? { ...baseOptimizer }
      : {
          ...baseOptimizer,
          leftoverDensityPassEnabled: false,
          safeLeftoverDensityPassEnabled: false,
        };

    let combosAll;
    try {
      combosAll = buildPortfolioCombos(
        candidates,
        sc.capital,
        maxPctUse,
        sc.maxPositions,
        ibkrRejected,
        { optimizerV2: optimizerV2Override },
      );
    } catch (e) {
      console.error("Simulation échouée:", e?.message ?? e);
      process.exitCode = 1;
      return;
    }

    if (!Array.isArray(combosAll) || combosAll.length === 0) {
      for (const b of BUCKET_KEYS) {
        results.push({
          bucket: b,
          capitalScenario: sc.capital,
          maxPositions: sc.maxPositions,
          leftoverVariant: sc.leftoverVariant,
          positions: 0,
          capitalUsed: 0,
          deployableCapital: sc.usableCapital,
          freeCapital: sc.usableCapital,
          fillPct: 0,
          primeTotal: 0,
          portReturnPct: null,
          popMean: null,
          otmMean: null,
          concentrationTickerPct: null,
          concentrationTickerSymbol: null,
          diversificationScore01: null,
          tickers: "",
          mainBlockages: ["(aucune combinaison produite pour ce scénario)"],
          capitalShortfallReason: "no_results",
        });
      }
      continue;
    }

    for (const b of BUCKET_KEYS) {
      const combo = pickComboByLabel(combosAll, b);
      if (!combo) {
        results.push({
          bucket: b,
          capitalScenario: sc.capital,
          maxPositions: sc.maxPositions,
          leftoverVariant: sc.leftoverVariant,
          positions: 0,
          capitalUsed: 0,
          deployableCapital: sc.usableCapital,
          freeCapital: sc.usableCapital,
          fillPct: 0,
          primeTotal: 0,
          portReturnPct: null,
          popMean: null,
          otmMean: null,
          concentrationTickerPct: null,
          concentrationTickerSymbol: null,
          diversificationScore01: null,
          tickers: "",
          mainBlockages: [`(${b} absent du résultat moteur)`],
          capitalShortfallReason: "missing_combo",
        });
        continue;
      }
      results.push(buildRow(b, combo, sc));
    }
  }

  printTable(results);

  console.log("");
  console.log(`Total lignes: ${results.length} (${CAP_GRID.length} capitaux × ${POS_GRID.length} maxPos × ${2} leftover × ${BUCKET_KEYS.length} buckets)`);
  console.log("");
  console.log("Notes:");
  console.log("- capital utilisé / libre $ / libre % sont relatifs au cadre déployable (capital × maxCapitalPct), comme le tableau du dashboard.");
  console.log('- colonne LV2 OFF force leftoverDensityPassEnabled=false et safeLeftoverDensityPassEnabled=false');
  console.log('- blocages lisibles en FR avec formatCapBlockerReason du moteur V2.');
  console.log("");
}

await main();
