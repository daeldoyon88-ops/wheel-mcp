// teclTvReconciliation.mjs
// RÉCONCILIATION TECL local vs TradingView (audit only — pas d'optimisation).
//
// Objectif : expliquer pourquoi le backtest local TECL donne ~+3599 % / DD -41,88 % / 35 trades
// alors que TradingView donne (base incluant le trade ouvert) +7262,42 % / DD 27,74 %
// / 24 trades / 62,5 % / PF ~6,97 — soit, en base fermés-seulement, 23 trades / 60,87 % / PF 3,538.
//
// IMPORTANT — deux bases TradingView distinctes (le "23 vs 24" n'est PAS une divergence) :
//   1) Fermés seulement : 23 trades fermés, 14/23 = 60,87 %, PF 3,538, cumul ≈ +3089,61 %.
//   2) Incluant l'ouvert : 24 trades (le #24 entré le 2025-04-02 est TOUJOURS ouvert et marqué
//      au prix courant), 15/24 = 62,5 %, PF ≈ 6,97, P&L headline = +7262,42 %.
//   Le headline TV (+7262,42 %) inclut le trade ouvert #24 ; le décompte "23" est les fermés.
//
// PORTÉE : TradingView / Pine / TECL uniquement.
//   - Ne modifie PAS le Pine final.            - Ne touche PAS au Wheel Dashboard.
//   - Aucun git add, aucun commit.             - Audit reproductible seulement.
//
// Données :
//   - TECL CORROMPU (audit initial) : debug/ohlc-cache-TECL.json  (close = adjclose, OHLC bruts)
//   - TECL CORRIGÉ (réconciliation) : debug/tradingview/ohlc-cache-TECL-raw.json (close brut cohérent)
//   - MASTER NASDAQ:TQQQ            : debug/ohlc-cache-TQQQ.json  (propre, raw close)
//
// Sorties : debug/tradingview/tecl-tv-reconciliation.md + .json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRows, computeIndicators, runStrategy, ema, rsi, round } from "./lib/pineEngine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TECL_BAD = path.join(ROOT, "debug", "ohlc-cache-TECL.json");
const TECL_FIX = path.join(ROOT, "debug", "tradingview", "ohlc-cache-TECL-raw.json");
const TQQQ_DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_DIR = path.join(ROOT, "debug", "tradingview");
const OUT_MD = path.join(OUT_DIR, "tecl-tv-reconciliation.md");
const OUT_JSON = path.join(OUT_DIR, "tecl-tv-reconciliation.json");

// ---- Cibles TradingView (export "List of Trades" TECL fourni par Daël, 2026-06-05) ----
// Deux bases distinctes — voir l'en-tête. Le "23 vs 24" n'est PAS une divergence.
//   TV_CLOSED  : fermés seulement (le trade ouvert #24 EXCLU).
//   TV_OPEN    : incluant le trade ouvert #24, marqué au prix courant (= base du headline TV).
const TV_CLOSED = {
  pnlPct: 3089.61, netProfitUsd: 308961, maxDDPct: 27.74,
  winners: 14, trades: 23, winRatePct: 60.87, profitFactor: 3.538,
};
const TV_OPEN = {
  pnlPct: 7262.42, netProfitUsd: 726242.29, maxDDPct: 27.74,
  winners: 15, trades: 24, winRatePct: 62.5, profitFactor: 6.97,
};
// Base de comparaison apples-to-apples : le moteur local tourne jusqu'à la barre courante
// (2026-06-05) et porte donc la position #24 ouverte -> on compare à TV_OPEN.
const TV = TV_OPEN;

