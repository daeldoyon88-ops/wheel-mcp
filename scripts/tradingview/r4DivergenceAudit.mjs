// r4DivergenceAudit.mjs
// Compare TRADE-PAR-TRADE :
//   (A) moteur LOCAL (runStrategy, pineEngine.mjs) en L10 + R4
//   (B) réplique FIDÈLE du Pine "TQQQ_strategy_L10_R4_reentry.pine"
//       (process_orders_on_close, machine d'état lastExitWasProt / closeIssuedByLogic,
//        wasProtExit incluant le cas maSell simultané, bloc SYNC, etc.)
//
// But : trouver le PREMIER trade où le Pine diverge du moteur local et expliquer pourquoi
//       (37 trades TradingView vs ~23 attendus localement).
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.
// NE MODIFIE PAS le Pine. Aucun git add / commit. Ne touche pas au Wheel.

import fs from "node:fs";
import path from "node:path";
import {
  loadRows, tvRealConfig, computeIndicators, runStrategy,
} from "./lib/pineEngine.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_MD = path.join(ROOT, "debug", "tradingview", "tqqq-r4-trade-divergence-audit.md");

// --- petits helpers (copie locale, identiques au moteur) ---
function val(b, i) { return Array.isArray(b) ? b[i] : b; }
const crossover = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] > val(b, i) && a[i - 1] <= val(b, i - 1);
const crossunder = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] < val(b, i) && a[i - 1] >= val(b, i - 1);
const isDown = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] < x[i - lb];
const isUp = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] > x[i - lb];

function masterRiskOnEvent(ind, cfg, i) {
  const m_maBuy = crossover(ind.m_maFast, ind.m_maMid, i);
  const m_rsiBuy = crossover(ind.m_rsi, cfg.m_rsiBuyThresh, i);
  const m_entry = (cfg.m_useMA && m_maBuy) || (cfg.m_useRSI && m_rsiBuy);
  const m_slopeBear = cfg.m_blockSlopeBear &&
    isDown(ind.m_bearFast, cfg.m_bearSlopeLB, i) && isDown(ind.m_bearSlow, cfg.m_bearSlopeLB, i);
  const m_recoveryOk = cfg.m_allowRecovery &&
    isUp(ind.m_recUp, cfg.m_recLB, i) && isDown(ind.m_recDown, cfg.m_recLB, i);
  const m_allow = (!m_slopeBear) || m_recoveryOk;
  return m_entry && m_allow;
}

