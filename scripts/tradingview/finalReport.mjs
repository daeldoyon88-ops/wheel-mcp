// finalReport.mjs  (Étape 7)
// Rapport final d'optimisation des SORTIES (sans ATR), basé sur les Étapes 3-6.
// Lit les JSON produits aux étapes précédentes et compose le rapport.
//
// Sorties :
//   debug/tradingview/tqqq-strategy-exit-optimization-report.md
//   debug/tradingview/tqqq-strategy-exit-optimization-report.json
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.
// NE MODIFIE PAS le script Pine. Propose seulement des modifications à valider.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TVDIR = path.join(ROOT, "debug", "tradingview");
const cand = JSON.parse(fs.readFileSync(path.join(TVDIR, "tqqq-exit-candidates.json"), "utf8"));
const wf = JSON.parse(fs.readFileSync(path.join(TVDIR, "tqqq-walkforward.json"), "utf8"));
const base = JSON.parse(fs.readFileSync(path.join(TVDIR, "tqqq-strategy-backtest-current.json"), "utf8"));

const baseM = cand.results.baseline.metrics;

// classement candidates : trop agressives (rendement détruit), protectrices, recommandées
const rows = Object.entries(cand.results).filter(([k]) => k !== "baseline").map(([k, r]) => ({
  key: k, label: r.label, ret: r.metrics.totalReturnPct, dd: r.metrics.maxDrawdownPct,
  trades: r.metrics.numTrades, pf: r.metrics.profitFactor, expo: r.metrics.exposurePct,
  critDD: r.win.worstDDPct, extra: r.extraTrades,
}));

const PINE_L = `// === Sortie protectrice "L" (RECOMMANDÉE) : cassure plus-bas 10j en structure baissière ===
// À insérer après le calcul des MA/signaux et AVANT le bloc EXIT.
useExitLowBreak = input.bool(true, "🛡️ Sortie: cassure plus-bas Nj si EMA8<EMA24")
lowBreakLen     = input.int(10, "Sortie: plus-bas (bars)", minval=2)
exitLowBreak    = useExitLowBreak and (maFast < maMid) and (close < ta.lowest(low, lowBreakLen)[1])

// puis, dans la construction de exitSignal, AJOUTER :
exitSignal := exitSignal or (inRange and exitLowBreak)`;

const PINE_K = `// === Sortie protectrice "K" (PROTECTION MAX, plus de chop) : EMA8<EMA24 ET close<EMA24 ===
useExitBearMA = input.bool(false, "🛡️ Sortie: close<EMA24 si EMA8<EMA24")
exitBearMA    = useExitBearMA and (maFast < maMid) and (close < maMid)
exitSignal   := exitSignal or (inRange and exitBearMA)`;