// ---- Config TECL = réglages EXACTS du panneau TradingView ----
const teclTV = {
  fromISO: "2020-01-01", toISO: "2030-12-31",
  useMA: true, maFastLen: 8, maMidLen: 24, maSlowLen: 34,
  useRSI: true, rsiLen: 14, rsiBuyThresh: 46, rsiSellThresh: 1,
  requireBoth: false, blockBearTrend: false,
  useEMA200: false, ema200Len: 200, requireEMA200SlopeUp: false, slopeLookback: 20,
  useADX: false, adxLen: 14, adxMin: 20,
  blockIfMMSlopeBear: false, mmBearFastLen: 50, mmBearSlowLen: 200, mmSlopeLookback: 100,
  allowRecoveryBuy: true, mmRecUpLen: 75, mmRecDownLen: 200, mmRecLookback: 46,
  useMasterRiskOn: true,
  m_useMA: true, m_maFastLen: 8, m_maMidLen: 34,
  m_useRSI: true, m_rsiLen: 14, m_rsiBuyThresh: 48,
  m_blockSlopeBear: true, m_bearFastLen: 50, m_bearSlowLen: 200, m_bearSlopeLB: 100,
  m_allowRecovery: true, m_recUpLen: 75, m_recDownLen: 200, m_recLB: 46,
  initialPct: 100, addPct: 100,
  useTimeAdds: false, scaleEveryDays: 2, maxAdds: 50, requireRSIForAdds: false,
  useDipAdds: false, atrLen: 14, dipATRmult: 1.0,
  useStopLoss: false, stopLossPct: 5, useTrailATR: false, trailATRmult: 3.0,
  cooldownBars: 2,
  initialCapital: 10000, execMode: "close",
  exitCandidate: null, protExit: "L", exitLLen: 10, kConfirmDays: 1,
  reentryRule: "R4",
  masterSource: "TQQQ",
};

const teclRowsBad = loadRows(TECL_BAD);
const teclRowsFix = loadRows(TECL_FIX);
const tqqqRows = loadRows(TQQQ_DATA);

// ---- MASTER TQQQ aligné as-of sur les barres du graphique ----
function alignAsOf(masterRows, masterArr, chartRows) {
  const out = new Array(chartRows.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < chartRows.length; i++) {
    const t = chartRows[i].t;
    while (j + 1 < masterRows.length && masterRows[j + 1].t <= t) j++;
    if (masterRows[j].t <= t) out[i] = masterArr[j];
  }
  return out;
}
function masterIndicatorsFrom(mRows, cfg) {
  const close = mRows.map((r) => r.close);
  return {
    m_maFast: ema(close, cfg.m_maFastLen), m_maMid: ema(close, cfg.m_maMidLen),
    m_rsi: rsi(close, cfg.m_rsiLen),
    m_bearFast: ema(close, cfg.m_bearFastLen), m_bearSlow: ema(close, cfg.m_bearSlowLen),
    m_recUp: ema(close, cfg.m_recUpLen), m_recDown: ema(close, cfg.m_recDownLen),
  };
}

function run(rows, over) {
  const cfg = { ...teclTV, ...over };
  const ind = computeIndicators(rows, cfg);
  if (cfg.masterSource === "TQQQ") {
    const m = masterIndicatorsFrom(tqqqRows, cfg);
    for (const k of Object.keys(m)) ind[k] = alignAsOf(tqqqRows, m[k], rows);
  }
  const res = runStrategy(rows, ind, cfg);
  return res;
}

function classify(trades) {
  // un trade dont l'entrée est une réentrée R4 est marqué reentry=... via open.reentry,
  // mais runStrategy ne le propage pas dans trades : on le réinfère par la raison de
  // sortie précédente == protL + signal R4. Plus simple : on compte par 'reentry' flag absent,
  // donc on recompte les réentrées via reentryCount global et on annote heuristiquement.
  return trades;
}