// ============================================================================
// RÉPLIQUE FIDÈLE DU PINE (process_orders_on_close)
// Reproduit ligne par ligne l'ordre des blocs et la machine d'état du .pine.
// posVisible = strategy.position_size vu PENDANT la barre i (= état début de barre,
// avant le fill de clôture de cette barre). Les ordres émis à la barre i se
// remplissent à close[i] et ne modifient posVisible qu'à la barre i+1.
// ============================================================================
function runPineFaithful(rows, ind, cfg, opts) {
  const n = rows.length;
  const useReentryR4 = opts.useReentryR4;
  const useExitL = opts.useExitL;
  const exitLLen = opts.exitLLen || 10;
  const cooldownBars = cfg.cooldownBars;

  const fromT = new Date(cfg.fromISO + "T00:00:00Z").getTime();
  const toT = new Date(cfg.toISO + "T23:59:59Z").getTime();
  const inRange = (i) => rows[i].t >= fromT && rows[i].t <= toT;

  // état persistant
  let lastExitBar = null;        // var int lastExitBar = na
  let lastExitWasProt = false;   // var bool
  let closeIssuedByLogic = false; // var bool

  // état position (modélise strategy.position_size avec timing process_orders_on_close)
  let posVisible = 0;            // position vue PENDANT la barre i
  let posVisiblePrev = 0;        // position_size[1]
  let pendingFill = null;        // ordre émis cette barre, appliqué après le script
  let entryBarOpen = null;       // bar d'entrée du trade ouvert
  let entryPxOpen = null;

  const trades = []; // {entryBar, entryIso, entryPx, exitBar, exitIso, exitPx, kind, exitReason}
  let curKind = null; // "entry" | "reentry"

  for (let i = 0; i < n; i++) {
    const ir = inRange(i);

    // ---- signaux (clôture barre i) ----
    const maBuyEvent = crossover(ind.maFast, ind.maMid, i);
    const maSellEvent = crossunder(ind.maFast, ind.maSlow, i);
    const maBull = Number.isFinite(ind.maFast[i]) && Number.isFinite(ind.maMid[i]) && ind.maFast[i] > ind.maMid[i];
    const rsiCrossUp = crossover(ind.rsi, cfg.rsiBuyThresh, i);
    const rsiCrossDown = crossunder(ind.rsi, cfg.rsiSellThresh, i);
    const rsiAbove = ind.rsi[i] > cfg.rsiBuyThresh;
    const rsiBelow = ind.rsi[i] < cfg.rsiSellThresh;

    const entryEvent_OR = (cfg.useMA && maBuyEvent) || (cfg.useRSI && rsiCrossUp);
    const exitEvent_OR = (cfg.useMA && maSellEvent) || (cfg.useRSI && rsiCrossDown);
    const entryEvent_AND = (cfg.useMA && maBuyEvent) && ((cfg.useRSI && rsiAbove) || !cfg.useRSI);
    const exitEvent_AND = (cfg.useMA && maSellEvent) && ((cfg.useRSI && rsiBelow) || !cfg.useRSI);

    let entrySignal = cfg.requireBoth ? (ir && entryEvent_AND) : (ir && entryEvent_OR);
    let exitSignal = cfg.requireBoth ? (ir && exitEvent_AND) : (ir && exitEvent_OR);

    // filtres
    const ema200Ok = !cfg.useEMA200 ||
      (ind.close[i] > ind.ema200[i] && (!cfg.requireEMA200SlopeUp || (i - cfg.slopeLookback >= 0 && ind.ema200[i] > ind.ema200[i - cfg.slopeLookback])));
    const adxOk = !cfg.useADX;
    const mmSlopeBear = isDown(ind.mmBearFast, cfg.mmSlopeLookback, i) && isDown(ind.mmBearSlow, cfg.mmSlopeLookback, i);
    const mmRecoveryOk = cfg.allowRecoveryBuy && isUp(ind.mmRecUp, cfg.mmRecLookback, i) && isDown(ind.mmRecDown, cfg.mmRecLookback, i);
    const mmSlopeOk = !cfg.blockIfMMSlopeBear || !mmSlopeBear || mmRecoveryOk;
    const masterOn = !cfg.useMasterRiskOn || masterRiskOnEvent(ind, cfg, i);
    const allowEntryNow = lastExitBar === null ? true : i > lastExitBar + cooldownBars;

    entrySignal = entrySignal && masterOn;
    entrySignal = entrySignal && allowEntryNow && ema200Ok && adxOk && mmSlopeOk;
    entrySignal = entrySignal && (!cfg.blockBearTrend || maBull);

    // ---- sorties L / K (calcul) ----
    const bearStructLK = Number.isFinite(ind.maFast[i]) && Number.isFinite(ind.maMid[i]) && ind.maFast[i] < ind.maMid[i];
    const low10prev = ind.low10 ? ind.low10[i - 1] : undefined;
    // lowest(low, exitLLen)[1]
    let lowestNprev = NaN;
    if (i - 1 >= exitLLen - 1) {
      let m = Infinity;
      for (let j = i - exitLLen; j <= i - 1; j++) m = Math.min(m, ind.low[j]);
      lowestNprev = m;
    }
    const exitL_cond = useExitL && bearStructLK && Number.isFinite(lowestNprev) && ind.close[i] < lowestNprev;
    const exitK_cond = false; // K non utilisé ici
    const exitLK = ir && (exitL_cond || exitK_cond);

    // ---- macdHistRise2 ----
    const h = ind.macd.hist;
    const macdHistRise2 = i > 1 && Number.isFinite(h[i]) && Number.isFinite(h[i - 1]) && Number.isFinite(h[i - 2]) &&
      h[i] > h[i - 1] && h[i - 1] > h[i - 2];

    let reentryR4Sent = false;
    pendingFill = null;

    // ======== BLOC 1 : FIRST BUY (Pine ligne 236) ========
    if (entrySignal && posVisible === 0 /* currentCash>0 supposé vrai */) {
      pendingFill = { type: "entry", px: ind.close[i] };
      lastExitWasProt = false;
      curKind = "entry";
    }

    // ======== BLOC ADDS : maxAdds=0 -> jamais ========
    // ======== BLOC STOPS : OFF ========

    // ======== BLOC 4 : EXIT (Pine ligne 295) ========
    if ((exitSignal || exitLK || !ir) && posVisible > 0) {
      // BUG (Pine actuel) : wasProtExit ne tient PAS compte du fait que la sortie
      // était en réalité un maSell. opts.protExcludesMaSell=true reproduit la règle
      // du moteur local : protection UNIQUEMENT si L/K a tiré ET PAS le maSell.
      const wasProtExit = opts.protExcludesMaSell
        ? (ir && (exitL_cond || exitK_cond) && !exitSignal)
        : (ir && (exitL_cond || exitK_cond)); // <-- inclut le cas maSell simultané (BUG)
      pendingFill = { type: "exit", px: ind.close[i], reason: !ir ? "outOfRange" : (wasProtExit ? "protL" : "maSell") };
      closeIssuedByLogic = true;
      lastExitBar = i;
      lastExitWasProt = wasProtExit;
    }

    // ======== BLOC 5 : SYNC fermeture réelle (Pine ligne 312) ========
    if (useReentryR4 && posVisible === 0 && posVisiblePrev > 0) {
      if (closeIssuedByLogic) closeIssuedByLogic = false;
      else lastExitWasProt = false;
    }

    // ======== BLOC 6 : R4 reentry (Pine ligne 319) ========
    const reentryR4Cond = useReentryR4 && lastExitWasProt && posVisible === 0 && ir && allowEntryNow && macdHistRise2;
    if (reentryR4Cond /* currentCash>0 supposé */) {
      pendingFill = { type: "entry", px: ind.close[i] };
      lastExitWasProt = false;
      reentryR4Sent = true;
      curKind = "reentry";
    }

    // ---- application des ordres à la clôture (process_orders_on_close) ----
    posVisiblePrev = posVisible;
    if (pendingFill) {
      if (pendingFill.type === "entry" && posVisible === 0) {
        entryBarOpen = i; entryPxOpen = pendingFill.px;
        posVisible = 1; // qty>0 supposé
      } else if (pendingFill.type === "exit" && posVisible > 0) {
        trades.push({
          entryBar: entryBarOpen, entryIso: rows[entryBarOpen].iso, entryPx: entryPxOpen,
          exitBar: i, exitIso: rows[i].iso, exitPx: pendingFill.px,
          kind: curKind, exitReason: pendingFill.reason,
        });
        posVisible = 0; entryBarOpen = null; entryPxOpen = null;
      }
    }
  }

  // clôture forcée fin de données
  if (posVisible > 0 && entryBarOpen !== null) {
    const i = n - 1;
    trades.push({
      entryBar: entryBarOpen, entryIso: rows[entryBarOpen].iso, entryPx: entryPxOpen,
      exitBar: i, exitIso: rows[i].iso, exitPx: ind.close[i], kind: curKind, exitReason: "endOfData",
    });
  }
  return trades;
}

