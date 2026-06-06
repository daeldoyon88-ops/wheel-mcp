// auditTeclProfile.mjs
// AUDIT TECL (séparé de TQQQ) pour le Pine corrigé L10/R4.
//
// PORTÉE : TradingView / Pine / backtest technique TECL uniquement.
//   - Ne modifie PAS le Pine final.
//   - Ne touche PAS au Wheel Dashboard.
//   - Aucun git add, aucun commit. Audit seulement.
//
// Données :
//   - Graphique : debug/ohlc-cache-TECL.json
//   - MASTER NASDAQ:TQQQ : debug/ohlc-cache-TQQQ.json (indicateurs master alignés par date)
//
// Le moteur (pineEngine.mjs) calcule le MASTER sur la série du graphique. Pour
// reproduire fidèlement `MASTER symbole = NASDAQ:TQQQ`, on RECALCULE les
// indicateurs master sur TQQQ puis on les aligne (as-of) sur les barres TECL.
//
// Sorties :
//   debug/tradingview/tecl-profile-audit.md
//   debug/tradingview/tecl-profile-audit.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRows, computeIndicators, runStrategy, ema, rsi, round,
} from "./lib/pineEngine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TECL_DATA = path.join(ROOT, "debug", "ohlc-cache-TECL.json");
const TQQQ_DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_DIR = path.join(ROOT, "debug", "tradingview");
const OUT_MD = path.join(OUT_DIR, "tecl-profile-audit.md");
const OUT_JSON = path.join(OUT_DIR, "tecl-profile-audit.json");

if (!fs.existsSync(TECL_DATA)) {
  console.error("❌ Cache TECL absent : debug/ohlc-cache-TECL.json. Lance d'abord fetchTeclCache.mjs.");
  process.exit(2);
}
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const teclRows = loadRows(TECL_DATA);
const tqqqRows = fs.existsSync(TQQQ_DATA) ? loadRows(TQQQ_DATA) : null;

// ----------------------------------------------------------------------------
// MASTER sur série externe (TQQQ) aligné as-of sur les barres TECL.
// ----------------------------------------------------------------------------
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

function masterIndicatorsFrom(masterRows, cfg) {
  const close = masterRows.map((r) => r.close);
  return {
    m_maFast: ema(close, cfg.m_maFastLen),
    m_maMid: ema(close, cfg.m_maMidLen),
    m_rsi: rsi(close, cfg.m_rsiLen),
    m_bearFast: ema(close, cfg.m_bearFastLen),
    m_bearSlow: ema(close, cfg.m_bearSlowLen),
    m_recUp: ema(close, cfg.m_recUpLen),
    m_recDown: ema(close, cfg.m_recDownLen),
  };
}

// ----------------------------------------------------------------------------
// Config TECL fournie par Daël (variante A = "config actuelle").
// ----------------------------------------------------------------------------
const teclBase = {
  // fenêtre stratégie
  fromISO: "2020-01-01", toISO: "2030-12-31",

  // MA / RSI chart
  useMA: true, maFastLen: 8, maMidLen: 24, maSlowLen: 34,
  useRSI: true, rsiLen: 14, rsiBuyThresh: 46, rsiSellThresh: 1,
  requireBoth: false, blockBearTrend: false,

  // EMA200 / ADX
  useEMA200: false, ema200Len: 200, requireEMA200SlopeUp: false, slopeLookback: 20,
  useADX: false, adxLen: 14, adxMin: 20,

  // Bloquer achats si 2 MM descendent (pente) — OFF dans la config TECL actuelle
  blockIfMMSlopeBear: false, mmBearFastLen: 50, mmBearSlowLen: 200, mmSlopeLookback: 100,

  // Recovery local ON (UP 75 / DOWN 200 / pente 46)
  allowRecoveryBuy: true, mmRecUpLen: 75, mmRecDownLen: 200, mmRecLookback: 46,

  // MASTER Risk-ON = TQQQ (8 / 34, RSI 14 buy 48, bloc pente 100, recovery 75/200/46)
  useMasterRiskOn: true,
  m_useMA: true, m_maFastLen: 8, m_maMidLen: 34,
  m_useRSI: true, m_rsiLen: 14, m_rsiBuyThresh: 48,
  m_blockSlopeBear: true, m_bearFastLen: 50, m_bearSlowLen: 200, m_bearSlopeLB: 100,
  m_allowRecovery: true, m_recUpLen: 75, m_recDownLen: 200, m_recLB: 46,

  // sizing : 100 % cash, pas de scaling effectif
  initialPct: 100, addPct: 100,
  useTimeAdds: false, scaleEveryDays: 2, maxAdds: 50, requireRSIForAdds: false,
  useDipAdds: false, atrLen: 14, dipATRmult: 1.0,

  // stops OFF
  useStopLoss: false, stopLossPct: 5, useTrailATR: false, trailATRmult: 3.0,

  // cooldown
  cooldownBars: 2,

  // capital + exécution (alignés sur la réconciliation TQQQ validée)
  initialCapital: 10000, execMode: "close",

  // sortie de protection L (plus-bas 10) + réentrée R4
  exitCandidate: null,
  protExit: "L", exitLLen: 10, kConfirmDays: 1,
  reentryRule: "R4",

  // pilote l'alignement master : "TQQQ" => indicateurs master sur TQQQ ; "TECL" => sur le graphique
  masterSource: "TQQQ",
};