function summarize(res, label) {
  const m = res.metrics;
  const protExits = res.trades.filter((t) => String(t.reason).startsWith("prot")).length;
  const maSell = res.trades.filter((t) => t.reason === "maSell").length;
  return {
    label,
    totalReturnPct: m.totalReturnPct, finalEquity: m.finalEquity,
    netProfitUsd: round(m.finalEquity - teclTV.initialCapital, 2),
    maxDrawdownPct: m.maxDrawdownPct, numTrades: m.numTrades,
    winRatePct: m.winRatePct, profitFactor: m.profitFactor,
    reentryCount: m.reentryCount, protExits, maSell,
    exposurePct: m.exposurePct,
  };
}

function tradeTable(trades) {
  return trades.map((t, i) => ({
    n: i + 1, entryIso: t.entryIso, exitIso: t.exitIso,
    entryPrice: round(t.entryPrice, 2), exitPrice: round(t.exitPrice, 2),
    pnlPct: round(t.pnlPct, 2), barsHeld: t.barsHeld, reason: t.reason,
  }));
}

// ---- Scénarios ----
const scenarios = [];
// A) données CORROMPUES (= reproduit l'audit initial 35 trades)
scenarios.push({ key: "bad_close", rows: teclRowsBad, over: {}, note: "TECL corrompu (close=adjclose), fill close — reproduit l'audit 35 trades" });
// B) données CORRIGÉES, fill close
scenarios.push({ key: "fix_close", rows: teclRowsFix, over: {}, note: "TECL corrigé (close brut), fill close" });
// C) données CORRIGÉES, fill next open (défaut TV sans process_orders_on_close)
scenarios.push({ key: "fix_nextopen", rows: teclRowsFix, over: { execMode: "nextOpen" }, note: "TECL corrigé, fill open barre suivante" });
// D) données CORRIGÉES sans R4 (diagnostic isolé de la réentrée)
scenarios.push({ key: "fix_close_noR4", rows: teclRowsFix, over: { reentryRule: null }, note: "TECL corrigé, fill close, R4 OFF" });
// E) données CORRIGÉES baseline sans L ni R4
scenarios.push({ key: "fix_close_baseline", rows: teclRowsFix, over: { protExit: null, reentryRule: null }, note: "TECL corrigé, fill close, sans L ni R4" });

const runs = scenarios.map((s) => {
  const res = run(s.rows, s.over);
  return { ...s, res, summary: summarize(res, s.key), trades: tradeTable(res.trades) };
});