const md = `# Rapport final — Optimisation des SORTIES (sans ATR) — Stratégie Pine TQQQ

_Généré le ${new Date().toISOString()}. Style swing (CELI). Backtest local validé 22/22 trades vs export TradingView._

> ⚠️ **Aucune modification du script Pine n'a été appliquée.** Ce rapport propose des changements à **valider d'abord** dans TradingView (Étape 7, point 7).

## Baseline (config réelle validée)

MA 8/24/24 · RSI achat 47 · RSI vente 1 (inactif) · MASTER on (8/34, RSI 48) · 100 % cash · 0 add · cooldown 2 ·
\`blockBearTrend\`/EMA200/\`blockIfMMSlopeBear\` **OFF** · fill à la clôture · ATR/stops **OFF** · capital 10 000 $.

- Rendement : **+${baseM.totalReturnPct} %** · Max DD : **${baseM.maxDrawdownPct} %** · Trades : **${baseM.numTrades}** · PF : **${baseM.profitFactor}** · Exposition : ${baseM.exposurePct} %
- Drawdown de la position pendant la crise 2026-01-28→03-30 : **${cand.criticalWindow.baselineWorstDDPct.toFixed(1)} %**

---

## 1. Pourquoi la stratégie est restée investie pendant la baisse

La seule sortie active est **\`maSellEvent\` = EMA8 croise SOUS EMA24** (un **ÉVÈNEMENT** de croisement). RSI vente=1 est inactif, Stop Loss/Trailing ATR sont OFF, et **MASTER ne filtre que les entrées** (il ne ferme jamais).

Séquence réelle (cf. \`tqqq-2026-drawdown-diagnostic\`) :
- 2026-02-04 : sortie correcte sur vrai croisement EMA8↓EMA24.
- **2026-02-25 : ré-entrée @ 51,87 sur un pop de RSI (RSI↑47) + MASTER ON, alors que EMA8 était DÉJÀ sous EMA24.** Possible car \`blockBearTrend\` est OFF.
- Du 25 fév au 30 mars : EMA8 reste **en permanence** sous EMA24 → le croisement baissier **a déjà eu lieu avant l'entrée** et **ne peut plus se redéclencher** → aucune sortie possible → la position encaisse **${cand.criticalWindow.baselineWorstDDPct.toFixed(1)} %**.

**Cause racine :** la stratégie peut entrer long **sans aucune sortie active disponible** (sortie = évènement déjà consommé), et il n'existe **aucune sortie basée sur un ÉTAT** ni sur le momentum.

## 2. Quelle sortie aurait aidé

Toutes les sorties d'état/momentum coupent ce trade. Réduction du DD de la position pendant la crise :

| Sortie | DD crise | vs baseline ${cand.criticalWindow.baselineWorstDDPct.toFixed(1)}% |
|---|---|---|
${["C", "K", "L", "B"].map((k) => `| ${k} | ${cand.results[k].win.worstDDPct.toFixed(1)} % | ${(cand.criticalWindow.baselineWorstDDPct - cand.results[k].win.worstDDPct).toFixed(1)} pts mieux |`).join("\n")}

- **Protection maximale de la crise : C / K** (−7,7 % au lieu de −27 %).
- **Bon compromis : L** (−16,9 %), avec beaucoup moins d'effets de bord (voir §3 et §5).

## 3. Quelle sortie réduit le DD sans trop augmenter les trades

| Sortie | Rendement | Max DD | Trades (Δ) | PF | DD crise |
|---|---|---|---|---|---|
| baseline | ${baseM.totalReturnPct} % | ${baseM.maxDrawdownPct} % | ${baseM.numTrades} | ${baseM.profitFactor} | ${cand.criticalWindow.baselineWorstDDPct.toFixed(1)} % |
${["L", "C", "K", "B"].map((k) => { const r = cand.results[k]; return `| ${k} | ${r.metrics.totalReturnPct} % | ${r.metrics.maxDrawdownPct} % | ${r.metrics.numTrades} (${r.extraTrades >= 0 ? "+" + r.extraTrades : r.extraTrades}) | ${r.metrics.profitFactor} | ${r.win.worstDDPct.toFixed(1)} % |`; }).join("\n")}

➡️ **L réduit le DD global (−42 → −38) et la crise (−27 → −17) avec +1 seul trade** et reste un vrai style swing. C/K protègent plus la crise mais ajoutent +9 trades et abîment les marchés haussiers.

## 4. Quelle sortie est trop agressive

| Sortie | Rendement | Trades | PF | Verdict |
|---|---|---|---|---|
${["A", "D", "E", "I", "J", "M", "F", "G", "H"].map((k) => { const r = cand.results[k]; const why = k === "H" ? "inutile pour cette crise (pas d'extension préalable)" : "rendement détruit / trades gonflés"; return `| ${k} | ${r.metrics.totalReturnPct} % | ${r.metrics.numTrades} | ${r.metrics.profitFactor} | ${why} |`; }).join("\n")}

Toutes les sorties contenant **\`close < MA8\`** (D, E, F, G) ou les sorties d'état trop serrées (I close<MA24, J close<MA50, M Donchian seul, A master-off) **coupent les gros gagnants** sur des creux normaux de tendance ; comme l'**entrée rigide** (RSI doit re-croiser 47 + MASTER) ne permet pas de re-rentrer dans la tendance, le rendement s'effondre.

## 5. Quelle variante recommander

**Recommandée : L — « cassure du plus-bas 10 jours quand EMA8 < EMA24 ».**

Robustesse walk-forward (sous-périodes) :

| Sortie | Rétention rendement | Dégât marché haussier | Protection crise | Inflation trades |
|---|---|---|---|---|
${["L", "C", "K", "B"].map((k) => { const r = wf.robustness[k]; return `| ${k} | ${r.avgRetRetentionPct} % | ${r.bullHarmPct} % | ${r.avgCrisisProtectionPts} pts | ${r.tradeInflation >= 0 ? "+" + r.tradeInflation : r.tradeInflation} |`; }).join("\n")}

Pourquoi **L** :
- **0 % de dégât en marché haussier** (2020-2021 et 2022-2023 : identique au baseline, aucune sortie parasite, **mêmes trades**).
- **Meilleure rétention de rendement** (66 % vs 50-51 %).
- **+1 trade seulement** sur tout l'historique → reste swing.
- Ne se déclenche **que** quand la structure est baissière ET qu'un nouveau plus-bas de 10 jours casse → laisse respirer les tendances saines, coupe les rebonds qui échouent (comme février 2026).

**Alternative (protection maximale) : K** si tu acceptes un rendement plus bas, plus de trades et un peu de chop en marché haussier, en échange d'une crise ramenée à −7,7 %.

**Dilemme central à connaître :** la même permission (acheter un rebond RSI quand EMA8<EMA24) qui crée les **gros gagnants contre-tendance** (2020-04 +123 %, 2025-04 +101 %) est aussi celle qui a créé le piège de février 2026. Remettre \`blockBearTrend\` ON « réglerait » le piège mais **détruirait l'edge** (rendement 4386 % → 149 %). C'est pourquoi la solution passe par la **sortie**, pas par un filtre d'entrée de tendance.

## 6. Modifications Pine exactes proposées (à VALIDER, non appliquées)

### Option recommandée — L
\`\`\`pine
${PINE_L}
\`\`\`

### Option protection maximale — K
\`\`\`pine
${PINE_K}
\`\`\`

Notes d'implémentation :
- Dans ta config, \`maMid\` = EMA24 et \`maFast\` = EMA8 ; \`maFast < maMid\` = « EMA8 sous EMA24 ».
- \`ta.lowest(low, 10)[1]\` = plus-bas des 10 barres **précédentes** (cohérent avec le backtest).
- Comme tes ordres sont remplis **à la clôture** (\`process_orders_on_close\`), la sortie agit le jour même de la cassure — pas de décalage.
- Garde ATR/stops OFF comme demandé. Ces sorties n'utilisent **pas** d'ATR.

## 7. Validation requise avant toute modification du Pine

Ce rapport **ne modifie pas** le script. Avant d'appliquer L (ou K) :
1. Colle le snippet dans une **copie** de ta stratégie.
2. Vérifie sur TradingView que les **22 trades historiques restent globalement intacts** hors crises (L ne doit rien changer en 2020-2021 / 2022-2023).
3. Vérifie que le trade ouvert (entré 2026-02-25) **sort bien** lors de la cassure de mars 2026.
4. Compare DD / PF / nombre de trades aux chiffres de ce rapport.
5. Seulement ensuite, décide d'activer L (recommandé) ou K (protection max).

---

### Fichiers produits
- \`tqqq-strategy-backtest-current.md/.json\` (baseline validé, réconciliation 22/22)
- \`tqqq-2026-drawdown-diagnostic.md/.csv\` (diagnostic crise)
- \`tqqq-exit-candidates.json\` (Étape 5)
- \`tqqq-walkforward.json\` (Étape 6)
- \`tv-trades-TQQQ-2026-06-05.csv\` (référence TradingView)
`;