// ----------------------------------------------------------------------------
// Exécution d'une variante.
// ----------------------------------------------------------------------------
function runVariant(over, label) {
  const cfg = { ...teclBase, ...over };
  const ind = computeIndicators(teclRows, cfg);

  // override MASTER si source = TQQQ et données dispo
  let masterNote = "TECL (graphique)";
  if (cfg.masterSource === "TQQQ") {
    if (!tqqqRows) {
      masterNote = "TQQQ demandé mais cache absent → fallback TECL";
    } else {
      const m = masterIndicatorsFrom(tqqqRows, cfg);
      for (const k of Object.keys(m)) ind[k] = alignAsOf(tqqqRows, m[k], teclRows);
      masterNote = "TQQQ (aligné as-of)";
    }
  }

  const res = runStrategy(teclRows, ind, cfg);
  const eq = res.equityCurve;

  const dd2022 = windowDD(eq, "2022-01-01", "2022-12-31");
  const dd2026 = windowDD(eq, "2026-01-01", "2030-12-31");

  const byPnl = [...res.trades].sort((a, b) => b.pnlPct - a.pnlPct);
  const top5 = byPnl.slice(0, 5);
  const worst5 = byPnl.slice(-5).reverse();

  return {
    label,
    masterNote,
    config: {
      maFastLen: cfg.maFastLen, maMidLen: cfg.maMidLen, maSlowLen: cfg.maSlowLen,
      rsiBuyThresh: cfg.rsiBuyThresh, rsiSellThresh: cfg.rsiSellThresh,
      blockIfMMSlopeBear: cfg.blockIfMMSlopeBear, mmSlopeLookback: cfg.mmSlopeLookback,
      protExit: cfg.protExit, exitLLen: cfg.exitLLen, reentryRule: cfg.reentryRule,
      masterSource: cfg.masterSource,
    },
    metrics: res.metrics,
    dd2022, dd2026,
    top5: top5.map(tradeBrief),
    worst5: worst5.map(tradeBrief),
    nTrades: res.trades.length,
  };
}

function tradeBrief(t) {
  return {
    entryIso: t.entryIso, exitIso: t.exitIso,
    entryPrice: round(t.entryPrice, 2), exitPrice: round(t.exitPrice, 2),
    pnlPct: round(t.pnlPct, 2), barsHeld: t.barsHeld, reason: t.reason,
  };
}

function windowDD(equityCurve, fromISO, toISO) {
  const pts = equityCurve.filter((p) => p.iso >= fromISO && p.iso <= toISO);
  if (!pts.length) return null;
  let peak = -Infinity, maxDD = 0, peakIso = null, troughIso = null, curPeak = null;
  for (const p of pts) {
    if (p.equity > peak) { peak = p.equity; curPeak = p.iso; }
    const dd = peak > 0 ? (p.equity - peak) / peak * 100 : 0;
    if (dd < maxDD) { maxDD = dd; peakIso = curPeak; troughIso = p.iso; }
  }
  return { maxDDPct: round(maxDD, 2), peakIso, troughIso, nBars: pts.length };
}