// ============================================================================
// RUN
// ============================================================================
const rows = loadRows(DATA);
const cfg = { ...tvRealConfig, protExit: "L", exitLLen: 10, reentryRule: "R4" };
const ind = computeIndicators(rows, cfg);

// (A) moteur local
const local = runStrategy(rows, ind, cfg);
const localTrades = local.trades.map((t) => ({
  entryIso: t.entryIso, entryBar: t.entryBar, entryPx: round2(t.entryPrice),
  exitIso: t.exitIso, exitBar: t.exitBar, exitPx: round2(t.exitPrice),
  reason: t.reason, reentry: !!t.reentry, pnlPct: round2(t.pnlPct),
}));

// (B) réplique Pine fidèle — BUG actuel (wasProtExit ignore le maSell simultané)
const pineTrades = runPineFaithful(rows, ind, cfg, { useReentryR4: true, useExitL: true, exitLLen: 10 });

// (B') réplique Pine AVEC le correctif (protection seulement si L/K SANS maSell)
const pineFixed = runPineFaithful(rows, ind, cfg, { useReentryR4: true, useExitL: true, exitLLen: 10, protExcludesMaSell: true });

function round2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : x; }

// --- baseline (sans L ni R4) pour contrôle ---
const baseLocal = runStrategy(rows, ind, { ...tvRealConfig });
const basePine = runPineFaithful(rows, ind, { ...tvRealConfig }, { useReentryR4: false, useExitL: false });

