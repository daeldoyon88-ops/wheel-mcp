/**
 * Simulation read-only : permutation AGGRESSIVE baseline ↔ OKLO (aucune exécution, aucun changement live).
 * Réutilise le moteur Capital Combo / VirtualAllocator — seuils inchangés.
 *
 * Usage :
 *   node scripts/aggressiveOkloSwapSimulation.mjs
 *   node scripts/aggressiveOkloSwapSimulation.mjs --scan-json debug/mon-export-scan.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_SCAN_TICKERS } from "../app/config/constants.js";
import {
  auditStampLocal,
  DEFAULT_BUILD_CRITERIA,
  extractShortlistFromExport,
  nextFridayYmd,
  readJsonSafe,
  mapScanItemToComboCandidate,
  buildAggressiveScoredStaging,
  summarizeSnapshotForJson,
  verdictVsBaseline,
  pickBestScenario,
  tryBuildStagedPickFromShortlistRow,
} from "../app/diagnostics/aggressiveComboSimulationShared.mjs";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";

import { buildPortfolioCombos } from "../wheel-dashboard/src/capitalComboPortfolio.js";

import {
  buildCompositionSnapshot,
  VirtualAllocator,
  createBalancedVirtualAllocationScorers,
} from "../wheel-dashboard/src/alternativeCompositionSimV1.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const BASELINE_EXPECTED = ["TQQQ", "SMCI", "SLV", "HOOD", "TTD"];
const SWAP_TARGETS = ["TTD", "SMCI", "SLV", "HOOD"];
const OKLO_SYM = "OKLO";

function parseArgs(argv) {
  const out = {
    expiration: null,
    capital: 25_500,
    maxCapitalPct: 95,
    maxPositions: 8,
    topN: 150,
    sort: "quality",
    scanJsonPath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expiration" && argv[i + 1]) out.expiration = String(argv[++i]).trim();
    else if (a === "--capital" && argv[i + 1]) out.capital = Number(argv[++i]) || out.capital;
    else if (a === "--max-capital-pct" && argv[i + 1]) out.maxCapitalPct = Number(argv[++i]) || out.maxCapitalPct;
    else if (a === "--max-positions" && argv[i + 1]) out.maxPositions = Number(argv[++i]) || out.maxPositions;
    else if (a === "--topN" && argv[i + 1]) out.topN = Number(argv[++i]) || out.topN;
    else if (a === "--scan-json" && argv[i + 1]) out.scanJsonPath = String(argv[++i]).trim();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const expiration = args.expiration || nextFridayYmd();
  const missingData = [];

  let shortlistFull = [];
  let scanResult = { status: 200, payload: { ok: true } };
  let tickersForScan = [];

  if (args.scanJsonPath) {
    const abs = join(REPO_ROOT, args.scanJsonPath);
    const exported = readJsonSafe(abs);
    shortlistFull = extractShortlistFromExport(exported);
    if (!shortlistFull.length) {
      missingData.push(
        `--scan-json=${args.scanJsonPath} : aucune shortlist exploitable (clés attendues : shortlist[], payload.shortlist).`,
      );
    } else {
      missingData.push(`Shortlist figée depuis fichier (pas d’appel Yahoo dans cette exécution) : ${args.scanJsonPath}`);
    }
    tickersForScan = [...new Set(shortlistFull.map((r) => String(r?.symbol || "").trim().toUpperCase()).filter(Boolean))];
  } else {
    const provider = createMarketDataProvider();
    const marketService = createMarketService(provider);
    const watchlistCache = createWatchlistCache();
    const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
    const wheelScanner = createWheelScanner(marketService);

    const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
    const watchlistArr = v3Wl.watchlist || [];

    const fromWl = watchlistArr.map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    const mustInclude = [...BASELINE_EXPECTED, OKLO_SYM];
    /** Toujours inclure baseline + OKLO pour éviter scan vide (watchlist parfois []) ou symboles hors TopN. */
    tickersForScan = [...new Set([...mustInclude, ...fromWl])].slice(0, MAX_SCAN_TICKERS);

    if (fromWl.length === 0) {
      missingData.push(
        "Watchlist builder a retourné 0 symbole — fusion avec baseline+OKLO pour permettre le scan read-only.",
      );
    }

    scanResult = await wheelScanner.scanShortlist({
      expiration,
      tickers: tickersForScan,
      topN: args.topN,
      sort: args.sort,
    });

    if (scanResult.status !== 200 || !scanResult.payload?.ok) {
      const errMsg = scanResult.payload?.error ? String(scanResult.payload.error) : "résultat incomplet";
      missingData.push(`scan_shortlist status=${scanResult.status} — ${errMsg}.`);
    }

    const payload = scanResult.payload || {};
    shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];
  }

  /** Pool candidats pour ce script : même logique que live si passesFilter ; sinon force baseline+OKLO pour permettre le what-if (données étiquetées). */
  const comboCandidates = shortlistFull
    .filter((it) => {
      const sym = String(it?.symbol || "").trim().toUpperCase();
      const pf = it.passesFilter === true;
      const forcedForSim = sym === OKLO_SYM || BASELINE_EXPECTED.includes(sym);
      return pf || forcedForSim;
    })
    .map(mapScanItemToComboCandidate);

  for (const it of shortlistFull) {
    const sym = String(it?.symbol || "").trim().toUpperCase();
    if ((sym === OKLO_SYM || BASELINE_EXPECTED.includes(sym)) && it.passesFilter !== true) {
      missingData.push(
        `${sym} : inclus dans le pool simulation malgré passesFilter=false (réseau/Yahoo ou dérive vs dashboard) — résultats étiquetés read-only.`,
      );
    }
  }

  const scanDiagnosticsV1 = {
    tickersRequestedCount: tickersForScan.length,
    shortlistLength: shortlistFull.length,
    passesFilterTrueCount: shortlistFull.filter((x) => x.passesFilter === true).length,
    comboCandidatePoolSize: comboCandidates.length,
  };

  const staging = buildAggressiveScoredStaging(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const combos = buildPortfolioCombos(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const agg = combos.find((c) => String(c?.label || "").toUpperCase() === "AGGRESSIVE");
  if (!agg || !Array.isArray(agg.picks)) {
    missingData.push("Combo AGGRESSIVE introuvable après buildPortfolioCombos.");
  }

  const usableCapital = staging.usableCapital;
  const grossCapital = args.capital;
  const scoredPool = staging.scoredPool;
  const modeAlloc = staging.modeAlloc;

  const baselinePicks = agg?.picks ?? [];
  const baselineSyms = [...new Set(baselinePicks.map((p) => String(p.ticker).trim().toUpperCase()))].sort();
  const expectedSet = new Set(BASELINE_EXPECTED);
  const baselineSet = new Set(baselineSyms);
  let baselineMatchNote = "ensemble baseline replay == attendu Daël";
  for (const t of BASELINE_EXPECTED) {
    if (!baselineSet.has(t)) {
      baselineMatchNote = `écart vs attendu : manque ${t} dans le replay — marché / classement (${baselineSyms.join(", ")})`;
      missingData.push(baselineMatchNote);
      break;
    }
  }
  for (const t of baselineSyms) {
    if (!expectedSet.has(t)) {
      baselineMatchNote = `écart vs attendu : ticker ${t} dans replay mais pas dans la liste figée`;
      missingData.push(baselineMatchNote);
      break;
    }
  }

  const baseSnap = buildCompositionSnapshot(baselinePicks, usableCapital, grossCapital, scoredPool);

  console.warn(
    `[oklo-swap] baseline premium=${baseSnap.premiumTotalUsd?.toFixed(0) ?? "—"} yield=${baseSnap.weightedYieldPct?.toFixed(3) ?? "—"} pop=${baseSnap.avgPop?.toFixed(2) ?? "—"} capUsed=${baseSnap.usedCapital?.toFixed(0) ?? "—"}`,
  );

  const okloRow = shortlistFull.find((r) => String(r?.symbol || "").trim().toUpperCase() === OKLO_SYM);
  let okloPickResult = null;
  if (!okloRow) {
    missingData.push("OKLO absent de la shortlist scan — impossible de construire la ligne OKLO.");
    console.warn("[oklo-swap] OKLO introuvable dans shortlist — swaps invalidés.");
  } else {
    okloPickResult = tryBuildStagedPickFromShortlistRow(
      okloRow,
      usableCapital,
      modeAlloc,
      staging.poolStats,
      `Simulation swap OKLO — même filtres AGGRESSIVE que le greedy live.`,
      "oklo_swap_replacement",
    );
    if (!okloPickResult.ok) {
      missingData.push(
        `OKLO ne passe pas les gates AGGRESSIVE en replay (${okloPickResult.reason}) — spreads Prime/Yahoo peuvent différer de l’UI.`,
      );
      console.warn(`[oklo-swap] OKLO gates: ${okloPickResult.reason}`);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const scenarios = [];

  scenarios.push({
    id: "baseline_greedy_live_engine",
    replace: null,
    summary: summarizeSnapshotForJson("baseline", baseSnap, baselinePicks, usableCapital, grossCapital),
    picks: baselinePicks.map((p) => ({ ticker: p.ticker, capitalUsd: p.capitalUsed, premiumUsd: p.premiumCollected })),
    verdict: "Référence — allocation greedy actuelle (replay).",
  });

  for (const victim of SWAP_TARGETS) {
    const id = `replace_${victim}_with_OKLO`;
    if (!okloPickResult?.ok) {
      console.warn(`[oklo-swap] replace ${victim} verdict=SKIP (OKLO indisponible ou gates)`);
      scenarios.push({
        id,
        replace: victim,
        skipped: true,
        reason: "OKLO_pick_not_buildable",
        verdict: "SKIP — OKLO non construit.",
      });
      continue;
    }
    const victimUp = victim.trim().toUpperCase();
    const filtered = baselinePicks.filter((p) => String(p.ticker).trim().toUpperCase() !== victimUp);
    if (filtered.length === baselinePicks.length) {
      missingData.push(`Victime « ${victim} » absente du baseline replay — swap ignoré.`);
      console.warn(`[oklo-swap] replace ${victim} verdict=SKIP (absent du baseline)`);
      scenarios.push({ id, replace: victim, skipped: true, reason: "victim_not_in_baseline_replay", verdict: "SKIP." });
      continue;
    }
    const merged = [...filtered, okloPickResult.pick];
    const snap = buildCompositionSnapshot(merged, usableCapital, grossCapital, scoredPool);
    const v = verdictVsBaseline(baseSnap, snap);
    console.warn(`[oklo-swap] replace ${victim} verdict=${v}`);
    scenarios.push({
      id,
      replace: victim,
      summary: summarizeSnapshotForJson(`replace_${victim}`, snap, merged, usableCapital, grossCapital),
      picks: merged.map((p) => ({ ticker: p.ticker, capitalUsd: p.capitalUsed, premiumUsd: p.premiumCollected })),
      verdict: v,
    });
  }

  let forceFirstScenario = null;
  if (!okloPickResult?.ok) {
    console.warn("[oklo-swap] force OKLO first verdict=SKIP (OKLO indisponible ou gates)");
    forceFirstScenario = {
      id: "force_oklo_first_reoptimize",
      skipped: true,
      verdict: "SKIP — OKLO non construit.",
    };
  } else {
    const mem = new VirtualAllocator(
      scoredPool,
      modeAlloc,
      usableCapital,
      staging.maxPositionLines,
      staging.minTargetPositions,
    );
    const { primaryScoreFn, fillerScoreFn } = createBalancedVirtualAllocationScorers(usableCapital);
    const picksForced = mem.runSimulation("aggressive", primaryScoreFn, fillerScoreFn, 95, OKLO_SYM);
    const snapF = buildCompositionSnapshot(picksForced, usableCapital, grossCapital, scoredPool);
    const vf = verdictVsBaseline(baseSnap, snapF);
    console.warn(`[oklo-swap] force OKLO first verdict=${vf}`);
    forceFirstScenario = {
      id: "force_oklo_first_reoptimize",
      summary: summarizeSnapshotForJson("force_oklo_first", snapF, picksForced, usableCapital, grossCapital),
      picks: picksForced.map((p) => ({ ticker: p.ticker, capitalUsd: p.capitalUsed, premiumUsd: p.premiumCollected })),
      verdict: vf,
      noteFr:
        "VirtualAllocator (scorers balanced myopes) avec première sélection forcée OKLO si evaluateCandidate OK — approximation read-only du « réoptimiser le reste ».",
    };
    scenarios.push(forceFirstScenario);
  }

  const comparable = scenarios.filter((s) => s.summary && !s.skipped);
  const best = pickBestScenario(comparable);
  console.warn(
    `[oklo-swap] best=${best?.id ?? "—"} score=${best?.summary?.simCompositePortfolioScore?.toFixed(2) ?? "—"}`,
  );

  mkdirSync(join(REPO_ROOT, "debug"), { recursive: true });
  const outPath = join(REPO_ROOT, "debug", `aggressive-oklo-swap-simulation-${auditStampLocal()}.json`);
  const exportPayload = {
    simulationOnly: true,
    exportedAt: new Date().toISOString(),
    expiration,
    capitalGrossUsd: args.capital,
    maxCapitalPct: args.maxCapitalPct,
    maxPositions: args.maxPositions,
    scanDiagnosticsV1,
    inputSource: args.scanJsonPath ? `scan_json_file:${args.scanJsonPath}` : "yahoo_scan_shortlist_live",
    baselineExpectedTickers: BASELINE_EXPECTED,
    baselineReplayTickers: baselineSyms,
    baselineReplayNote: baselineMatchNote,
    missingData,
    okloScanGate: okloPickResult?.ok
      ? { ok: true }
      : {
          ok: false,
          reason: okloPickResult?.reason ?? "OKLO_row_missing",
          blockerHintFr: "near-miss live souvent contract_size_too_large en fin de greedy",
        },
    scenarios,
    bestScenarioId: best?.id ?? null,
    interpretationFr:
      "Les scénarios « replace » gardent les autres lignes du baseline greedy figé et substituent une jambe OKLO passant les filtres AGGRESSIVE au même instant Yahoo — pas une réallocation globale sauf « force OKLO first » (VirtualAllocator).",
  };

  writeFileSync(outPath, JSON.stringify(exportPayload, null, 2), "utf8");
  console.warn(`[oklo-swap] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