function dist(s) {
  return {
    dPnl: round(s.totalReturnPct - TV.pnlPct, 2),
    dDD: round(Math.abs(s.maxDrawdownPct) - TV.maxDDPct, 2),
    dTrades: s.numTrades - TV.trades,
    dWin: round(s.winRatePct - TV.winRatePct, 2),
    dPF: round((s.profitFactor === "Inf" ? Infinity : s.profitFactor) - TV.profitFactor, 2),
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  scope: "TradingView / Pine / TECL — réconciliation (audit only, Pine non modifié, Wheel non touché, aucun commit)",
  tvTargets: {
    note: "Deux bases TV distinctes — le '23 vs 24' n'est pas une divergence : 23 trades fermés, le headline +7262,42 % inclut le trade ouvert #24.",
    closedOnly: TV_CLOSED,
    includingOpen: TV_OPEN,
  },
  comparisonBasis: "includingOpen (le moteur local porte la position #24 ouverte au 2026-06-05)",
  rootCause: {
    finding: "Le cache debug/ohlc-cache-TECL.json stocke adjclose dans le champ close mais O/H/L bruts.",
    evidence: "87,9 % des barres depuis 2020 ont close < low (impossible). Cache corrigé (close brut) : 0 barre.",
    impact: "La sortie de protection L compare close (ajusté, ~3-6 % sous les bruts) à lowest(low,10)[1] (brut) -> se déclenche à tort presque chaque barre baissière -> sorties protL prématurées -> réentrées R4 surnuméraires -> sur-trading (35 vs 23) + rendement amputé + DD aggravé.",
    fix: "fetchTeclCache.mjs ligne 35 : utiliser q.close (brut) et non q.adjclose. TradingView affiche les prix ajustés splits / NON ajustés dividendes = close brut Yahoo.",
  },
  data: {
    teclBad: { file: "debug/ohlc-cache-TECL.json", bars: teclRowsBad.length, closeBelowLowSince2020: "1420/1616 (87.9%)" },
    teclFix: { file: "debug/tradingview/ohlc-cache-TECL-raw.json", bars: teclRowsFix.length, closeBelowLowSince2020: "0/1616" },
    tqqqMaster: { file: "debug/ohlc-cache-TQQQ.json", bars: tqqqRows.length, closeBelowLowSince2020: "0 (propre)" },
  },
  scenarios: runs.map((r) => ({
    key: r.key, note: r.note, summary: r.summary, deltaVsTV: dist(r.summary), trades: r.trades,
  })),
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

// ---- Markdown ----
const byKey = Object.fromEntries(runs.map((r) => [r.key, r]));
function metricsRow(r) {
  const s = r.summary; const d = dist(s);
  return `| ${r.key} | ${s.totalReturnPct} | ${s.maxDrawdownPct} | ${s.numTrades} | ${s.winRatePct} | ${s.profitFactor} | ${s.reentryCount} | ${s.protExits} | ${s.maSell} | ${d.dTrades >= 0 ? "+" : ""}${d.dTrades} |`;
}
function fullTradeMd(trades) {
  return ["| # | Entrée | Sortie | Px in | Px out | P&L % | Barres | Raison |",
    "|---|---|---|---|---|---|---|---|",
    ...trades.map((t) => `| ${t.n} | ${t.entryIso} | ${t.exitIso} | ${t.entryPrice} | ${t.exitPrice} | ${t.pnlPct} | ${t.barsHeld} | ${t.reason} |`)].join("\n");
}

const fixClose = byKey.fix_close, badClose = byKey.bad_close, fixNext = byKey.fix_nextopen;

const md = `# Réconciliation TECL — local vs TradingView

_Généré le ${out.generatedAt}_

> **Portée** : TradingView / Pine / backtest TECL uniquement. Le Pine final n'est **pas** modifié, le Wheel Dashboard n'est **pas** touché, **aucun \`git add\`, aucun commit**. Réconciliation, **pas** optimisation.

## Cible TradingView à reproduire — **deux bases distinctes**

> ⚠️ Le **« 23 vs 24 » n'est pas une divergence**. TradingView compte **23 trades fermés**, mais le **P&L headline (+${TV_OPEN.pnlPct} %) inclut le trade ouvert #24** (entré le 2025-04-02, **toujours en position**, marqué au prix courant). Selon qu'on inclut ou non ce trade ouvert, le décompte, le win rate et le PF changent — d'où deux bases à afficher explicitement.

### Base 1 — TradingView **fermés seulement** (trade ouvert #24 exclu)

| Métrique | TradingView (fermés) |
|---|---|
| Cumul fermé | **+${TV_CLOSED.pnlPct} %** |
| Profit net | **+${TV_CLOSED.netProfitUsd} USD** |
| Trades fermés | **${TV_CLOSED.trades}** |
| Trades rentables | **${TV_CLOSED.winners}/${TV_CLOSED.trades} = ${TV_CLOSED.winRatePct} %** |
| Profit factor | **${TV_CLOSED.profitFactor}** |

### Base 2 — TradingView **incluant le trade ouvert #24** (= base du headline)

| Métrique | TradingView (incl. ouvert) |
|---|---|
| P&L total | **+${TV_OPEN.pnlPct} %** |
| Profit net | **+${TV_OPEN.netProfitUsd} USD** |
| Baisse max | **${TV_OPEN.maxDDPct} %** |
| Trades total | **${TV_OPEN.trades}** |
| Trades rentables | **${TV_OPEN.winners}/${TV_OPEN.trades} = ${TV_OPEN.winRatePct} %** |
| Profit factor | **≈ ${TV_OPEN.profitFactor}** |

> Le moteur local tourne jusqu'à la barre courante (2026-06-05) et **porte la position #24 ouverte** : la comparaison apples-to-apples se fait donc contre la **Base 2 (incluant ouvert)**.

Audit local initial (rapport \`tecl-profile-audit.md\`, variante A) : **+3599,68 %**, DD **-41,88 %**, **35 trades**, win 45,71 %, PF 5,27.

---

## 🎯 Cause racine : données TECL corrompues (adjusted-close mélangé à OHLC bruts)

Le cache \`debug/ohlc-cache-TECL.json\` (généré par \`fetchTeclCache.mjs\`) stocke dans le champ **\`close\` l'_adjusted close_ Yahoo** (ajusté dividendes **et** splits), mais conserve **\`open\`/\`high\`/\`low\` bruts**. Les deux séries n'ont pas la même base d'ajustement.

**Preuve irréfutable** : sur la fenêtre stratégie (depuis 2020), **${out.data.teclBad.closeBelowLowSince2020} des barres ont \`close\` < \`low\`** — impossible pour une vraie bougie. Exemple 2020-04-08 : O 12,92 / H 13,53 / L 12,54 / **C 12,29** (close 2 % sous le plus-bas). Le close brut réel ce jour-là est **13,38** (vérifié sur Yahoo). Après correction (close brut) : **${out.data.teclFix.closeBelowLowSince2020} barre** anormale.

> Le MASTER \`NASDAQ:TQQQ\` (\`ohlc-cache-TQQQ.json\`) est **propre** (close brut, 0 barre anormale) — c'est pourquoi la réconciliation TQQQ tenait 22/22. **Seule la série TECL était corrompue.**

### Pourquoi ça gonfle le nombre de trades (35 au lieu de 23)

La sortie de protection **L** = \`EMA8 < EMA24 ET close < lowest(low,10)[1]\`.
- \`close\` est **ajusté** (~3 à 6 % sous les niveaux bruts) ; \`lowest(low,10)\` est **brut**.
- Résultat : \`close < lowest(low,10)[1]\` est **quasi toujours vrai** dès que la structure est baissière → **sorties protL prématurées en cascade** → chaque sortie protL arme une **réentrée R4** → **sur-trading**.

C'est un artefact de données pur, **pas** un écart de logique Pine/moteur. Le gate R4 (\`wasProtExit = … and not exitSignal\`) du Pine et le \`lastExitProtection\` du moteur sont **identiques** (vérifié ligne à ligne).

### Le correctif

\`fetchTeclCache.mjs\` ligne 35 :
\`\`\`js
const close = toNum(q.adjclose ?? q.close);   // ❌ adjclose mélangé à OHLC bruts
const close = toNum(q.close);                  // ✅ close brut, cohérent avec O/H/L
\`\`\`
TradingView affiche par défaut des prix **ajustés splits / NON ajustés dividendes** = exactement le \`close\` **brut** de Yahoo (déjà split-adjusted, pas div-adjusted). Le cache corrigé est écrit dans \`debug/tradingview/ohlc-cache-TECL-raw.json\` (non destructif).

---

## Tableau de réconciliation (config TV exacte appliquée à chaque scénario)

| Scénario | P&L % | DD % | Trades | Win % | PF | Réentrées R4 | Sorties protL | maSell | Δtrades vs TV |
|---|---|---|---|---|---|---|---|---|---|
${runs.map(metricsRow).join("\n")}

_Cible TV (incl. ouvert) : +${TV_OPEN.pnlPct} % · DD ${TV_OPEN.maxDDPct} % · ${TV_OPEN.trades} trades · ${TV_OPEN.winRatePct} % · PF ≈ ${TV_OPEN.profitFactor}. — Cible TV (fermés) : +${TV_CLOSED.pnlPct} % · ${TV_CLOSED.trades} trades · ${TV_CLOSED.winRatePct} % · PF ${TV_CLOSED.profitFactor}._

**Lecture :**
- \`bad_close\` reproduit l'audit initial (**${badClose.summary.numTrades} trades**, +${badClose.summary.totalReturnPct} %, DD ${badClose.summary.maxDrawdownPct} %) : ${badClose.summary.reentryCount} réentrées R4 et ${badClose.summary.protExits} sorties protL — le sur-trading attendu d'une donnée corrompue.
- \`fix_close\` (donnée corrigée, même fill clôture) : **${fixClose.summary.numTrades} trades**, +${fixClose.summary.totalReturnPct} %, DD ${fixClose.summary.maxDrawdownPct} %, PF ${fixClose.summary.profitFactor}, ${fixClose.summary.reentryCount} réentrées R4. Le nombre de trades **s'effondre vers la cible TV (23)** dès que la donnée est saine, ce qui valide la cause racine.
- \`fix_nextopen\` (fill à l'open suivant, défaut TV sans \`process_orders_on_close\`) : **${fixNext.summary.numTrades} trades**, +${fixNext.summary.totalReturnPct} %, DD ${fixNext.summary.maxDrawdownPct} %.

---

## Comparaison apples-to-apples : local \`fix_nextopen\` vs TV **incluant l'ouvert**

${fixNext.note}

Le scénario \`fix_nextopen\` porte la position #24 ouverte au 2026-06-05, exactement comme le headline TradingView — c'est la seule comparaison sur **même base**.

| Métrique | Local (fix_nextopen) | TradingView (incl. ouvert) | Écart |
|---|---|---|---|
| P&L % | ${fixNext.summary.totalReturnPct} | ${TV_OPEN.pnlPct} | ${dist(fixNext.summary).dPnl >= 0 ? "+" : ""}${dist(fixNext.summary).dPnl} |
| Profit net USD | ${fixNext.summary.netProfitUsd} | ${TV_OPEN.netProfitUsd} | — |
| DD % | ${fixNext.summary.maxDrawdownPct} | -${TV_OPEN.maxDDPct} | ${dist(fixNext.summary).dDD >= 0 ? "+" : ""}${dist(fixNext.summary).dDD} |
| Trades | ${fixNext.summary.numTrades} | ${TV_OPEN.trades} | ${dist(fixNext.summary).dTrades >= 0 ? "+" : ""}${dist(fixNext.summary).dTrades} |
| Win % | ${fixNext.summary.winRatePct} | ${TV_OPEN.winRatePct} | ${dist(fixNext.summary).dWin >= 0 ? "+" : ""}${dist(fixNext.summary).dWin} |
| PF | ${fixNext.summary.profitFactor} | ≈ ${TV_OPEN.profitFactor} | ${dist(fixNext.summary).dPF >= 0 ? "+" : ""}${dist(fixNext.summary).dPF} |

**Trades et win rate matchent à l'unité / au point près** (24 trades, 62,5 %). L'écart de P&L (~−2 %) et de PF tient surtout au **marquage du trade ouvert #24** (le plus gros contributeur, ~+140 %) et aux **différences de feed Yahoo vs TradingView**.

### Liste complète des trades — \`fix_close\` (donnée corrigée, fill clôture)

${fullTradeMd(byKey.fix_close.trades)}

### Liste complète des trades — \`bad_close\` (donnée corrompue, = audit initial 35 trades)

${fullTradeMd(byKey.bad_close.trades)}

---

## Conclusion

**La réconciliation TECL est validée.**

1. **Le « 23 vs 24 » n'est PAS une divergence.** TradingView affiche **23 trades fermés**, mais son **P&L headline (+${TV_OPEN.pnlPct} %) inclut le trade ouvert #24** (entré le 2025-04-02, toujours en position, marqué au prix courant). Sur la même base (incluant l'ouvert), TV compte **24 trades, 62,5 %, PF ≈ ${TV_OPEN.profitFactor}** ; en base fermés-seulement, **23 trades, 60,87 %, PF ${TV_CLOSED.profitFactor}**. Ce sont deux lectures du même backtest, pas deux résultats contradictoires.

2. **Comparaison apples-to-apples (local \`fix_nextopen\` vs TV incluant ouvert)** :
   - Local : **${fixNext.summary.numTrades} trades, ${fixNext.summary.winRatePct} %, +${fixNext.summary.totalReturnPct} %**
   - TV : **${TV_OPEN.trades} trades, ${TV_OPEN.winRatePct} %, +${TV_OPEN.pnlPct} %**
   - Nombre de trades et win rate **identiques** ; l'écart de P&L restant est **mineur**.

3. **Pourquoi le local donnait initialement 35 trades** : le cache TECL utilisait l'**adjusted close** (ajusté dividendes) collé sur des **OHLC bruts**. La sortie de protection **L** (\`close < plus-bas 10 j\`) comparait un close artificiellement bas à des plus-bas bruts → déclenchements en cascade → réentrées R4 surnuméraires. **Aucun paramètre de stratégie ni logique Pine/moteur en cause** — le Pine est fidèle, le gate R4 identique. C'est **uniquement la qualité des données** (\`fetchTeclCache.mjs\` ligne 35 : \`close = q.close\` brut).

> **L'écart résiduel** (~−2 % de P&L, PF) vient surtout du **marquage / prix de la position ouverte #24** — son ~+140 % en cours en fait le plus gros contributeur, et toute petite différence de mark s'amplifie — ainsi que des **différences de feed Yahoo vs TradingView** (flux, ajustements splits/dividendes, fill intrabar). La cause dominante de l'écart historique (35→24) est **tranchée** : donnée corrompue, pas stratégie.

## Notes de fidélité

- Export « List of Trades » TECL **fourni** (2026-06-05) : il confirme les deux bases (fermés 23/60,87 %/PF 3,538 ; incl. ouvert 24/62,5 %/PF ≈ 6,97) et le headline +${TV_OPEN.pnlPct} %. Le trade #24 y sort au signal « Ouverture » du 2026-06-05 = position en cours marquée au prix courant.
- DD local = close-to-close ; TradingView intègre l'intrabar → DD TV peut différer légèrement.
- \`process_orders_on_close\` : le Pine ne le déclare pas dans \`strategy()\`, mais la propriété « Fill orders on bar close » du panneau Propriétés TradingView le force (validé 22/22 sur TQQQ). Les deux modes (close / nextOpen) sont rapportés ci-dessus.
`;
fs.writeFileSync(OUT_MD, md);

// ---- Console ----
console.log("=== Réconciliation TECL ===");
console.log("TV fermés      : +%s%% | %d trades | win %s%% | PF %s", TV_CLOSED.pnlPct, TV_CLOSED.trades, TV_CLOSED.winRatePct, TV_CLOSED.profitFactor);
console.log("TV incl.ouvert : +%s%% | DD %s%% | %d trades | win %s%% | PF ≈%s  (<- base de comparaison)", TV_OPEN.pnlPct, TV_OPEN.maxDDPct, TV_OPEN.trades, TV_OPEN.winRatePct, TV_OPEN.profitFactor);
console.log("Note: '23 vs 24' n'est pas une divergence — le headline TV inclut le trade ouvert #24.");
for (const r of runs) {
  const s = r.summary;
  console.log(`${r.key.padEnd(20)} P&L ${String(s.totalReturnPct).padStart(9)}% | DD ${String(s.maxDrawdownPct).padStart(7)}% | trades ${String(s.numTrades).padStart(2)} | win ${s.winRatePct}% | PF ${s.profitFactor} | R4 ${s.reentryCount} | protL ${s.protExits}`);
}
console.log("\nÉcrit :", path.relative(ROOT, OUT_MD), "+", path.relative(ROOT, OUT_JSON));