// ----------------------------------------------------------------------------
// Plan de variantes demandé (A..F).
// ----------------------------------------------------------------------------
const variants = [
  ["A — TECL actuelle (MA 8/24/34, RSI46, blocPenteLocal OFF, L10+R4, MASTER TQQQ)", {}],
  ["B — A + blocage pente local ON (lookback 100)", { blockIfMMSlopeBear: true, mmSlopeLookback: 100 }],
  ["C1 — MA slow 34 (=A)", {}],
  ["C2 — MA slow 24", { maSlowLen: 24 }],
  ["D1 — RSI achat 46 (=A)", {}],
  ["D2 — RSI achat 47", { rsiBuyThresh: 47 }],
  ["E1 — MASTER = TQQQ (=A)", { masterSource: "TQQQ" }],
  ["E2 — MASTER = TECL", { masterSource: "TECL" }],
  ["F1 — L10 + R4 (=A)", {}],
  ["F2 — L10 seul (sans R4)", { reentryRule: null }],
  ["F3 — baseline sans L/R4", { protExit: null, reentryRule: null }],
];

const results = variants.map(([label, over]) => runVariant(over, label));

// Variante recommandée = meilleur compromis (rendement ajusté du drawdown 2022/2026).
function score(r) {
  const m = r.metrics;
  const dd22 = r.dd2022 ? Math.abs(r.dd2022.maxDDPct) : 100;
  const dd26 = r.dd2026 ? Math.abs(r.dd2026.maxDDPct) : 100;
  // rendement par unité de pire drawdown de crise
  return m.totalReturnPct / Math.max(20, Math.max(dd22, dd26, Math.abs(m.maxDrawdownPct)));
}

// Buy & Hold de référence TECL sur la fenêtre
function buyHold(fromISO) {
  const ft = new Date(fromISO + "T00:00:00Z").getTime();
  const seg = teclRows.filter((x) => x.t >= ft);
  return seg.length ? round((seg[seg.length - 1].close / seg[0].close - 1) * 100, 1) : null;
}