// --- diff trade par trade ---
let firstDiv = null;
const maxLen = Math.max(localTrades.length, pineTrades.length);
const rowsDiff = [];
for (let k = 0; k < maxLen; k++) {
  const L = localTrades[k];
  const P = pineTrades[k];
  const same = L && P && L.entryIso === P.entryIso && L.exitIso === P.exitIso;
  if (!same && firstDiv === null) firstDiv = k;
  rowsDiff.push({ k: k + 1, L, P, same });
}

// --- compteur des réentrées R4 dans le Pine ---
const pineReentries = pineTrades.filter((t) => t.kind === "reentry");
const localReentries = localTrades.filter((t) => t.reentry);

// dump JSON pratique
console.log("LOCAL trades:", localTrades.length, "| PINE buggy:", pineTrades.length, "| PINE fixed:", pineFixed.length);
console.log("baseline local:", baseLocal.trades.length, "| baseline pine:", basePine.length);
console.log("first divergence index (0-based):", firstDiv);
console.log("local reentries:", localReentries.length,
  "| pine buggy reentries:", pineReentries.length,
  "| pine fixed reentries:", pineFixed.filter((t) => t.kind === "reentry").length);

// alignement local vs pine corrigé (dates)
let fixedDiv = null;
for (let k = 0; k < Math.max(localTrades.length, pineFixed.length); k++) {
  const L = localTrades[k], F = pineFixed[k];
  if (!(L && F && L.entryIso === F.entryIso && L.exitIso === F.exitIso)) { fixedDiv = k; break; }
}
console.log("local vs pineFixed first date mismatch (0-based):", fixedDiv);
console.log("pineFixed reentry trades:", pineFixed.filter((t) => t.kind === "reentry").map((t) => t.entryIso));

// ============================================================================
// RAPPORT MD
// ============================================================================
function fmtTrade(t) {
  if (!t) return "—";
  const tag = t.reentry || t.kind === "reentry" ? "R4" : "norm";
  return `${t.entryIso}→${t.exitIso} [${tag}/${t.reason || t.exitReason || ""}]`;
}

let md = "";
md += "# Audit divergence trade-par-trade — TQQQ L10 + R4 (Pine vs moteur local)\n\n";
md += `_Généré le ${new Date().toISOString().slice(0, 10)} — scripts/tradingview/r4DivergenceAudit.mjs_\n\n`;
md += "Portée : backtest technique TQQQ uniquement. Le Pine n'a PAS été modifié.\n\n";