fs.writeFileSync(path.join(TVDIR, "tqqq-strategy-exit-optimization-report.md"), md);

const json = {
  generatedAt: new Date().toISOString(),
  baseline: baseM,
  criticalWindow: cand.criticalWindow,
  candidates: cand.results,
  walkForward: wf.robustness,
  recommendation: {
    primary: "L",
    primaryRule: "Exit if (EMA8 < EMA24) AND (close < lowest(low,10)[1])",
    alternativeMaxProtection: "K",
    alternativeRule: "Exit if (EMA8 < EMA24) AND (close < EMA24)",
    rejected: ["A", "D", "E", "F", "G", "H", "I", "J", "M"],
    note: "Exit-only fix; do NOT re-enable blockBearTrend (would destroy the counter-trend edge). No ATR used. Pine not modified — validate first.",
  },
};
fs.writeFileSync(path.join(TVDIR, "tqqq-strategy-exit-optimization-report.json"), JSON.stringify(json, null, 2));

console.log("Rapport final écrit :");
console.log(" -", path.relative(ROOT, path.join(TVDIR, "tqqq-strategy-exit-optimization-report.md")));
console.log(" -", path.relative(ROOT, path.join(TVDIR, "tqqq-strategy-exit-optimization-report.json")));
console.log("Recommandation : L (cassure plus-bas 10j si EMA8<EMA24). Alternative protection max : K.");