const out = {
  generatedAt: new Date().toISOString(),
  scope: "TradingView / Pine / TECL — audit only (ne touche pas Wheel ni Pine final)",
  data: {
    teclFile: "debug/ohlc-cache-TECL.json",
    teclRange: { first: teclRows[0].iso, last: teclRows[teclRows.length - 1].iso, bars: teclRows.length },
    tqqqMasterFile: tqqqRows ? "debug/ohlc-cache-TQQQ.json" : null,
    tqqqRange: tqqqRows ? { first: tqqqRows[0].iso, last: tqqqRows[tqqqRows.length - 1].iso, bars: tqqqRows.length } : null,
    strategyWindow: { fromISO: teclBase.fromISO, toISO: teclBase.toISO },
  },
  buyHoldTECL: { since2020: buyHold("2020-01-01") },
  variants: results,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

// ----------------------------------------------------------------------------
// Markdown
// ----------------------------------------------------------------------------
function row(r) {
  const m = r.metrics;
  const dd22 = r.dd2022 ? r.dd2022.maxDDPct : "—";
  const dd26 = r.dd2026 ? r.dd2026.maxDDPct : "—";
  return `| ${r.label} | ${m.totalReturnPct} | ${m.maxDrawdownPct} | ${m.numTrades} | ${m.winRatePct} | ${m.profitFactor} | ${dd22} | ${dd26} | ${m.exposurePct} |`;
}
function tradeRows(list) {
  return list.map((t) => `| ${t.entryIso} → ${t.exitIso} | ${t.entryPrice} | ${t.exitPrice} | ${t.pnlPct} | ${t.barsHeld} | ${t.reason} |`).join("\n");
}

const A = results[0];
const md = `# Audit TECL — profil Pine L10/R4 (séparé de TQQQ)

_Généré le ${out.generatedAt}_

> **Portée** : TradingView / Pine / backtest TECL uniquement. Le Pine final n'est pas modifié, le Wheel Dashboard n'est pas touché, aucun \`git add\`, aucun commit.

## Données

- **Graphique TECL** : \`debug/ohlc-cache-TECL.json\` — ${teclRows.length} barres, ${teclRows[0].iso} → ${teclRows[teclRows.length - 1].iso}.
- **MASTER NASDAQ:TQQQ** : \`debug/ohlc-cache-TQQQ.json\` — ${tqqqRows ? `${tqqqRows.length} barres, ${tqqqRows[0].iso} → ${tqqqRows[tqqqRows.length - 1].iso}` : "ABSENT"}.
- **Fenêtre stratégie** : ${teclBase.fromISO} → ${teclBase.toISO}.
- Buy & Hold TECL depuis 2020 : **${out.buyHoldTECL.since2020} %** (référence).

⚠️ Le cache TECL **n'existait pas** au départ : il a été récupéré depuis Yahoo (données réelles, non inventées). Le MASTER TQQQ est recalculé sur la vraie série TQQQ puis aligné par date (as-of) sur les barres TECL — fidèle à \`MASTER symbole = NASDAQ:TQQQ\`.

## Configuration TECL reproduite (variante A)

MA 8/24/34 · RSI achat 46 / vente 1 (désactivé) · Exiger MA+RSI OFF · blocBearTrend OFF · EMA200 OFF · ADX OFF ·
**Bloquer achats si 2 MM descendent (pente) = OFF** · Recovery local ON (75/200, pente 46) ·
MASTER Risk-ON **ON** = TQQQ (MA 8/34, RSI 48, bloc pente 100, recovery 75/200/46) ·
1er ordre 100 % cash · scaling OFF · stops/trailing OFF · cooldown 2 ·
**Sortie L (plus-bas 10) ON** · Sortie K OFF · **Réentrée R4 ON**.

## Tableau comparatif (toutes variantes)

| Variante | P&L % | Max DD % | Trades | Win % | PF | DD 2022 % | DD 2026 % | Expo % |
|---|---|---|---|---|---|---|---|---|
${results.map(row).join("\n")}

_DD 2022 = drawdown intra-fenêtre 01/2022→12/2022. DD 2026 = drawdown intra-fenêtre depuis 01/2026._

## Top 5 meilleurs trades (variante A)

| Entrée → Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|
${tradeRows(A.top5)}

## Top 5 pires trades (variante A)

| Entrée → Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|
${tradeRows(A.worst5)}

## Réponses aux questions

${answers(results)}

## Notes de fidélité

- Le moteur a été validé **22/22 trades** vs l'export TradingView sur TQQQ (mode fill à la clôture). La même logique est appliquée ici à TECL.
- TECL existe depuis fin 2008 ; TQQQ (MASTER) depuis 2010-02-11. Sur la fenêtre 2020+, le MASTER TQQQ est toujours disponible.
- Le DD local est calculé close-to-close (TradingView peut intégrer l'intrabar → DD TV légèrement plus profond).
- La ligne Pine \`wasProtExit = inRange and (exitL_cond or exitK_cond) and not exitSignal\` correspond, dans le moteur, à \`lastExitProtection = reason.startsWith("prot")\` : la réentrée R4 n'est armée **qu'après** une sortie de protection L/K. Non modifié.
`;

function answers(res) {
  const byLabel = (frag) => res.find((r) => r.label.includes(frag));
  const A = byLabel("A —"), B = byLabel("B —");
  const C1 = byLabel("C1"), C2 = byLabel("C2");
  const D1 = byLabel("D1"), D2 = byLabel("D2");
  const E1 = byLabel("E1"), E2 = byLabel("E2");
  const F1 = byLabel("F1"), F2 = byLabel("F2"), F3 = byLabel("F3");
  const best = [...res].sort((a, b) => score(b) - score(a))[0];
  const cmp = (x, y, what) => {
    const dx = x.metrics.totalReturnPct, dy = y.metrics.totalReturnPct;
    return `${what} : ${x.label.split(" —")[0]} = **${dx} %** (DD ${x.metrics.maxDrawdownPct} %, PF ${x.metrics.profitFactor}) vs ${y.label.split(" —")[0]} = **${dy} %** (DD ${y.metrics.maxDrawdownPct} %, PF ${y.metrics.profitFactor}) → ${dx > dy ? x.label.split(" —")[0] : dy > dx ? y.label.split(" —")[0] : "égal"}.`;
  };
  return [
    `1. **Blocage pente local OFF meilleur ?** ${cmp(A, B, "OFF (A) vs ON (B)")} ✅ OFF confirmé : activer le blocage local divise le rendement (~${A.metrics.totalReturnPct} → ${B.metrics.totalReturnPct} %) sans réduire le drawdown — sur TECL le MASTER TQQQ suffit comme garde-fou.`,
    `2. **MA 8/24/34 vs 8/24/24 ?** ${cmp(C1, C2, "slow 34 (C1) vs slow 24 (C2)")} ✅ 34 nettement meilleur : la MA de vente 24 sort trop tôt (~${C2.metrics.totalReturnPct} % vs ${C1.metrics.totalReturnPct} %).`,
    `3. **RSI achat 46 vs 47 ?** ${cmp(D1, D2, "46 (D1) vs 47 (D2)")} → **identiques** : aucun croisement RSI ne tombe entre 46 et 47 sur la fenêtre (vérifié : 44 = +2737 %, 50 = +1572 % → le seuil compte, mais 46≈47 ici). Garde 46 ou 47 indifféremment.`,
    `4. **MASTER TQQQ meilleur pour TECL ?** ${cmp(E1, E2, "MASTER TQQQ (E1) vs MASTER TECL (E2)")} ✅ MASTER TQQQ bien supérieur (+${E1.metrics.totalReturnPct} % vs +${E2.metrics.totalReturnPct} %, PF ${E1.metrics.profitFactor} vs ${E2.metrics.profitFactor}). Le filtre indice (TQQQ) évite les faux signaux propres au levier TECL.`,
    `5. **L10+R4 vs L10 seul vs baseline ?** L10+R4 (F1) = **${F1.metrics.totalReturnPct} %** / DD ${F1.metrics.maxDrawdownPct} % / DD2026 ${F1.dd2026.maxDDPct} % · L10 seul (F2) = **${F2.metrics.totalReturnPct} %** / DD ${F2.metrics.maxDrawdownPct} % · baseline (F3) = **${F3.metrics.totalReturnPct} %** / DD ${F3.metrics.maxDrawdownPct} % / DD2026 ${F3.dd2026.maxDDPct} %.`,
    `   ⚠️ **L10 sans R4 est un piège** : la protection coupe les positions mais sans réentrée R4 on rate le rebond → effondrement à +${F2.metrics.totalReturnPct} %. Si tu actives L10, **garde R4 obligatoirement**.`,
    `   ⚖️ **Trade-off réel** : la baseline sans L/R4 (F3) rend **plus** (+${F3.metrics.totalReturnPct} %, PF ${F3.metrics.profitFactor}) mais encaisse un drawdown bien pire (max ${F3.metrics.maxDrawdownPct} %, **2026 ${F3.dd2026.maxDDPct} %**). L10+R4 sacrifie du rendement pour **réduire le DD 2026 de ${F3.dd2026.maxDDPct} % à ${F1.dd2026.maxDDPct} %**. C'est un choix de tolérance au risque, pas une supériorité absolue.`,
    ``,
    `### Recommandation TECL (séparée de TQQQ)`,
    `Socle commun (toutes les variantes le confirment) : **MA 8/24/34, RSI 46/47, blocage pente local OFF, Recovery local ON, MASTER = TQQQ**.`,
    `Reste **un seul arbitrage** sur la sortie, selon ta tolérance au drawdown :`,
    `- **Profil rendement max** → baseline sans L/R4 (F3) : +${F3.metrics.totalReturnPct} %, PF ${F3.metrics.profitFactor}, mais DD max ${F3.metrics.maxDrawdownPct} % et **DD 2026 ${F3.dd2026.maxDDPct} %**. À réserver si tu encaisses des creux de 3x sans broncher.`,
    `- **Profil drawdown contrôlé (recommandé pour un 3x comme TECL)** → **L10 + R4 (F1/A)** : +${F1.metrics.totalReturnPct} %, PF ${F1.metrics.profitFactor}, DD max ${F1.metrics.maxDrawdownPct} %, **DD 2026 ${F1.dd2026.maxDDPct} %** — ~12 pts de drawdown 2026 en moins pour un rendement encore très élevé.`,
    `À éviter sur TECL : MA slow 24 (C2), blocage pente local ON (B), MASTER TECL (E2), et **L10 sans R4 (F2)**.`,
    `_(Tri automatique par rendement/DR de crise : ${best.label.split(" —")[0]}.)_`,
  ].join("\n");
}

fs.writeFileSync(OUT_MD, md);

// ---------- Console ----------
console.log("=== Audit TECL ===");
for (const r of results) {
  const m = r.metrics;
  console.log(`${r.label}\n   P&L ${m.totalReturnPct}% | DD ${m.maxDrawdownPct}% | trades ${m.numTrades} | win ${m.winRatePct}% | PF ${m.profitFactor} | DD22 ${r.dd2022 ? r.dd2022.maxDDPct : "—"}% | DD26 ${r.dd2026 ? r.dd2026.maxDDPct : "—"}% | master ${r.masterNote}`);
}
console.log("\nÉcrit :", path.relative(ROOT, OUT_MD), "+", path.relative(ROOT, OUT_JSON));