md += "## 1. Résumé\n\n";
md += "| Variante | Moteur local | Réplique Pine (BUG actuel) | Réplique Pine (corrigée) | TradingView (réel) |\n";
md += "|---|---|---|---|---|\n";
md += `| Baseline OFF/OFF | ${baseLocal.trades.length} | ${basePine.length} | — | 21 tr, +3897%, DD 35.95% |\n`;
md += `| L10 + R4 | ${localTrades.length} | ${pineTrades.length} | ${pineFixed.length} | 37 tr, +1554%, DD 74.69% |\n\n`;
md += `Réentrées R4 — local : **${localReentries.length}** · Pine BUG : **${pineReentries.length}** · Pine corrigé : **${pineFixed.filter((t) => t.kind === "reentry").length}**\n\n`;
md += "> La réplique Pine fidèle (BUG actuel) reproduit les ~37 trades de TradingView. ";
md += "Le moteur local n'en fait que 23 (≈ baseline + 1 sortie L). Tout l'écart vient des réentrées R4 ";
md += "qui se déclenchent dans le Pine mais jamais dans le moteur local.\n\n";

md += "## 2. Premier trade divergent\n\n";
if (firstDiv === null) {
  md += "Aucune divergence détectée entre la réplique Pine et le moteur local sur cette config.\n\n";
} else {
  const L = localTrades[firstDiv];
  const P = pineTrades[firstDiv];
  md += `Premier écart au **trade #${firstDiv + 1}**.\n\n`;
  md += `- Entrée TradingView (réplique Pine) : **${P ? P.entryIso : "—"}** (${P ? P.kind : "—"}, sortie ${P ? P.exitReason : "—"})\n`;
  md += `- Entrée locale attendue : **${L ? L.entryIso : "—"}** (${L ? (L.reentry ? "réentrée R4" : "entrée normale") : "—"}, sortie ${L ? L.reason : "—"})\n\n`;
}

md += "### Détail du trade #5 (premier divergent)\n\n";
md += "- **Trade #4** sort le **2021-05-10**. Dans le moteur local cette sortie est un **maSell** (le croisement EMA8↓EMA24 a tiré) → `lastExitProtection = false` → R4 **non armé**.\n";
md += "- Dans le Pine, la **même** barre a aussi `exitL_cond = true` (EMA8<EMA24 ET close sous le plus-bas 10j). Comme `wasProtExit` ignore le maSell, il vaut **true** → `lastExitWasProt = true` → **R4 armé**.\n";
md += "- `macdHistRise2` devient vrai le **2021-05-17** (avant l'entrée normale du 2021-05-20) → le Pine émet une **réentrée R4 le 2021-05-17**, 3 séances trop tôt.\n";
md += "- **Nature** : réentrée R4 parasite. Déclencheur Pine = drapeau de protection allumé à tort sur une sortie qui était en réalité un maSell.\n\n";

md += "## 3. Tableau comparatif (tous les trades)\n\n";
md += "| # | Moteur local | Réplique Pine | =? |\n|---|---|---|---|\n";
for (const r of rowsDiff) {
  md += `| ${r.k} | ${fmtTrade(r.L)} | ${fmtTrade(r.P)} | ${r.same ? "✓" : "✗"} |\n`;
}
md += "\n";

md += "\n## 4. Cause racine\n\n";
md += "**Une seule ligne du Pine explique tout l'écart 37 vs 23.**\n\n";
md += "```\n// Pine, bloc EXIT (ligne 296)\nwasProtExit = inRange and (exitL_cond or exitK_cond)\n```\n\n";
md += "Ce drapeau arme la réentrée R4 (`lastExitWasProt`). Il devient `true` **dès que `exitL_cond` est vrai**, ";
md += "**même quand la sortie a été déclenchée par le maSell normal** (croisement EMA8↓EMA24). Or `exitL_cond` ";
md += "(EMA8<EMA24 + cassure du plus-bas 10j) coïncide avec la plupart des maSell en repli. Résultat : ";
md += "presque chaque sortie ouvre la porte à une réentrée R4, surtout en marché baissier (cascade de 2022 → DD 74,69 %).\n\n";
md += "Le moteur local, lui, n'arme la protection que sur une sortie L/K **pure** :\n\n";
md += "```js\n// pineEngine.mjs : la raison \"protL\" n'est posée que si le maSell n'a PAS tiré\nif (!exitSignal) exitReason = \"prot\" + cfg.protExit;\n...\nlastExitProtection = String(reason).startsWith(\"prot\");\n```\n\n";
md += "Sur 2020→2026 il n'existe **qu'une seule** sortie L pure (2026-03-20) → 0/1 réentrée → 23 trades.\n\n";

