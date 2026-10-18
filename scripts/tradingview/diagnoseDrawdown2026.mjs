// diagnoseDrawdown2026.mjs  (Étape 4)
// Diagnostic jour-par-jour de la période critique 2026-01-28 → 2026-03-30 :
// pourquoi aucune sortie n'a déclenché pendant la baisse.
//
// Sorties :
//   debug/tradingview/tqqq-2026-drawdown-diagnostic.md
//   debug/tradingview/tqqq-2026-drawdown-diagnostic.csv
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.

import fs from "node:fs";
import path from "node:path";
import { loadRows, computeIndicators, runStrategy, userConfig } from "./lib/pineEngine.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_MD = path.join(ROOT, "debug", "tradingview", "tqqq-2026-drawdown-diagnostic.md");
const OUT_CSV = path.join(ROOT, "debug", "tradingview", "tqqq-2026-drawdown-diagnostic.csv");

const WIN_FROM = "2026-01-28";
const WIN_TO = "2026-03-30";

const rows = loadRows(DATA);
const cfg = { ...userConfig };
const ind = computeIndicators(rows, cfg);
const res = runStrategy(rows, ind, cfg);

// helpers locaux (mêmes définitions que le moteur)
const crossunder = (a, b, i) => i > 0 && a[i] < b && a[i - 1] >= b;
const crossunderArr = (a, b, i) => i > 0 && a[i] < b[i] && a[i - 1] >= b[i];
const isDown = (x, lb, i) => i - lb >= 0 && x[i] < x[i - lb];
const isUp = (x, lb, i) => i - lb >= 0 && x[i] > x[i - lb];
const crossoverArr = (a, b, i) => i > 0 && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossoverK = (a, b, i) => i > 0 && a[i] > b && a[i - 1] <= b;

function masterRiskOn(i) {
  const m_maBuy = crossoverArr(ind.m_maFast, ind.m_maMid, i);
  const m_rsiBuy = crossoverK(ind.m_rsi, cfg.m_rsiBuyThresh, i);
  const m_entry = (cfg.m_useMA && m_maBuy) || (cfg.m_useRSI && m_rsiBuy);
  const m_slopeBear = cfg.m_blockSlopeBear && isDown(ind.m_bearFast, cfg.m_bearSlopeLB, i) && isDown(ind.m_bearSlow, cfg.m_bearSlopeLB, i);
  const m_recoveryOk = cfg.m_allowRecovery && isUp(ind.m_recUp, cfg.m_recLB, i) && isDown(ind.m_recDown, cfg.m_recLB, i);
  return m_entry && ((!m_slopeBear) || m_recoveryOk);
}

// localiser le trade ouvert à une barre i (entryBar <= i <= exitBar)
function tradeAt(i) {
  return res.trades.find((t) => i >= t.entryBar && i <= t.exitBar) || null;
}

const idx = (iso) => rows.findIndex((r) => r.iso === iso);
const i0 = idx(WIN_FROM);
const i1 = idx(WIN_TO);

const cols = ["date", "close", "MA8", "MA24", "MA34", "MA50", "EMA200", "RSI",
  "MACDline", "MACDsignal", "MACDhist", "masterRiskOn", "maSellEvent", "rsiCrossDown",
  "exitSignal", "inPosition", "entryDate", "entryPrice", "ddSinceEntryPct", "noExitReason"];

const records = [];
for (let i = i0; i <= i1; i++) {
  const r = rows[i];
  const maSellEvent = crossunderArr(ind.maFast, ind.maSlow, i); // EMA8 crossunder EMA24
  const rsiCrossDown = crossunder(ind.rsi, cfg.rsiSellThresh, i); // RSI cross sous 1 -> jamais
  const exitSignal = (cfg.useMA && maSellEvent) || (cfg.useRSI && rsiCrossDown);
  const mOn = masterRiskOn(i);
  const tr = tradeAt(i);
  const inPos = !!tr;
  const dd = tr ? (r.close / tr.entryPrice - 1) * 100 : 0;

  // raison d'absence de sortie
  const ema8 = ind.maFast[i], ema24 = ind.maSlow[i];
  const ema8BelowEma24 = ema8 < ema24;
  const gap = ((ema8 - ema24) / ema24 * 100);
  let reason;
  if (!inPos) reason = "hors position";
  else if (exitSignal) reason = "SORTIE déclenchée ce jour (croisement EMA8 sous EMA24)";
  else if (ema8BelowEma24) reason = `aucune sortie possible : EMA8(${ema8.toFixed(2)}) DÉJÀ sous EMA24(${ema24.toFixed(2)}) (${gap.toFixed(2)}%) -> le croisement (évènement) a déjà eu lieu et ne peut plus se redéclencher ; RSI vente=1 inactif ; stops/ATR OFF ; MASTER ne sort pas`;
  else reason = `pas de sortie : EMA8(${ema8.toFixed(2)}) encore au-dessus EMA24(${ema24.toFixed(2)}) (+${gap.toFixed(2)}%) ; RSI vente=1 inactif ; stops/ATR OFF`;

  records.push({
    date: r.iso, close: r.close.toFixed(2),
    MA8: ind.maFast[i].toFixed(2), MA24: ind.maMid[i].toFixed(2),
    MA34: ind.m_maMid[i].toFixed(2), MA50: ind.ma50[i].toFixed(2),
    EMA200: ind.ema200[i].toFixed(2), RSI: ind.rsi[i].toFixed(1),
    MACDline: ind.macd.line[i].toFixed(3), MACDsignal: ind.macd.signal[i].toFixed(3),
    MACDhist: ind.macd.hist[i].toFixed(3),
    masterRiskOn: mOn ? "ON" : "off", maSellEvent: maSellEvent ? "YES" : "no",
    rsiCrossDown: rsiCrossDown ? "YES" : "no", exitSignal: exitSignal ? "YES" : "no",
    inPosition: inPos ? "YES" : "no", entryDate: tr ? tr.entryIso : "",
    entryPrice: tr ? tr.entryPrice.toFixed(2) : "", ddSinceEntryPct: tr ? dd.toFixed(2) : "",
    noExitReason: reason,
  });
}

