/**
 * Support / résistance — niveaux diagnostiques V3.
 * Pure, aucun IO, n’alimente pas le scoring ni la sélection Wheel.
 */
import { round, toNumber } from "../utils/number.js";

const VERSION = "support_resistance_levels_v3";

/** Écart relatif minimal entre deux niveaux conservés (fraction du spot). */
const DEDUPE_SPOT_FRAC = 0.0025;

function normPrice(p) {
  const n = toNumber(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pctFromSpot(price, spot) {
  if (!(normPrice(price) && normPrice(spot))) return null;
  return round((Math.abs(price - spot) / spot) * 100, 4);
}

function pctStrikeVsLevel(strike, price) {
  const k = normPrice(strike);
  const p = normPrice(price);
  if (!(k && p)) return null;
  return round(((p - k) / k) * 100, 4);
}

function dedupeEpsilon(spot) {
  const s = normPrice(spot);
  if (!s) return 0.05;
  return Math.max(s * DEDUPE_SPOT_FRAC, 0.02);
}

/**
 * @param {{ price: number, priority: number }[]} items — triés du « meilleur » au moins bon
 * @returns {{ price: number, priority: number }[]}
 */
function dedupeSorted(items, spot) {
  const eps = dedupeEpsilon(spot);
  const out = [];
  for (const it of items) {
    if (!normPrice(it.price)) continue;
    if (out.some((o) => Math.abs(o.price - it.price) <= eps)) continue;
    out.push(it);
  }
  return out;
}

function confidenceNearAboveSpot(confidenceBase, price, spot) {
  const dist = pctFromSpot(price, spot);
  if (confidenceBase === "high" && dist != null && dist > 5) return "medium";
  return confidenceBase;
}

function findSwingLows(closes, spot) {
  const arr = Array.isArray(closes)
    ? closes.map((x) => toNumber(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  if (arr.length < 3) return [];
  const swings = [];
  for (let i = 1; i < arr.length - 1; i += 1) {
    if (arr[i] < arr[i - 1] && arr[i] < arr[i + 1]) {
      swings.push({ price: arr[i], i });
    }
  }
  const s = normPrice(spot);
  if (s == null) return [];
  const below = swings.filter((w) => w.price < s);
  below.sort((a, b) => b.price - a.price);
  return dedupeSorted(
    below.map((w) => ({ price: w.price, priority: 4 })),
    spot
  ).map((x) => x.price);
}

function findSwingHighs(closes, spot) {
  const arr = Array.isArray(closes)
    ? closes.map((x) => toNumber(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  if (arr.length < 3) return [];
  const swings = [];
  for (let i = 1; i < arr.length - 1; i += 1) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) {
      swings.push({ price: arr[i], i });
    }
  }
  const spt = normPrice(spot);
  if (spt == null) return [];
  const above = swings.filter((w) => w.price > spt);
  above.sort((a, b) => a.price - b.price);
  return dedupeSorted(
    above.map((w) => ({ price: w.price, priority: 4 })),
    spot
  ).map((x) => x.price);
}

function buildEntrySupport(rank, label, price, type, confidence, reason, spot, strike) {
  const p = normPrice(price);
  if (!p) return null;
  const spotN = normPrice(spot);
  const strikeN = normPrice(strike);
  return {
    rank,
    label,
    price: round(p, 4),
    type,
    distanceToSpotPct: spotN ? pctFromSpot(p, spotN) : null,
    distanceToStrikePct: strikeN ? pctStrikeVsLevel(strikeN, p) : null,
    isBelowStrike:
      strikeN != null ? p < strikeN : null,
    confidence,
    reason,
  };
}

function buildEntryResistance(rank, label, price, type, confidence, reason, spot, strike) {
  const p = normPrice(price);
  if (!p) return null;
  const spotN = normPrice(spot);
  const strikeN = normPrice(strike);
  return {
    rank,
    label,
    price: round(p, 4),
    type,
    distanceToSpotPct: spotN ? pctFromSpot(p, spotN) : null,
    distanceToStrikePct: strikeN ? pctStrikeVsLevel(strikeN, p) : null,
    isAboveStrike:
      strikeN != null ? p > strikeN : null,
    confidence,
    reason,
  };
}

/**
 * @param {object} params
 * @returns {object}
 */
export function buildSupportResistanceLevelsV3({
  spot,
  strike,
  dteDays,
  supportResistance,
  priceSeries,
  supportDiagnosticsV1,
  supportScoringV2,
}) {
  const notes = [];
  const spotN = normPrice(spot);
  const strikeN = normPrice(strike);
  const dte =
    dteDays != null && Number.isFinite(Number(dteDays)) ? Number(dteDays) : null;

  const sn = normPrice(supportResistance?.supportNear);
  const sw = normPrice(supportResistance?.supportWide ?? supportResistance?.support);
  const sLeg = normPrice(supportResistance?.support);
  const ra = normPrice(supportResistance?.resistanceAboveSpot);
  const rc = normPrice(
    supportResistance?.resistanceCurrent ?? supportResistance?.resistance
  );
  const rw = normPrice(supportResistance?.resistance);
  const pot = normPrice(supportResistance?.potentialSupportFromBrokenResistance);

  const closes = Array.isArray(priceSeries?.closes) ? priceSeries.closes : null;

  if (!spotN) {
    notes.push("Spot indisponible — niveaux sous / au-dessus du cours non classés.");
  }
  if (!sn && !sw && !ra && !rc && !sLeg && !(closes && closes.length >= 3)) {
    notes.push("Sources support/résistance et série de clôtures insuffisantes pour enrichir V3.");
  }
  if (supportDiagnosticsV1?.notes && Array.isArray(supportDiagnosticsV1.notes)) {
    for (const n of supportDiagnosticsV1.notes.slice(0, 2)) {
      if (typeof n === "string" && n.trim()) notes.push(`Diag V1: ${n.trim()}`);
    }
  }
  const v2lvl = supportScoringV2?.strikeSupportLevelUsed;
  if (v2lvl === "near" || v2lvl === "wide") {
    notes.push(
      `Réf. scoring V2 (diagnostic uniquement) : niveau d'évaluation du strike = ${v2lvl} — V3 n'impacte pas le score.`
    );
  }

  /** @type {{ price: number, priority: number, type: string, confidence: string, reason: string }[]} */
  const supportCandidates = [];
  if (spotN && sn != null && sn < spotN) {
    supportCandidates.push({
      price: sn,
      priority: 0,
      type: "near",
      confidence: confidenceNearAboveSpot("high", sn, spotN),
      reason: "supportNear (sous le spot) — niveau proche chart.",
    });
  }
  if (spotN && sw != null && sw < spotN) {
    supportCandidates.push({
      price: sw,
      priority: 1,
      type: "wide",
      confidence: "medium",
      reason: "supportWide / support quantile — niveau structurel.",
    });
  }
  if (spotN && sLeg != null && sLeg < spotN && (!sw || Math.abs(sLeg - sw) > dedupeEpsilon(spotN) * 0.5)) {
    supportCandidates.push({
      price: sLeg,
      priority: 2,
      type: "wide",
      confidence: "medium",
      reason: "support legacy (provider) sous le spot.",
    });
  }
  if (spotN && pot != null && pot < spotN) {
    supportCandidates.push({
      price: pot,
      priority: 2,
      type: "derived",
      confidence: "medium",
      reason: "potentiel support depuis résistance cassée (provider).",
    });
  }

  if (closes && closes.length >= 3 && spotN) {
    const swings = findSwingLows(closes, spotN);
    for (const p of swings) {
      if (!(p < spotN)) continue;
      supportCandidates.push({
        price: p,
        priority: 3,
        type: "swing",
        confidence: "low",
        reason: "Creux local simple sur clôtures (fenêtre courte) — indicatif seulement.",
      });
    }
  }

  supportCandidates.sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price;
    return a.priority - b.priority;
  });
  const supportKept = dedupeSorted(supportCandidates, spotN).slice(0, 3);

  /** @type {{ price: number, priority: number, type: string, confidence: string, reason: string }[]} */
  const resistCandidates = [];
  if (spotN && ra != null && ra > spotN) {
    resistCandidates.push({
      price: ra,
      priority: 0,
      type: "near",
      confidence: confidenceNearAboveSpot("high", ra, spotN),
      reason: "resistanceAboveSpot — résistance au-dessus du cours.",
    });
  }
  if (spotN && rc != null && rc > spotN && (!ra || Math.abs(rc - ra) > dedupeEpsilon(spotN) * 0.5)) {
    resistCandidates.push({
      price: rc,
      priority: 1,
      type: "wide",
      confidence: "medium",
      reason: "resistanceCurrent (provider) au-dessus du spot.",
    });
  }
  if (spotN && rw != null && rw > spotN && (!rc || Math.abs(rw - rc) > dedupeEpsilon(spotN) * 0.5)) {
    resistCandidates.push({
      price: rw,
      priority: 1,
      type: "wide",
      confidence: "medium",
      reason: "résistance large (quantile) au-dessus du spot.",
    });
  }
  if (spotN && sw != null && sw > spotN) {
    resistCandidates.push({
      price: sw,
      priority: 2,
      type: "wide",
      confidence: "medium",
      reason: "supportWide au-dessus du spot — zone de retournement possible.",
    });
  }

  if (closes && closes.length >= 3 && spotN) {
    const highs = findSwingHighs(closes, spotN);
    for (const p of highs) {
      if (!(p > spotN)) continue;
      resistCandidates.push({
        price: p,
        priority: 3,
        type: "swing",
        confidence: "low",
        reason: "Sommet local simple sur clôtures — indicatif seulement.",
      });
    }
  }

  resistCandidates.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.priority - b.priority;
  });
  const resistKept = dedupeSorted(resistCandidates, spotN).slice(0, 3);

  const supportsBelowSpot = supportKept
    .map((c, i) =>
      buildEntrySupport(
        i + 1,
        `S${i + 1}`,
        c.price,
        c.type,
        c.confidence,
        c.reason,
        spotN,
        strikeN
      )
    )
    .filter(Boolean);

  const resistancesAboveSpot = resistKept
    .map((c, i) =>
      buildEntryResistance(
        i + 1,
        `R${i + 1}`,
        c.price,
        c.type,
        c.confidence,
        c.reason,
        spotN,
        strikeN
      )
    )
    .filter(Boolean);

  const flippedLevels = [];
  if (spotN && rc != null && rc < spotN) {
    flippedLevels.push({
      label: "R cassée → S ?",
      price: round(rc, 4),
      from: "resistance",
      to: "support",
      distanceToSpotPct: pctFromSpot(rc, spotN),
      confidence: "medium",
      reason:
        "resistanceCurrent sous le spot — ancienne résistance pouvant tenir comme support.",
    });
  }
  if (spotN && sw != null && sw > spotN) {
    flippedLevels.push({
      label: "S cassé → R ?",
      price: round(sw, 4),
      from: "support",
      to: "resistance",
      distanceToSpotPct: pctFromSpot(sw, spotN),
      confidence: "medium",
      reason:
        "supportWide au-dessus du spot — support historique pouvant agir comme résistance.",
    });
  }

  const nearestSupportBelowSpot = supportsBelowSpot.length ? supportsBelowSpot[0] : null;
  const nearestResistanceAboveSpot = resistancesAboveSpot.length ? resistancesAboveSpot[0] : null;
  let nearestSupportBelowStrike = null;
  if (strikeN != null && supportsBelowSpot.length) {
    const under = supportsBelowSpot.filter((s) => s.price < strikeN);
    if (under.length) {
      nearestSupportBelowStrike = under.reduce((best, s) => (s.price > best.price ? s : best));
    }
  }

  const parts = [];
  if (supportsBelowSpot.length) {
    parts.push(
      `Supports sous le spot : ${supportsBelowSpot.map((s) => `${s.label} ${s.price}`).join(", ")}.`
    );
  }
  if (resistancesAboveSpot.length) {
    parts.push(
      `Résistances au-dessus : ${resistancesAboveSpot.map((r) => `${r.label} ${r.price}`).join(", ")}.`
    );
  }
  if (!parts.length) {
    parts.push("Niveaux V3 partiels ou absents — voir notes.");
  }
  if (flippedLevels.length) {
    parts.push(`${flippedLevels.length} flip(s) potentiel(s) détecté(s).`);
  }

  const summaryFr = parts.join(" ");

  return {
    version: VERSION,
    enabled: true,
    source: "derived_from_existing_support_resistance_and_price_series",
    diagnosticOnly: true,

    spot: spotN != null ? round(spotN, 4) : null,
    strike: strikeN != null ? round(strikeN, 4) : null,
    dteDays: dte,

    supportsBelowSpot,
    resistancesAboveSpot,
    flippedLevels,

    nearestSupportBelowSpot,
    nearestSupportBelowStrike,
    nearestResistanceAboveSpot,

    summaryFr,
    notes,
  };
}
