// pineEngine.mjs
// Reproduction fidèle (best-effort) de la logique du script Pine
// "MA(8/34/50)+RSI+Scaling(%cash)+Filters+ATRStops (PRO)+MM Slope Blocks + MASTER Risk-ON"
// pour la configuration TQQQ de l'utilisateur (swing, CELI).
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.
// Ne touche à rien d'autre dans le repo.
//
// Hypothèses de fidélité documentées dans la section "écarts possibles vs TradingView"
// du rapport (debug/tradingview/tqqq-strategy-backtest-current.md).

import fs from "node:fs";

// ----------------------------------------------------------------------------
// Indicateurs (réplication des fonctions ta.* de Pine v5)
// ----------------------------------------------------------------------------

// ta.ema : EMA standard, alpha = 2/(len+1), première valeur = source (seed na->src)
export function ema(values, len) {
  const alpha = 2 / (len + 1);
  const out = new Array(values.length).fill(NaN);
  let prev;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = NaN; continue; }
    if (prev === undefined) { prev = v; }
    else { prev = alpha * v + (1 - alpha) * prev; }
    out[i] = prev;
  }
  return out;
}

// ta.rma (Wilder) : alpha = 1/len, seed = SMA des len premières valeurs valides
export function rma(values, len) {
  const out = new Array(values.length).fill(NaN);
  let prev;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = NaN; continue; }
    if (prev === undefined) {
      sum += v; count++;
      if (count === len) { prev = sum / len; out[i] = prev; }
    } else {
      prev = (prev * (len - 1) + v) / len;
      out[i] = prev;
    }
  }
  return out;
}

// ta.change(src) = src - src[1]
export function change(values) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1];
  return out;
}

// ta.rsi : up/down lissés par rma
export function rsi(values, len) {
  const ch = change(values);
  const up = ch.map((x) => (Number.isFinite(x) ? Math.max(x, 0) : NaN));
  const dn = ch.map((x) => (Number.isFinite(x) ? -Math.min(x, 0) : NaN));
  const rUp = rma(up, len);
  const rDn = rma(dn, len);
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const u = rUp[i], d = rDn[i];
    if (!Number.isFinite(u) || !Number.isFinite(d)) { out[i] = NaN; continue; }
    if (d === 0) out[i] = 100;
    else if (u === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + u / d);
  }
  return out;
}

// MACD standard 12/26/9 (sert seulement aux candidates de sortie)
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) =>
    Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i]) ? emaFast[i] - emaSlow[i] : NaN
  );
  const sig = ema(line, signal);
  const hist = line.map((_, i) =>
    Number.isFinite(line[i]) && Number.isFinite(sig[i]) ? line[i] - sig[i] : NaN
  );
  return { line, signal: sig, hist };
}

// lowest(low, len) "tel qu'à la barre i" (inclut i)
export function lowest(values, len) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) continue;
    let m = Infinity;
    for (let j = i - len + 1; j <= i; j++) m = Math.min(m, values[j]);
    out[i] = m;
  }
  return out;
}

// ta.atr = rma(trueRange, len)
export function atr(high, low, close, len) {
  const tr = new Array(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++) {
    if (i === 0) { tr[i] = high[i] - low[i]; continue; }
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  return rma(tr, len);
}

export function highest(values, len) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) continue;
    let m = -Infinity;
    for (let j = i - len + 1; j <= i; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

const crossover = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] > val(b, i) && a[i - 1] <= val(b, i - 1);
const crossunder = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] < val(b, i) && a[i - 1] >= val(b, i - 1);
// b peut être un tableau ou une constante
function val(b, i) { return Array.isArray(b) ? b[i] : b; }

const isDown = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] < x[i - lb];
const isUp = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] > x[i - lb];