// CSV
const csv = [cols.join(",")].concat(records.map((rec) => cols.map((c) => `"${rec[c]}"`).join(","))).join("\n");
fs.writeFileSync(OUT_CSV, csv);

// statistiques de la fenêtre
const inPosDays = records.filter((r) => r.inPosition === "YES");
const exitsInWindow = records.filter((r) => r.exitSignal === "YES");
const worstDD = inPosDays.reduce((min, r) => Math.min(min, parseFloat(r.ddSinceEntryPct)), 0);

// trade qui traverse la fenêtre (le grand DD)
const t22 = res.trades.find((t) => t.entryIso === "2026-02-25");

const md = `# Diagnostic période critique TQQQ — ${WIN_FROM} → ${WIN_TO}

_Config validée (22/22 trades vs TradingView). Voir tqqq-strategy-backtest-current.md._

## Résumé

- Jours dans la fenêtre : **${records.length}**
- Jours en position : **${inPosDays.length}**
- Signaux de sortie déclenchés dans la fenêtre : **${exitsInWindow.length}** ${exitsInWindow.length === 0 ? "→ **aucune sortie**" : "(" + exitsInWindow.map((r) => r.date).join(", ") + ")"}
- Pire drawdown depuis l'entrée (sur close) dans la fenêtre : **${worstDD.toFixed(2)} %**
${t22 ? `- Trade en cause : entré le **${t22.entryIso} @ ${t22.entryPrice.toFixed(2)}**, excursion adverse **${t22.maxAdverseClosePct.toFixed(1)} %**, sortie effective le ${t22.exitIso}.` : ""}

## Pourquoi aucune sortie n'a déclenché (mécanisme précis)

Séquence réelle dans la fenêtre :
1. **2026-02-04** : le trade précédent (entré le 2026-01-22) **sort** sur un vrai croisement EMA8↓EMA24 (perte −7,68 %). ✅ la sortie a bien fonctionné une fois.
2. **Flat du 04 au 25 fév.**
3. **2026-02-25** : **ré-entrée @ ${t22 ? t22.entryPrice.toFixed(2) : "51.87"}** déclenchée par **RSI qui croise 47 + MASTER ON**, ALORS QUE **EMA8 était déjà SOUS EMA24** (49,99 < 51,05). C'est permis parce que \`blockBearTrend\` est **OFF** : la stratégie achète un simple rebond de RSI dans une structure de moyennes déjà baissière.
4. **Du 25 fév au 30 mars** : EMA8 **reste en permanence sous** EMA24 → le **croisement baissier (un ÉVÈNEMENT) a déjà eu lieu avant l'entrée et ne peut plus se redéclencher** → \`maSellEvent\` = "no" tous les jours → **aucune sortie ne peut physiquement se produire** pendant toute la chute (${worstDD.toFixed(2)} % depuis l'entrée).

Pourquoi rien d'autre ne sort :
- **RSI vente = 1** → \`rsiCrossDown\` impossible (RSI ne descend pas sous 1). Porte RSI désactivée.
- **Stop Loss / Trailing ATR = OFF** → aucune protection.
- **MASTER Risk-ON ne filtre que les ENTRÉES** → le master passe "off" pendant la baisse (voir colonne) mais **ne ferme rien**.

➡️ **Double problème de sortie à corriger** (Étape 5) :
- (a) **aucune sortie basée sur un ÉTAT** (close < MA, momentum baissier) — uniquement un évènement de croisement qui peut être "déjà consommé" au moment de l'entrée ;
- (b) **aucune sortie réactive au momentum** (MACD, RSI, cassure de plus-bas) ni de stop.
La combinaison \`blockBearTrend\` OFF + sortie = évènement-seulement crée le piège : on peut entrer long sans aucune sortie active disponible.

## Détail jour par jour

| Date | Close | MA8 | MA24 | MA34 | MA50 | RSI | MACDhist | Master | EMA8<EMA24 | exitSignal | Pos | DD%entrée |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${records.map((r) => `| ${r.date} | ${r.close} | ${r.MA8} | ${r.MA24} | ${r.MA34} | ${r.MA50} | ${r.RSI} | ${r.MACDhist} | ${r.masterRiskOn} | ${r.maSellEvent} | ${r.exitSignal} | ${r.inPosition} | ${r.ddSinceEntryPct} |`).join("\n")}

_CSV complet (toutes colonnes) : tqqq-2026-drawdown-diagnostic.csv_
`;

fs.writeFileSync(OUT_MD, md);
console.log("Diagnostic écrit. Jours:", records.length, "en position:", inPosDays.length, "sorties:", exitsInWindow.length, "pire DD:", worstDD.toFixed(2) + "%");
console.log(path.relative(ROOT, OUT_MD), "+", path.relative(ROOT, OUT_CSV));