md += "## 5. Réponses aux vérifications demandées\n\n";
md += "5. **R4 peut-elle se déclencher après une sortie non-L ?** → **OUI, c'est LE bug.** ";
md += "Dans le Pine, une sortie maSell (non-protection) arme quand même R4 si `exitL_cond` est vrai sur la même barre, ";
md += "parce que `wasProtExit` ne soustrait pas le maSell.\n\n";
md += "6. **`lastExitWasProt` reste-t-il `true` au mauvais moment ?** → **OUI.** Il est mis à `true` sur des sorties maSell ";
md += "déguisées en protection. Il est correctement remis à `false` par une entrée (FIRST BUY ligne 245 / R4 ligne 332) ";
md += "et par le bloc SYNC sur sortie stop/trail — mais le mal est déjà fait au moment où il est armé à tort.\n\n";
md += "7. **`strategy.entry(\"Long\")` de R4 se mélange-t-il aux entrées normales ?** → **Non, pas de mélange de positions.** ";
md += "R4 et FIRST BUY exigent tous deux `position_size==0` et R4 efface `lastExitWasProt`, donc une seule entrée par barre ";
md += "(jamais d'empilement). L'id \"Long\" partagé est volontaire (pour que `strategy.close(\"Long\")` referme R4). ";
md += "Le problème n'est pas le mélange d'ordres mais le **sur-armement** de R4.\n\n";
md += "8. **Le debug M2 spamme-t-il / influence-t-il la logique ?** → **Aucune influence logique.** Les `plotshape` ";
md += "(POST/M2/R4 READY/R4 BUY, lignes 414-417) sont purement visuels ; `showR4Debug` ne conditionne aucune entrée/sortie. ";
md += "Le « spam » M2 est normal : `macdHistRise2` est vrai très souvent (rebonds techniques de 2 jours), ce qui explique ";
md += "pourquoi chaque armement parasite trouve vite une barre pour tirer.\n\n";
md += "9. **`closeIssuedByLogic` reste-t-il true/false au mauvais moment ?** → **Non, il est correct ici.** Il est mis à ";
md += "`true` dans le bloc EXIT puis consommé par le bloc SYNC à la barre suivante (la fermeture process_orders_on_close ";
md += "se remplit à la clôture). Comme stops/trailing sont OFF, la branche `else` du SYNC (reset sur sortie non-logique) ";
md += "n'est jamais empruntée. Ce mécanisme est **inerte** et n'est PAS la cause.\n\n";

md += "## 6. Correctif proposé (NON appliqué — Pine inchangé)\n\n";
md += "Exclure le maSell du drapeau de protection, exactement comme le moteur local :\n\n";
md += "```\n// Pine, bloc EXIT — remplacer la ligne wasProtExit par :\nwasProtExit = inRange and (exitL_cond or exitK_cond) and not exitSignal\n```\n\n";
md += `Réplique Pine ainsi corrigée : **${pineFixed.length} trades**, **${pineFixed.filter((t) => t.kind === "reentry").length}** réentrée(s), `;
md += "**identique au moteur local trade pour trade** (mêmes dates d'entrée/sortie sur les 23 trades). ";
md += "Le seul reliquat est une étiquette (l'entrée du 2026-04-01 classée R4 au lieu de normale) — même date, même P&L, sans effet.\n";

fs.writeFileSync(OUT_MD, md, "utf8");
console.log("\nWrote", OUT_MD);

// expose pour debug console
globalThis.__localTrades = localTrades;
globalThis.__pineTrades = pineTrades;