// ----------------------------------------------------------------------------
// Chargement données
// ----------------------------------------------------------------------------
export function loadRows(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const rows = raw.rows.map((r) => ({
    date: r.date,
    t: new Date(r.date).getTime(),
    iso: new Date(r.date).toISOString().slice(0, 10),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

// ----------------------------------------------------------------------------
// Config par défaut = config UI RÉELLE de l'utilisateur, VALIDÉE par
// réconciliation 22/22 trades vs export "List of Trades" TradingView (2026-06-05).
// Découvertes lors de la réconciliation (≠ de ce qui était supposé au départ) :
//   - blockBearTrend = OFF  (sinon raterait l'entrée 2020-04-08 où EMA8<EMA24)
//   - useEMA200      = OFF  (achats sous l'EMA200 autorisés)
//   - blockIfMMSlopeBear = OFF (sinon raterait l'entrée 2025-04-24, +100.88%)
//   - execMode = "close" (TradingView remplit à la clôture -> process_orders_on_close)
//   - initialCapital = 10000
// ----------------------------------------------------------------------------
export const userConfig = {
  // dates de la stratégie (input.time du Pine)
  fromISO: "2020-01-01",
  toISO: "2030-12-31",

  // MA / RSI chart
  useMA: true, maFastLen: 8, maMidLen: 24, maSlowLen: 24,
  useRSI: true, rsiLen: 14, rsiBuyThresh: 47, rsiSellThresh: 1,
  requireBoth: false, blockBearTrend: false, // VALIDÉ : OFF

  // EMA200
  useEMA200: false, ema200Len: 200, requireEMA200SlopeUp: false, slopeLookback: 20, // VALIDÉ : OFF

  // ADX
  useADX: false, adxLen: 14, adxMin: 20,

  // MM pente (blocage)
  blockIfMMSlopeBear: false, mmBearFastLen: 50, mmBearSlowLen: 200, mmSlopeLookback: 60, // VALIDÉ : OFF

  // recovery override
  allowRecoveryBuy: true, mmRecUpLen: 50, mmRecDownLen: 200, mmRecLookback: 20,

  // MASTER
  useMasterRiskOn: true, // symbole maître = TQQQ lui-même
  m_useMA: true, m_maFastLen: 8, m_maMidLen: 34,
  m_useRSI: true, m_rsiLen: 14, m_rsiBuyThresh: 48,
  m_blockSlopeBear: true, m_bearFastLen: 50, m_bearSlowLen: 200, m_bearSlopeLB: 100,
  m_allowRecovery: true, m_recUpLen: 75, m_recDownLen: 200, m_recLB: 46,

  // sizing
  initialPct: 100, addPct: 25,
  useTimeAdds: false, scaleEveryDays: 2, maxAdds: 0, requireRSIForAdds: false,
  useDipAdds: false, atrLen: 14, dipATRmult: 1.0,

  // stops
  useStopLoss: false, stopLossPct: 5, useTrailATR: false, trailATRmult: 3.0,

  // cooldown
  cooldownBars: 2,

  // capital
  initialCapital: 10000, // VALIDÉ vs export TradingView

  // exécution : "close" = TradingView remplit à la clôture (process_orders_on_close) -> VALIDÉ
  //             "nextOpen" = fill à l'open de la barre suivante (défaut TV classique)
  execMode: "close",

  // candidate de sortie additionnelle (null = aucune, baseline)
  exitCandidate: null, // "A".."M"

  // ---- PHASE 2 : sortie de protection paramétrable + réentrées optionnelles ----
  // protExit : null | "L" | "K"  (n'affecte rien si null -> baseline strict)
  //   L : EMA8<EMA24 ET close < lowest(low, exitLLen)[1]
  //   K : EMA8<EMA24 ET close < EMA24, confirmé sur kConfirmDays barres
  protExit: null,
  exitLLen: 10,
  kConfirmDays: 1,
  // reentryRule : null | "R1".."R6" — réentrée autorisée UNIQUEMENT après une sortie de protection
  reentryRule: null,
};

// ----------------------------------------------------------------------------
// tvRealConfig = VRAIE source de vérité TradingView (correction 2026-06-05).
// Daël confirme que « Bloquer achats si 2 MM descendent (pente) » a TOUJOURS été ON
// dans son script performant. Diagnostic de réconciliation :
//   - blockIfMMSlopeBear = ON (et non OFF comme supposé avant)
//   - mmSlopeLookback    = 100  (et non 60) -> valeur identique au MASTER (m_bearSlopeLB=100)
// Pourquoi ce lookback : au 2025-04-24 (creux du krach tarifaire), la MA200 descend
// sur 60 barres mais PAS sur 100 barres. Avec lookback 60, le blocage tue l'entrée
// 2025-04-24 (+100.9 %, présente dans l'export TV) ; avec lookback 100, l'entrée passe.
// Le recovery local ne peut PAS sauver cette entrée (MA50 monotone décroissante ce jour-là),
// donc seul le lookback explique l'écart. Résultat : blocage ON + lookback 100 reproduit
// EXACTEMENT les 22/22 trades de l'export TradingView (identique à l'ancienne config OFF
// sur ces données, mais conforme aux réglages réels de Daël).
// Tout le reste est inchangé : MA 8/24/24, RSI 47/1, MASTER ON, recovery ON, 100 % cash,
// 0 add, stops/trailing/scaling OFF, cooldown 2, capital 10 000 $, fill à la clôture.
// ----------------------------------------------------------------------------
export const tvRealConfig = {
  ...userConfig,
  blockIfMMSlopeBear: true, // VRAI réglage : ON
  mmSlopeLookback: 100,     // aligné sur le MASTER -> reproduit l'entrée 2025-04-24
};

// ----------------------------------------------------------------------------
// Calcul des indicateurs + signaux dérivés
// ----------------------------------------------------------------------------
export function computeIndicators(rows, cfg) {
  const close = rows.map((r) => r.close);
  const high = rows.map((r) => r.high);
  const low = rows.map((r) => r.low);

  const ind = {};
  ind.maFast = ema(close, cfg.maFastLen);
  ind.maMid = ema(close, cfg.maMidLen);
  ind.maSlow = ema(close, cfg.maSlowLen);
  ind.rsi = rsi(close, cfg.rsiLen);
  ind.ema200 = ema(close, cfg.ema200Len);

  // MM pente (chart)
  ind.mmBearFast = ema(close, cfg.mmBearFastLen);
  ind.mmBearSlow = ema(close, cfg.mmBearSlowLen);
  ind.mmRecUp = ema(close, cfg.mmRecUpLen);
  ind.mmRecDown = ema(close, cfg.mmRecDownLen);

  // MASTER (sur TQQQ = même close)
  ind.m_maFast = ema(close, cfg.m_maFastLen);
  ind.m_maMid = ema(close, cfg.m_maMidLen);
  ind.m_rsi = rsi(close, cfg.m_rsiLen);
  ind.m_bearFast = ema(close, cfg.m_bearFastLen);
  ind.m_bearSlow = ema(close, cfg.m_bearSlowLen);
  ind.m_recUp = ema(close, cfg.m_recUpLen);
  ind.m_recDown = ema(close, cfg.m_recDownLen);

  // MACD + extras pour candidates
  ind.macd = macd(close);
  ind.atr = atr(high, low, close, cfg.atrLen);
  ind.low5 = lowest(low, 5);
  ind.low10 = lowest(low, 10);
  ind.lowN = lowest(low, cfg.exitLLen || 10); // pour la sortie L paramétrable (phase 2)
  ind.ma50 = ema(close, 50); // = mmBearFast mais nommé pour candidate H

  ind.close = close; ind.high = high; ind.low = low;
  return ind;
}

// État master persistant (pour candidates qui parlent de "MASTER OFF")
// On définit un ÉTAT risk-off = EMA8 < EMA34 sur TQQQ (tendance master baissière),
// distinct de l'ÉVÈNEMENT masterRiskOn utilisé pour les entrées.
function masterRiskOffState(ind, i) {
  return Number.isFinite(ind.m_maFast[i]) && Number.isFinite(ind.m_maMid[i]) &&
    ind.m_maFast[i] < ind.m_maMid[i];
}

// ÉVÈNEMENT masterRiskOn (filtre d'entrée, fidèle au Pine f_masterRiskOn)
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

// ----------------------------------------------------------------------------
// Signaux de sortie candidates (Étape 5). Renvoyés en plus de la sortie baseline.
// Chaque candidate est documentée précisément.
// ----------------------------------------------------------------------------
function candidateExit(letter, ind, i, ctx) {
  const c = ind.close;
  const maFast = ind.maFast[i];      // = MA8
  const maMid = ind.maMid[i];        // = MA24
  const macdHist = ind.macd.hist;
  const histFalling = i > 0 && Number.isFinite(macdHist[i]) && Number.isFinite(macdHist[i - 1]) && macdHist[i] < macdHist[i - 1];
  const rsiFalling = i > 0 && Number.isFinite(ind.rsi[i]) && Number.isFinite(ind.rsi[i - 1]) && ind.rsi[i] < ind.rsi[i - 1];
  const breakLow5 = Number.isFinite(ind.low5[i - 1]) && c[i] < ind.low5[i - 1]; // casse le plus bas des 5 jours précédents
  const closeBelowMA8 = Number.isFinite(maFast) && c[i] < maFast;
  const closeBelowMA24 = Number.isFinite(maMid) && c[i] < maMid;
  const mOff = masterRiskOffState(ind, i);

  // extension : prix a été >10% au-dessus de MA50 dans les 10 derniers jours
  let extendedRecently = false;
  for (let j = Math.max(0, i - 10); j <= i; j++) {
    if (Number.isFinite(ind.ma50[j]) && c[j] > ind.ma50[j] * 1.10) { extendedRecently = true; break; }
  }

  switch (letter) {
    case "A": // MASTER OFF seul (état risk-off du master)
      return mOff;
    case "B": // MASTER OFF + close < MA8
      return mOff && closeBelowMA8;
    case "C": // MASTER OFF + close < MA24
      return mOff && closeBelowMA24;
    case "D": // close < MA8 + MACD hist baisse
      return closeBelowMA8 && histFalling;
    case "E": // close < MA8 + RSI baisse
      return closeBelowMA8 && rsiFalling;
    case "F": // close < MA8 + break low 5 jours
      return closeBelowMA8 && breakLow5;
    case "G": // top protection : close<MA8 + hist falling + rsi falling + break low 5
      return closeBelowMA8 && histFalling && rsiFalling && breakLow5;
    case "H": // après extension : >10% au-dessus MA50 (10j) puis close<MA8 + hist falling
      return extendedRecently && closeBelowMA8 && histFalling;
    // --- candidates ciblées ajoutées (sorties d'ÉTAT, pas d'évènement) ---
    case "I": // close < MA24 (état simple)
      return closeBelowMA24;
    case "J": { // close < MA50 (état lent)
      const ma50 = ind.ma50[i];
      return Number.isFinite(ma50) && c[i] < ma50;
    }
    case "K": // structure baissière : EMA8 < EMA24 ET close < MA24 (protège seulement quand bear)
      return Number.isFinite(maFast) && Number.isFinite(maMid) && maFast < maMid && closeBelowMA24;
    case "L": { // cassure du plus-bas 10j EN structure baissière (laisse courir les tendances saines)
      const bear = Number.isFinite(maFast) && Number.isFinite(maMid) && maFast < maMid;
      const breakLow10 = Number.isFinite(ind.low10[i - 1]) && c[i] < ind.low10[i - 1];
      return bear && breakLow10;
    }
    case "M": { // cassure plus-bas 10j seule (Donchian), sans condition de MA
      return Number.isFinite(ind.low10[i - 1]) && c[i] < ind.low10[i - 1];
    }
    default:
      return false;
  }
}

// ---- PHASE 2 : sortie de protection paramétrable (L avec N variable, K confirmée) ----
function protectionExit(cfg, ind, i) {
  if (!cfg.protExit) return false;
  const maFast = ind.maFast[i], maMid = ind.maMid[i], c = ind.close[i];
  if (!Number.isFinite(maFast) || !Number.isFinite(maMid)) return false;
  const bear = maFast < maMid;
  if (!bear) return false;
  if (cfg.protExit === "L") {
    return Number.isFinite(ind.lowN[i - 1]) && c < ind.lowN[i - 1];
  }
  if (cfg.protExit === "K") {
    const days = Math.max(1, cfg.kConfirmDays | 0);
    for (let j = i; j > i - days; j--) {
      if (j < 0) return false;
      const f = ind.maFast[j], m = ind.maMid[j], cc = ind.close[j];
      if (!(Number.isFinite(f) && Number.isFinite(m) && f < m && cc < m)) return false;
    }
    return true;
  }
  return false;
}

// ---- PHASE 2 : règles de réentrée (utilisées UNIQUEMENT après une sortie de protection) ----
function reentryFires(rule, ind, i) {
  if (!rule) return false;
  const c = ind.close, maFast = ind.maFast, rsi = ind.rsi, hist = ind.macd.hist;
  const rsiCrossUp = i > 0 && Number.isFinite(rsi[i]) && rsi[i] > 47 && rsi[i - 1] <= 47;
  const closeCrossUpMA8 = i > 0 && Number.isFinite(maFast[i]) && c[i] > maFast[i] && c[i - 1] <= maFast[i - 1];
  const rsiAbove = Number.isFinite(rsi[i]) && rsi[i] > 47;
  const closeAboveMA8 = Number.isFinite(maFast[i]) && c[i] > maFast[i];
  const histRising1 = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] > hist[i - 1];
  const histRising2 = i > 1 && histRising1 && hist[i - 1] > hist[i - 2];
  switch (rule) {
    case "R1": return rsiCrossUp;                       // RSI croise au-dessus 47
    case "R2": return closeCrossUpMA8;                  // close repasse au-dessus EMA8
    case "R3": return rsiAbove && closeAboveMA8;        // RSI>47 ET close>EMA8
    case "R4": return histRising2;                      // MACD hist remonte 2 jours
    case "R5": return rsiAbove && histRising1;          // RSI>47 ET hist remonte
    case "R6": return closeAboveMA8 && histRising1;     // close>EMA8 ET hist remonte
    default: return false;
  }
}

// ----------------------------------------------------------------------------
// Simulation de la stratégie
// ----------------------------------------------------------------------------
export function runStrategy(rows, ind, cfg) {
  const n = rows.length;
  const msInDay = 24 * 60 * 60 * 1000;
  const fromT = new Date(cfg.fromISO + "T00:00:00Z").getTime();
  const toT = new Date(cfg.toISO + "T23:59:59Z").getTime();

  let cash = cfg.initialCapital;
  let pos = 0;            // qty
  let avgPrice = 0;
  let lastExitBar = null;

  // état adds / stops (réplique du Pine)
  let addsCount = 0;
  let lastAddTime = null;
  let lastEntryPrice = null;
  let trailStop = null;
  let lastExitProtection = false; // dernière sortie = sortie de protection L/K ? (gate réentrée)
  let reentryCount = 0;           // nb de réentrées effectuées (diagnostic)

  const trades = [];
  let open = null; // trade ouvert (round-trip flat->flat)
  const equityCurve = [];

  let pending = null; // {type:'entry'|'exit', reason}

  const inRange = (i) => rows[i].t >= fromT && rows[i].t <= toT;

  // ouverture (1er achat) ; kind = "entry" | "reentry"
  const doEntry = (i, execPrice, kind = "entry") => {
    const amount = cash * (cfg.initialPct / 100);
    const qty = execPrice > 0 ? Math.floor(amount / execPrice) : 0;
    if (qty <= 0) return;
    cash -= qty * execPrice;
    pos += qty;
    avgPrice = execPrice;
    addsCount = 0;
    lastAddTime = rows[i].t;
    lastEntryPrice = execPrice;
    trailStop = null;
    open = {
      entryIso: rows[i].iso, entryBar: i, entryPrice: execPrice, qtyInit: qty,
      adds: 0, maxAdverseClose: 0, lowestClose: execPrice, reentry: kind === "reentry",
    };
    lastExitProtection = false; // toute entrée consomme l'état "post-protection"
  };

  // ajout (pyramiding)
  const doAdd = (i, execPrice) => {
    const currentCash = cash; // cash réel restant
    const amount = currentCash * (cfg.addPct / 100);
    const qty = execPrice > 0 ? Math.floor(amount / execPrice) : 0;
    if (qty <= 0) return;
    cash -= qty * execPrice;
    avgPrice = (avgPrice * pos + qty * execPrice) / (pos + qty);
    pos += qty;
    addsCount += 1;
    lastAddTime = rows[i].t;
    lastEntryPrice = execPrice;
    if (open) open.adds += 1;
  };

  const doExit = (i, execPrice, reason) => {
    if (pos <= 0 || !open) return;
    cash += pos * execPrice;
    const pnl = (execPrice - avgPrice) * pos;
    const pnlPct = (execPrice / avgPrice - 1) * 100;
    const days = Math.round((rows[i].t - rows[open.entryBar].t) / msInDay);
    trades.push({
      entryIso: open.entryIso, exitIso: rows[i].iso,
      entryBar: open.entryBar, exitBar: i,
      entryPrice: open.entryPrice, avgPrice, exitPrice: execPrice,
      qty: pos, adds: open.adds, pnl, pnlPct,
      barsHeld: i - open.entryBar, calendarDays: days,
      maxAdverseClosePct: open.maxAdverseClose, reason,
    });
    pos = 0; avgPrice = 0; open = null;
    addsCount = 0; lastAddTime = null; lastEntryPrice = null; trailStop = null;
    lastExitBar = i;
    lastExitProtection = String(reason).startsWith("prot");
  };

  for (let i = 0; i < n; i++) {
    // 1) fill de l'ordre market en attente (mode nextOpen) à l'open de cette barre
    if (cfg.execMode === "nextOpen" && pending) {
      const px = rows[i].open;
      if (pending.type === "entry" && pos === 0) doEntry(i, px);
      else if (pending.type === "reentry" && pos === 0) { doEntry(i, px, "reentry"); reentryCount++; }
      else if (pending.type === "add" && pos > 0) doAdd(i, px);
      else if (pending.type === "exit" && pos > 0) doExit(i, px, pending.reason);
      pending = null;
    }

    // 2) stops intrabar (standing orders actifs depuis la barre précédente)
    if (pos > 0 && open) {
      // stop loss fixe
      if (cfg.useStopLoss) {
        const slPrice = avgPrice * (1 - cfg.stopLossPct / 100);
        if (rows[i].low <= slPrice) {
          const fill = rows[i].open < slPrice ? rows[i].open : slPrice;
          doExit(i, fill, "stopLoss");
        }
      }
    }
    if (pos > 0 && open && cfg.useTrailATR && trailStop !== null) {
      if (rows[i].low <= trailStop) {
        const fill = rows[i].open < trailStop ? rows[i].open : trailStop;
        doExit(i, fill, "trailATR");
      }
    }

    // 3) MAJ drawdown intra-trade (close)
    if (open) {
      if (rows[i].close < open.lowestClose) open.lowestClose = rows[i].close;
      const adv = (open.lowestClose / open.entryPrice - 1) * 100;
      if (adv < open.maxAdverseClose) open.maxAdverseClose = adv;
    }

    // 4) signaux à la clôture de la barre i
    const ir = inRange(i);
    const maBuyEvent = crossover(ind.maFast, ind.maMid, i);
    const maSellEvent = crossunder(ind.maFast, ind.maSlow, i);
    const maBull = Number.isFinite(ind.maFast[i]) && Number.isFinite(ind.maMid[i]) && ind.maFast[i] > ind.maMid[i];
    const rsiCrossUp = crossover(ind.rsi, cfg.rsiBuyThresh, i);
    const rsiCrossDown = crossunder(ind.rsi, cfg.rsiSellThresh, i);
    const rsiAbove = ind.rsi[i] > cfg.rsiBuyThresh;
    const rsiBelow = ind.rsi[i] < cfg.rsiSellThresh;

    const entryEvent = cfg.requireBoth
      ? ((cfg.useMA && maBuyEvent) && ((cfg.useRSI && rsiAbove) || !cfg.useRSI))
      : ((cfg.useMA && maBuyEvent) || (cfg.useRSI && rsiCrossUp));
    const baseExitEvent = cfg.requireBoth
      ? ((cfg.useMA && maSellEvent) && ((cfg.useRSI && rsiBelow) || !cfg.useRSI))
      : ((cfg.useMA && maSellEvent) || (cfg.useRSI && rsiCrossDown));

    // filtres d'entrée
    const ema200Ok = !cfg.useEMA200 ||
      (ind.close[i] > ind.ema200[i] && (!cfg.requireEMA200SlopeUp || (i - cfg.slopeLookback >= 0 && ind.ema200[i] > ind.ema200[i - cfg.slopeLookback])));
    const adxOk = !cfg.useADX;
    const mmSlopeBear = isDown(ind.mmBearFast, cfg.mmSlopeLookback, i) && isDown(ind.mmBearSlow, cfg.mmSlopeLookback, i);
    const mmRecoveryOk = cfg.allowRecoveryBuy && isUp(ind.mmRecUp, cfg.mmRecLookback, i) && isDown(ind.mmRecDown, cfg.mmRecLookback, i);
    const mmSlopeOk = !cfg.blockIfMMSlopeBear || !mmSlopeBear || mmRecoveryOk;
    const masterOn = !cfg.useMasterRiskOn || masterRiskOnEvent(ind, cfg, i);
    const allowEntryNow = lastExitBar === null ? true : i > lastExitBar + cfg.cooldownBars;

    let entrySignal = ir && entryEvent && masterOn && allowEntryNow && ema200Ok && adxOk && mmSlopeOk;
    entrySignal = entrySignal && (!cfg.blockBearTrend || maBull);

    // sortie : baseline + candidate optionnelle (phase 1) + protection paramétrable (phase 2)
    let exitSignal = ir && baseExitEvent;
    let exitReason = exitSignal ? "maSell" : null;
    if (pos > 0 && cfg.exitCandidate) {
      if (candidateExit(cfg.exitCandidate, ind, i, { cfg })) {
        if (!exitSignal) exitReason = "candidate" + cfg.exitCandidate;
        exitSignal = true;
      }
    }
    if (pos > 0 && cfg.protExit && ir) {
      if (protectionExit(cfg, ind, i)) {
        if (!exitSignal) exitReason = "prot" + cfg.protExit;
        exitSignal = true;
      }
    }
    const forceExit = !ir;

    // réentrée optionnelle : seulement après une sortie de protection, hors position
    const reentrySignal = cfg.reentryRule && pos === 0 && lastExitProtection && ir &&
      allowEntryNow && cash > 0 && reentryFires(cfg.reentryRule, ind, i);

    // 5) ADDS (signal calculé à la clôture, fill comme l'entrée)
    const aFromT = lastAddTime !== null;
    const timeOk = aFromT && (rows[i].t - lastAddTime >= cfg.scaleEveryDays * msInDay);
    const dipOk = lastEntryPrice !== null && Number.isFinite(ind.atr[i]) && rows[i].close <= lastEntryPrice - cfg.dipATRmult * ind.atr[i];
    const canAddBySignal = (cfg.useMA && maBull) || (cfg.useRSI && rsiAbove);
    let canAdd = cfg.requireRSIForAdds ? (cfg.useRSI && rsiAbove) : canAddBySignal;
    canAdd = canAdd && (!cfg.blockBearTrend || maBull) && ema200Ok && adxOk && ir && mmSlopeOk;
    const doTimeAdd = cfg.useTimeAdds && timeOk;
    const doDipAdd = cfg.useDipAdds && dipOk;
    const wantAdd = pos > 0 && addsCount < cfg.maxAdds && cash > 0 && canAdd && (doTimeAdd || doDipAdd);

    // 6) émission ordres
    if (cfg.execMode === "nextOpen") {
      if ((exitSignal || forceExit) && pos > 0 && !pending) {
        pending = { type: "exit", reason: forceExit ? "outOfRange" : exitReason };
      } else if (entrySignal && pos === 0 && cash > 0 && !pending) {
        pending = { type: "entry", reason: "entry" };
      } else if (reentrySignal && !pending) {
        pending = { type: "reentry", reason: "reentry" };
      } else if (wantAdd && !pending) {
        pending = { type: "add", reason: "add" };
      }
    } else {
      if ((exitSignal || forceExit) && pos > 0) doExit(i, rows[i].close, forceExit ? "outOfRange" : exitReason);
      else if (entrySignal && pos === 0 && cash > 0) doEntry(i, rows[i].close);
      else if (reentrySignal) { doEntry(i, rows[i].close, "reentry"); reentryCount++; }
      else if (wantAdd) doAdd(i, rows[i].close);
    }

    // 7) MAJ trailing stop à la clôture (servira de standing order la barre suivante)
    if (pos > 0 && cfg.useTrailATR && Number.isFinite(ind.atr[i])) {
      const newTrail = rows[i].close - cfg.trailATRmult * ind.atr[i];
      trailStop = trailStop === null ? newTrail : Math.max(trailStop, newTrail);
    }

    // 8) equity mark-to-market
    equityCurve.push({ iso: rows[i].iso, t: rows[i].t, equity: cash + pos * rows[i].close, close: rows[i].close, inPosition: pos > 0 });
  }

  if (pos > 0) {
    const i = n - 1;
    doExit(i, rows[i].close, "endOfData");
    equityCurve[equityCurve.length - 1].equity = cash;
  }

  const out = computeMetrics(rows, cfg, trades, equityCurve);
  out.metrics.reentryCount = reentryCount;
  return out;
}

// ----------------------------------------------------------------------------
// Métriques
// ----------------------------------------------------------------------------
function computeMetrics(rows, cfg, trades, equityCurve) {
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : cfg.initialCapital;
  const totalReturnPct = (finalEquity / cfg.initialCapital - 1) * 100;

  // max drawdown sur courbe d'équité (close)
  let peak = -Infinity, maxDD = 0, peakIso = null, troughIso = null, curPeakIso = null;
  for (const p of equityCurve) {
    if (p.equity > peak) { peak = p.equity; curPeakIso = p.iso; }
    const dd = peak > 0 ? (p.equity - peak) / peak * 100 : 0;
    if (dd < maxDD) { maxDD = dd; peakIso = curPeakIso; troughIso = p.iso; }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const winRate = trades.length ? wins.length / trades.length * 100 : 0;

  const barsInPos = equityCurve.filter((p) => p.inPosition).length;
  const exposurePct = equityCurve.length ? barsInPos / equityCurve.length * 100 : 0;
  const totalBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0);

  return {
    config: {
      fromISO: cfg.fromISO, toISO: cfg.toISO, execMode: cfg.execMode,
      exitCandidate: cfg.exitCandidate,
      maFastLen: cfg.maFastLen, maMidLen: cfg.maMidLen, maSlowLen: cfg.maSlowLen,
      rsiBuyThresh: cfg.rsiBuyThresh, rsiSellThresh: cfg.rsiSellThresh,
      useMasterRiskOn: cfg.useMasterRiskOn, initialPct: cfg.initialPct,
      maxAdds: cfg.maxAdds, cooldownBars: cfg.cooldownBars,
    },
    metrics: {
      totalReturnPct: round(totalReturnPct, 2),
      finalEquity: round(finalEquity, 2),
      maxDrawdownPct: round(maxDD, 2),
      maxDDPeakIso: peakIso, maxDDTroughIso: troughIso,
      numTrades: trades.length,
      winRatePct: round(winRate, 2),
      profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 2) : "Inf",
      exposurePct: round(exposurePct, 2),
      barsInPosition: barsInPos,
      totalBarsHeld,
      avgBarsHeld: trades.length ? round(totalBarsHeld / trades.length, 1) : 0,
      avgTradePnlPct: trades.length ? round(trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length, 2) : 0,
    },
    trades,
    equityCurve,
  };
}

export function round(x, d) {
  if (!Number.isFinite(x)) return x;
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}
