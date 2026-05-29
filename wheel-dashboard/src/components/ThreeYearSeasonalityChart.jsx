/**
 * Graphique 3 ans — prix réel + fenêtres annuelles officielles (panneau Saisonnalité annuelle réelle).
 * SVG maison, thème sombre cohérent avec SeasonalityPanel.
 */
import React, { useMemo, useState, useCallback, useRef } from "react";

const C = {
  panel:       "#0b1626",
  card:        "#101d31",
  cardInner:   "#0d1a2b",
  border:      "rgba(120,150,190,0.18)",
  accent:      "#8b5cf6",
  accentLight: "#a78bfa",
  green:       "#22c55e",
  red:         "#ef4444",
  yellow:      "#facc15",
  amber:       "#f59e0b",
  text:        "#e5edf8",
  textMuted:   "#8fa3bf",
  textFaint:   "#4a6580",
  line:        "#c4d4ef",
};

const FR_MONTHS_SHORT = [
  "jan.", "fév.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sep.", "oct.", "nov.", "déc.",
];

const PACE_LABELS = {
  behind:       "En retard",
  on_track:     "Normal",
  ahead:        "En avance",
  too_advanced: "Très avancé",
};

const STATUS_LABELS = {
  complete:          "Terminée",
  in_progress:       "En cours",
  insufficient_data: "Données insuffisantes",
};

const W = 920;
const H = 330;
const H_RSI = 100;
const PAD = { top: 14, right: 52, bottom: 28, left: 8 };
const PAD_RSI = { top: 8, right: 52, bottom: 18, left: 8 };
const RSI_MIN_VALID_POINTS = 20;

// ─── RSI 14 (série alignée priceSeries, sans appel API) ───────────────────────

export function computeRsi14(priceSeries) {
  if (!Array.isArray(priceSeries) || !priceSeries.length) return [];

  const PERIOD = 14;
  const points = priceSeries.map((p) => ({
    date: p.date,
    close: typeof p.close === "number" && isFinite(p.close) ? p.close : null,
    rsi: null,
  }));

  const validIndices = [];
  const closes = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].close != null) {
      validIndices.push(i);
      closes.push(points[i].close);
    }
  }

  if (closes.length < PERIOD + 1) return points;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= PERIOD; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= PERIOD;
  avgLoss /= PERIOD;

  const calcRsi = (ag, al) => {
    if (al === 0) return 100;
    const rs = ag / al;
    return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
  };

  points[validIndices[PERIOD]].rsi = calcRsi(avgGain, avgLoss);

  for (let vi = PERIOD + 1; vi < closes.length; vi++) {
    const change = closes[vi] - closes[vi - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (PERIOD - 1) + gain) / PERIOD;
    avgLoss = (avgLoss * (PERIOD - 1) + loss) / PERIOD;
    points[validIndices[vi]].rsi = calcRsi(avgGain, avgLoss);
  }

  return points;
}

export function getRsiMomentumState(rsiSeries) {
  const valid = (rsiSeries ?? []).filter(
    (p) => typeof p.rsi === "number" && isFinite(p.rsi),
  );
  if (valid.length < 6) return null;

  const rsiCurrent = valid[valid.length - 1].rsi;
  const rsiPrev5 = valid.length > 5 ? valid[valid.length - 6].rsi : rsiCurrent;
  const rsiPrev10 = valid.length > 10 ? valid[valid.length - 11].rsi : rsiPrev5;

  const slope5 = rsiCurrent - rsiPrev5;
  const slope10 = rsiCurrent - rsiPrev10;

  const last10 = valid.slice(-10);
  const crossedAbove50Recently = last10.some((p, i) => {
    if (i === last10.length - 1) return false;
    return p.rsi < 50 && last10[i + 1].rsi >= 50;
  });

  const approaching50FromBelow = rsiCurrent >= 45 && rsiCurrent < 50 && slope5 > 0;
  const rising = slope5 > 0 && slope10 > 0;

  let label;
  let shortLabel;
  if (rsiCurrent >= 70) {
    label = "Surchauffe";
    shortLabel = "Surchauffe";
  } else if (rsiCurrent >= 55 && rsiCurrent < 70 && rising) {
    label = "Momentum positif";
    shortLabel = "Positif";
  } else if (
    (rsiCurrent >= 45 && rsiCurrent < 55 && (rising || crossedAbove50Recently))
    || approaching50FromBelow
  ) {
    label = "Préparation momentum";
    shortLabel = "Préparation";
  } else if (rsiCurrent < 45 && rising) {
    label = "Reprise précoce";
    shortLabel = "Reprise";
  } else if (slope5 <= 0 || slope10 <= 0) {
    label = "Momentum faible";
    shortLabel = "Faible";
  } else {
    label = "Momentum neutre";
    shortLabel = "Neutre";
  }

  return {
    rsiCurrent,
    rsiPrev5,
    rsiPrev10,
    slope5,
    slope10,
    crossedAbove50Recently,
    approaching50FromBelow,
    rising,
    label,
    shortLabel,
  };
}

function countValidRsiPoints(rsiSeries) {
  return (rsiSeries ?? []).filter((p) => typeof p.rsi === "number" && isFinite(p.rsi)).length;
}

function rsiByDateMap(rsiSeries) {
  const map = new Map();
  for (const p of rsiSeries ?? []) {
    if (p.date && typeof p.rsi === "number" && isFinite(p.rsi)) map.set(p.date, p.rsi);
  }
  return map;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function formatPct(val, signed = true) {
  if (typeof val !== "number" || !isFinite(val)) return "—";
  const abs = Math.abs(val * 100).toFixed(1);
  if (signed) return val >= 0 ? `+${abs} %` : `-${abs} %`;
  return `${abs} %`;
}

export function formatPrice(val) {
  if (typeof val !== "number" || !isFinite(val)) return "—";
  return `${val.toFixed(2)} $`;
}

export function formatDateIso(iso) {
  if (!iso) return "—";
  const parts = String(iso).split("-");
  if (parts.length !== 3) return iso;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!y || !m || !d) return iso;
  return `${d} ${FR_MONTHS_SHORT[m - 1] ?? ""} ${y}`;
}

function formatDateRangeShort(startIso, endIso) {
  if (!startIso || !endIso) return "—";
  const fmtShort = (iso) => {
    const [, m, d] = iso.split("-").map(Number);
    return `${d} ${FR_MONTHS_SHORT[m - 1] ?? ""}`.trim();
  };
  return `${fmtShort(startIso)} → ${fmtShort(endIso)}`;
}

function formatPctWhole(val) {
  if (typeof val !== "number" || !isFinite(val)) return "—";
  if (val >= 0 && val <= 1) return `${Math.round(val * 100)} %`;
  if (val > 1 && val <= 100) return `${Math.round(val)} %`;
  return "—";
}

function formatConfidenceLabel(raw) {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("multi")) return "Robuste multi-horizons";
  if (v === "robuste") return "Robuste";
  if (v === "mesurable") return "Mesurable";
  if (v === "préliminaire" || v === "preliminaire") return "Préliminaire";
  if (v === "échantillon limité" || v === "echantillon limite") return "Échantillon limité";
  if (raw) return String(raw);
  return "—";
}

function normalizeRate(val) {
  if (typeof val !== "number" || !isFinite(val)) return null;
  if (val >= 0 && val <= 1) return val;
  if (val > 1 && val <= 100) return val / 100;
  return null;
}

function getDisplayConfidence(rawConfidence, sampleSize, multiHorizonConfidence) {
  const raw = multiHorizonConfidence ?? rawConfidence;
  if (sampleSize == null) {
    const formatted = formatConfidenceLabel(raw);
    return formatted !== "—" ? formatted : "Historique disponible";
  }
  const multi = String(multiHorizonConfidence ?? "").toLowerCase();
  if (multi.includes("multi")) return "Robuste multi-horizons";
  if (sampleSize < 5) return "Échantillon limité";
  if (sampleSize < 8) {
    if (multi === "robuste" || multi === "mesurable") return formatConfidenceLabel(multi);
    return "Préliminaire";
  }
  if (sampleSize < 12) {
    if (multi.includes("multi")) return "Robuste multi-horizons";
    if (multi === "robuste") return "Robuste";
    return "Mesurable";
  }
  const formatted = formatConfidenceLabel(raw);
  return formatted !== "—" ? formatted : "Robuste possible";
}

function formatHorizonStatsMatrix(horizonStats, isBullish) {
  if (!horizonStats || typeof horizonStats !== "object") return [];
  const order = ["3y", "5y", "10y", "15y"];
  const lines = [];
  for (const key of order) {
    const s = horizonStats[key];
    if (!s || s.sampleSize == null) continue;
    const rate = isBullish ? s.winRate : (s.downRate ?? (s.winRate != null ? 1 - s.winRate : null));
    const ratePct = rate != null ? `${Math.round(rate * 100)} %` : "—";
    const ret = typeof s.avgReturn === "number" ? formatPct(s.avgReturn) : "—";
    lines.push({
      text: `${key}  ${ret} · ${ratePct} · n=${s.sampleSize}`,
      color: C.textFaint,
    });
  }
  return lines;
}

function formatOccurrenceCount(sampleSize) {
  if (typeof sampleSize !== "number" || !isFinite(sampleSize) || sampleSize <= 0) return null;
  const n = Math.round(sampleSize);
  return n === 1 ? "1 occurrence" : `${n} occurrences`;
}

function getSampleSize(source) {
  if (!source || typeof source !== "object") return null;
  const totalOcc = typeof source.totalOccurrences === "number" ? source.totalOccurrences : null;
  const occ = typeof source.occurrences === "number" ? source.occurrences : null;
  const candidates = [
    source.displaySampleSize,
    source.primaryHorizonSampleSize,
    source.primaryHorizon && source.horizonStats?.[source.primaryHorizon]?.sampleSize,
    source.sampleSize,
  ];
  if (occ != null && (totalOcc == null || occ !== totalOcc)) {
    candidates.push(occ);
  }
  candidates.push(source.years, source.observations, source.occurrencesCount);
  for (const n of candidates) {
    if (typeof n === "number" && isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function normalizeRateFraction(val) {
  return normalizeRate(val);
}

function getDirectionalWinRate(source, type) {
  if (!source) return null;
  const isBullish = type === "bullish";

  if (typeof source.displayWinRate === "number" && isFinite(source.displayWinRate)) {
    const dr = normalizeRateFraction(source.displayWinRate);
    if (dr != null) return dr;
  }

  if (isBullish && typeof source.bullishWinRate === "number") {
    return normalizeRate(source.bullishWinRate);
  }
  if (!isBullish && typeof source.bearishWinRate === "number") {
    return normalizeRate(source.bearishWinRate);
  }
  if (!isBullish && typeof source.downRate === "number") {
    return normalizeRate(source.downRate);
  }

  const winRate = normalizeRate(source.winRate);
  if (winRate == null) return null;
  return isBullish ? winRate : 1 - winRate;
}

function getChartOverlays(data) {
  return data?.annualOverlays ?? [];
}

function overlayTypeLabel(type) {
  if (type === "bullish") return "Fenêtre annuelle haussière";
  if (type === "vigilance") return "Vigilance récente — non confirmée long terme";
  return "Fenêtre annuelle baissière confirmée";
}

function overlayTypeColor(type) {
  if (type === "bullish") return C.green;
  if (type === "vigilance") return C.amber;
  return C.red;
}

function buildHistoricalContextLines(overlay) {
  const lines = [];
  lines.push({
    text: overlayTypeLabel(overlay.type),
    color: overlayTypeColor(overlay.type),
    bold: true,
  });

  const realYears = (overlay.occurrences ?? []).filter(
    (o) => o.status === "complete" && o.realizedReturn != null,
  ).length;
  if (realYears > 0) {
    lines.push({
      text: realYears === 1
        ? "1 rendement par année civile"
        : `${realYears} rendements par année civile`,
      color: C.textMuted,
    });
  }

  if (typeof overlay.expectedReturn === "number" && isFinite(overlay.expectedReturn)) {
    lines.push({
      text: `Rendement annuel moyen : ${formatPct(overlay.expectedReturn)}`,
      color: overlayTypeColor(overlay.type),
    });
  }

  if (overlay.strength) {
    lines.push({ text: `Force : ${overlay.strength}`, color: C.textFaint });
  }
  if (overlay.type === "vigilance" && overlay.status) {
    lines.push({ text: `Statut : ${overlay.status}`, color: C.textFaint });
  }

  return lines;
}

function findMixedZones(bands) {
  const bullish = bands.filter((b) => b.type === "bullish");
  const bearish = bands.filter((b) => b.type === "bearish" || b.type === "vigilance");
  const mixed = [];
  for (const bull of bullish) {
    for (const bear of bearish) {
      const left = Math.max(bull.left, bear.left);
      const right = Math.min(bull.left + bull.width, bear.left + bear.width);
      const width = right - left;
      if (width >= 3) {
        mixed.push({
          key: `mix-${bull.key}-${bear.key}`,
          left,
          width,
          centerX: left + width / 2,
          bullBand: bull,
          bearBand: bear,
        });
      }
    }
  }
  return mixed;
}

function bandCenterInMixedZone(band, mixedZones) {
  for (const mix of mixedZones) {
    if (band.centerX >= mix.left && band.centerX <= mix.left + mix.width) return true;
  }
  return false;
}

function buildYearLabelText(band, year, currentYear) {
  const ret = formatPct(band.occ.realizedReturn);
  if (band.status === "in_progress" && year === currentYear) return `Actuel ${ret}`;
  return `${year} ${ret}`;
}

function scoreLabelCandidate(band, year, currentYear, minLabelWidth) {
  let score = 0;
  if (band.status === "in_progress") score += 1000;
  if (typeof band.occ?.realizedReturn === "number" && isFinite(band.occ.realizedReturn)) score += 200;
  if (band.width >= minLabelWidth) score += 80;
  else if (band.width >= minLabelWidth * 0.65) score += 30;
  score += Math.min(Math.abs(band.occ?.realizedReturn ?? 0) * 400, 60);
  if ((band.occ?.year ?? 0) === year) score += 40;
  if (year === currentYear && band.status === "in_progress") score += 50;
  return score;
}

/** Sélectionne au plus un label pertinent par année visible, avec décalage vertical anti-collision. */
function selectUniformYearLabels(overlayBands, mixedZones, rangeStart, rangeEnd) {
  const MIN_LABEL_WIDTH = 44;
  const MIN_LABEL_GAP = 58;
  const Y_OFFSET_STEP = 11;
  const currentYear = new Date().getFullYear();

  if (!rangeStart || !rangeEnd) return [];

  const startYear = parseInt(String(rangeStart).slice(0, 4), 10);
  const endYear = parseInt(String(rangeEnd).slice(0, 4), 10);
  if (!startYear || !endYear) return [];

  const picks = [];
  for (let year = startYear; year <= endYear; year++) {
    const clearCandidates = overlayBands.filter((band) => {
      const bandYear = band.occ?.year;
      const isActiveThisYear = year === currentYear && band.status === "in_progress";
      if (bandYear !== year && !isActiveThisYear) return false;
      if (typeof band.occ?.realizedReturn !== "number" || !isFinite(band.occ.realizedReturn)) return false;
      if (bandCenterInMixedZone(band, mixedZones)) return false;
      return true;
    });

    if (clearCandidates.length === 0) continue;

    clearCandidates.sort((a, b) => {
      const diff = scoreLabelCandidate(b, year, currentYear, MIN_LABEL_WIDTH)
        - scoreLabelCandidate(a, year, currentYear, MIN_LABEL_WIDTH);
      if (diff !== 0) return diff;
      return (b.occ?.year ?? 0) - (a.occ?.year ?? 0);
    });

    const best = clearCandidates[0];
    picks.push({
      band: best,
      year,
      centerX: best.centerX,
      labelText: buildYearLabelText(best, year, currentYear),
      yOffset: 0,
    });
  }

  picks.sort((a, b) => a.centerX - b.centerX);
  for (let i = 1; i < picks.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(picks[i].centerX - picks[j].centerX) < MIN_LABEL_GAP) {
        const nextOffset = Math.max(picks[i].yOffset, picks[j].yOffset + Y_OFFSET_STEP);
        if (nextOffset <= Y_OFFSET_STEP * 2) picks[i].yOffset = nextOffset;
      }
    }
  }

  return picks;
}

function buildYearLines(rangeStart, rangeEnd, xOf) {
  if (!rangeStart || !rangeEnd) return [];
  const startYear = parseInt(String(rangeStart).slice(0, 4), 10);
  const endYear = parseInt(String(rangeEnd).slice(0, 4), 10);
  if (!startYear || !endYear) return [];
  const lines = [];
  for (let y = startYear; y <= endYear; y++) {
    const jan1 = `${y}-01-01`;
    if (jan1 >= rangeStart && jan1 <= rangeEnd) {
      lines.push({ year: y, x: xOf(jan1) });
    }
  }
  return lines;
}

function dateToMs(iso) {
  return new Date(`${iso}T00:00:00.000Z`).getTime();
}

function clipDates(startDate, endDate, rangeStart, rangeEnd) {
  const start = startDate < rangeStart ? rangeStart : startDate;
  const end = endDate > rangeEnd ? rangeEnd : endDate;
  if (start > end) return null;
  return { start, end };
}

function buildInterpretation(active) {
  if (!active?.isActive) return null;
  const { type, paceStatus } = active;
  if (type === "bullish") {
    if (paceStatus === "on_track") return "Le mouvement suit la fenêtre historique.";
    if (paceStatus === "too_advanced") return "Une grande partie du potentiel historique est déjà réalisée.";
    if (paceStatus === "ahead") return "Le mouvement avance plus vite que la moyenne historique.";
    if (paceStatus === "behind") return "Le mouvement est en retard sur son rythme historique.";
  }
  if (type === "bearish") {
    if (paceStatus === "on_track") return "La baisse saisonnière suit son rythme historique.";
    if (paceStatus === "too_advanced") return "Une grande partie du mouvement baissier attendu semble déjà réalisée.";
    if (paceStatus === "ahead") return "La baisse progresse plus vite que la moyenne historique.";
    if (paceStatus === "behind") return "La baisse est en retard par rapport au rythme historique.";
  }
  return null;
}

// ─── Active window summary ────────────────────────────────────────────────────

function ActiveWindowSummary({ active }) {
  if (!active?.isActive) {
    return (
      <div style={{
        background: C.cardInner,
        border: `1px solid ${C.border}`,
        borderRadius: "8px",
        padding: "10px 14px",
        fontSize: "11.5px",
        color: C.textMuted,
      }}>
        Aucune fenêtre annuelle active aujourd&apos;hui.
      </div>
    );
  }

  const typeLabel = active.type === "bullish"
    ? "Haussière"
    : active.type === "vigilance"
      ? "Vigilance récente"
      : "Baissière";
  const typeColor = active.type === "bullish"
    ? C.green
    : active.type === "vigilance"
      ? C.amber
      : C.red;
  const paceLabel = PACE_LABELS[active.paceStatus] ?? active.paceStatus ?? "—";
  const interpretation = buildInterpretation(active);

  const paceColor =
    active.paceStatus === "behind" ? C.yellow
      : active.paceStatus === "too_advanced" ? C.accentLight
        : active.paceStatus === "ahead" ? C.green
          : C.textMuted;

  const statStyle = { fontSize: "10px", color: C.textFaint, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: "2px" };
  const valStyle = { fontSize: "13px", fontWeight: 700, color: C.text };

  return (
    <div style={{
      background: C.cardInner,
      border: `1px solid ${C.border}`,
      borderRadius: "8px",
      padding: "12px 14px",
    }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", marginBottom: "10px" }}>
        <span style={{ fontSize: "12.5px", fontWeight: 700, color: C.text }}>
          Fenêtre annuelle active : {active.displayLabel ?? formatDateRangeShort(active.startDate, active.endDate)}
        </span>
        <span style={{
          background: active.type === "bullish"
            ? "rgba(34,197,94,0.12)"
            : active.type === "vigilance"
              ? "rgba(245,158,11,0.12)"
              : "rgba(239,68,68,0.12)",
          border: `1px solid ${active.type === "bullish"
            ? "rgba(34,197,94,0.3)"
            : active.type === "vigilance"
              ? "rgba(245,158,11,0.35)"
              : "rgba(239,68,68,0.3)"}`,
          color: typeColor,
          borderRadius: "20px",
          padding: "2px 10px",
          fontSize: "10.5px",
          fontWeight: 700,
        }}>
          {typeLabel}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px 16px" }}>
        <div>
          <div style={statStyle}>Rendement annuel moyen</div>
          <div style={{ ...valStyle, color: typeColor }}>{formatPct(active.expectedReturn)}</div>
        </div>
        <div>
          <div style={statStyle}>Réalisé actuel</div>
          <div style={{ ...valStyle, color: active.realizedReturn >= 0 ? C.green : C.red }}>
            {formatPct(active.realizedReturn)}
          </div>
        </div>
        <div>
          <div style={statStyle}>Temps écoulé</div>
          <div style={valStyle}>{formatPctWhole(active.progressTimePct)}</div>
        </div>
        <div>
          <div style={statStyle}>Progression attendue</div>
          <div style={valStyle}>{formatPctWhole(active.progressReturnPct)}</div>
        </div>
        <div>
          <div style={statStyle}>Rythme</div>
          <div style={{ ...valStyle, color: paceColor }}>{paceLabel}</div>
        </div>
      </div>
      {interpretation && (
        <div style={{ marginTop: "8px", fontSize: "10.5px", color: C.textMuted, fontStyle: "italic", lineHeight: 1.5 }}>
          {interpretation}
        </div>
      )}
    </div>
  );
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function ChartTooltip({ tooltip, chartHeight = H }) {
  if (!tooltip) return null;
  const { x, y, lines } = tooltip;
  const maxW = 220;
  const lineH = 15;
  const pad = 8;
  const boxH = lines.length * lineH + pad * 2;
  const boxW = maxW;

  let left = x + 12;
  let top = y - boxH / 2;
  if (left + boxW > W - 4) left = x - boxW - 12;
  if (top < 4) top = 4;
  if (top + boxH > chartHeight - 4) top = chartHeight - boxH - 4;

  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={left}
        y={top}
        width={boxW}
        height={boxH}
        rx="4"
        fill="rgba(7,17,31,0.94)"
        stroke="rgba(120,150,190,0.35)"
        strokeWidth="1"
      />
      {lines.map((line, i) => (
        <text
          key={i}
          x={left + pad}
          y={top + pad + 11 + i * lineH}
          fontSize="9.5"
          fill={line.color ?? C.textMuted}
          fontWeight={line.bold ? 700 : 400}
        >
          {line.text}
        </text>
      ))}
    </g>
  );
}

// ─── Main chart ───────────────────────────────────────────────────────────────

function SeasonalityChartSvg({ data, rsiSeries, rsiMomentum }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const activeProgress = data?.activeWindowProgress;

  const chartModel = useMemo(() => {
    const priceSeries = data?.priceSeries ?? [];
    const range = data?.range ?? {};
    const rangeStart = range.startDate;
    const rangeEnd = range.endDate;

    if (!priceSeries.length || !rangeStart || !rangeEnd) return null;

    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;
    const t0 = dateToMs(rangeStart);
    const t1 = dateToMs(rangeEnd);
    const span = t1 - t0 || 1;

    const xOf = (iso) => {
      const ratio = (dateToMs(iso) - t0) / span;
      return PAD.left + Math.max(0, Math.min(1, ratio)) * chartW;
    };

    const closes = priceSeries.map((p) => p.close).filter((v) => typeof v === "number" && isFinite(v));
    if (!closes.length) return null;

    const minClose = Math.min(...closes);
    const maxClose = Math.max(...closes);
    const padPct = 0.04;
    const priceSpan = maxClose - minClose || maxClose * 0.05 || 1;
    const yMin = minClose - priceSpan * padPct;
    const yMax = maxClose + priceSpan * padPct;
    const yRange = yMax - yMin || 1;

    const yOf = (price) => PAD.top + (1 - (price - yMin) / yRange) * chartH;

    const linePath = priceSeries
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.date).toFixed(1)} ${yOf(p.close).toFixed(1)}`)
      .join(" ");

    const firstClose = priceSeries[0]?.close;
    const areaPath = `${linePath} L ${xOf(priceSeries[priceSeries.length - 1].date).toFixed(1)} ${(PAD.top + chartH).toFixed(1)} L ${xOf(priceSeries[0].date).toFixed(1)} ${(PAD.top + chartH).toFixed(1)} Z`;

    const gridCount = 5;
    const gridLines = Array.from({ length: gridCount }, (_, i) => {
      const price = yMin + (yRange / (gridCount - 1)) * i;
      return { price, y: yOf(price) };
    });

    const tickCount = 6;
    const timeTicks = Array.from({ length: tickCount }, (_, i) => {
      const ratio = i / (tickCount - 1);
      const ms = t0 + span * ratio;
      const iso = new Date(ms).toISOString().slice(0, 10);
      return { iso, x: PAD.left + ratio * chartW };
    });

    const overlayBands = [];
    for (const overlay of getChartOverlays(data)) {
      for (const occ of overlay.occurrences ?? []) {
        const clipped = clipDates(occ.startDate, occ.endDate, rangeStart, rangeEnd);
        if (!clipped) continue;
        const x1 = xOf(clipped.start);
        const x2 = xOf(clipped.end);
        const left = Math.min(x1, x2);
        const width = Math.max(Math.abs(x2 - x1), 1);
        overlayBands.push({
          key: `${overlay.id}-${occ.year}-${occ.startDate}`,
          overlay,
          occ,
          left,
          width,
          centerX: left + width / 2,
          type: overlay.type,
          status: occ.status,
          showLabel: false,
        });
      }
    }

    const mixedZones = findMixedZones(overlayBands);
    const yearLabelPicks = selectUniformYearLabels(overlayBands, mixedZones, rangeStart, rangeEnd);
    for (const pick of yearLabelPicks) {
      pick.band.showLabel = true;
      pick.band.labelText = pick.labelText;
      pick.band.labelYOffset = pick.yOffset;
    }
    const yearLines = buildYearLines(rangeStart, rangeEnd, xOf);

    return {
      chartW,
      chartH,
      xOf,
      yOf,
      linePath,
      areaPath,
      gridLines,
      timeTicks,
      overlayBands,
      mixedZones,
      yearLines,
      rangeStart,
      rangeEnd,
      firstClose,
      priceSeries,
      rsiByDate: rsiByDateMap(rsiSeries),
      rsiMomentum,
    };
  }, [data, rsiSeries, rsiMomentum]);

  const handleMouseMove = useCallback((e) => {
    if (!chartModel || !svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * (H / rect.height);

    const { overlayBands, mixedZones, priceSeries, xOf, yOf, firstClose } = chartModel;

    for (const mix of mixedZones ?? []) {
      if (mx >= mix.left && mx <= mix.left + mix.width) {
        const bull = mix.bullBand;
        const bear = mix.bearBand;
        setHover({
          x: mx,
          y: my,
          bandKey: mix.key,
          lines: [
            { text: "Zone de chevauchement saisonnier", bold: true, color: C.text },
            { text: "Signal mixte", color: C.textMuted },
            { text: `Fenêtre haussière : ${formatDateRangeShort(bull.occ.startDate, bull.occ.endDate)}`, color: C.green },
            { text: `Fenêtre baissière : ${formatDateRangeShort(bear.occ.startDate, bear.occ.endDate)}`, color: C.red },
            { text: "Lecture : prudence, signaux saisonniers opposés", color: C.textFaint },
          ],
        });
        return;
      }
    }

    for (const band of overlayBands) {
      if (mx >= band.left && mx <= band.left + band.width) {
        const { overlay, occ } = band;
        const isActive = occ.status === "in_progress";
        const historyLines = buildHistoricalContextLines(overlay);

        if (isActive) {
          setHover({
            x: mx,
            y: my,
            bandKey: band.key,
            lines: [
              { text: `${overlayTypeLabel(overlay.type)} : ${formatDateRangeShort(occ.startDate, occ.endDate)}`, bold: true, color: C.text },
              { text: `Rendement annuel moyen : ${formatPct(overlay.expectedReturn)}`, color: overlayTypeColor(overlay.type) },
              { text: `Réalisé depuis début fenêtre : ${formatPct(occ.realizedReturn ?? activeProgress?.realizedReturn)}`, color: (occ.realizedReturn ?? activeProgress?.realizedReturn ?? 0) >= 0 ? C.green : C.red },
              ...historyLines,
              ...(activeProgress?.progressTimePct != null
                ? [{ text: `Temps écoulé : ${formatPctWhole(activeProgress.progressTimePct)}`, color: C.textMuted }]
                : []),
              ...(activeProgress?.paceStatus
                ? [{ text: `Rythme : ${PACE_LABELS[activeProgress.paceStatus] ?? activeProgress.paceStatus}`, color: C.textMuted }]
                : []),
            ],
          });
        } else {
          setHover({
            x: mx,
            y: my,
            bandKey: band.key,
            lines: [
              { text: `${overlayTypeLabel(overlay.type)} : ${formatDateRangeShort(occ.startDate, occ.endDate)}`, bold: true, color: C.text },
              ...(occ.year ? [{ text: `Année civile : ${occ.year}`, color: C.textMuted }] : []),
              { text: `Rendement de cette année : ${formatPct(occ.realizedReturn)}`, color: occ.realizedReturn >= 0 ? C.green : C.red },
              { text: `Rendement annuel moyen : ${formatPct(overlay.expectedReturn)}`, color: overlayTypeColor(overlay.type) },
              ...historyLines,
              { text: `Statut : ${STATUS_LABELS[occ.status] ?? occ.status}`, color: C.textMuted },
            ],
          });
        }
        return;
      }
    }

    let nearest = null;
    let minDist = Infinity;
    for (const p of priceSeries) {
      const px = xOf(p.date);
      const dist = Math.abs(px - mx);
      if (dist < minDist) {
        minDist = dist;
        nearest = p;
      }
    }

    if (nearest && minDist < 40) {
      const chg = firstClose > 0 ? (nearest.close / firstClose) - 1 : null;
      const rsiVal = chartModel.rsiByDate?.get(nearest.date);
      const momentum = chartModel.rsiMomentum;
      setHover({
        x: xOf(nearest.date),
        y: yOf(nearest.close),
        lines: [
          { text: formatDateIso(nearest.date), bold: true, color: C.text },
          { text: `Close : ${formatPrice(nearest.close)}`, color: C.line },
          ...(typeof rsiVal === "number" && isFinite(rsiVal)
            ? [{ text: `RSI 14 : ${rsiVal.toFixed(1)}`, color: C.accentLight }]
            : []),
          ...(chg != null ? [{ text: `Depuis début : ${formatPct(chg)}`, color: chg >= 0 ? C.green : C.red }] : []),
          ...(momentum?.label && typeof rsiVal === "number"
            ? [{ text: momentum.label, color: C.textFaint }]
            : []),
        ],
      });
      return;
    }

    setHover(null);
  }, [chartModel, activeProgress]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  if (!chartModel) {
    return (
      <div style={{ textAlign: "center", padding: "40px 0", color: C.textFaint, fontSize: "12px" }}>
        Données de prix insuffisantes pour tracer le graphique.
      </div>
    );
  }

  const {
    chartW, chartH, linePath, areaPath, gridLines, timeTicks,
    overlayBands, mixedZones, yearLines, xOf, yOf, priceSeries,
  } = chartModel;

  const hoveredBandKey = hover?.bandKey ?? null;
  const chartBottom = PAD.top + chartH;
  const chartRight = PAD.left + chartW;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", display: "block", cursor: "crosshair" }}
      preserveAspectRatio="xMidYMid meet"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <defs>
        <linearGradient id="priceAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.accentLight} stopOpacity="0.18" />
          <stop offset="100%" stopColor={C.accentLight} stopOpacity="0.01" />
        </linearGradient>
        <clipPath id="chartClip">
          <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} />
        </clipPath>
      </defs>

      {/* Grid */}
      {gridLines.map((gl, i) => (
        <g key={i}>
          <line
            x1={PAD.left}
            y1={gl.y}
            x2={chartRight}
            y2={gl.y}
            stroke="rgba(143,163,191,0.08)"
            strokeWidth="0.5"
          />
          <text
            x={chartRight + 6}
            y={gl.y + 3.5}
            textAnchor="start"
            fontSize="8"
            fill={C.textFaint}
          >
            {gl.price >= 1000 ? gl.price.toFixed(0) : gl.price.toFixed(2)}
          </text>
        </g>
      ))}

      {/* Repères annuels (1er janvier) */}
      <g clipPath="url(#chartClip)">
        {(yearLines ?? []).map((yl) => (
          <g key={`year-${yl.year}`}>
            <line
              x1={yl.x}
              y1={PAD.top}
              x2={yl.x}
              y2={chartBottom}
              stroke="rgba(143,163,191,0.16)"
              strokeWidth="0.75"
              strokeDasharray="3 4"
            />
          </g>
        ))}
      </g>
      {(yearLines ?? []).map((yl) => (
        <text
          key={`year-lbl-${yl.year}`}
          x={yl.x + 3}
          y={PAD.top + 9}
          fontSize="7.5"
          fill={C.textFaint}
          opacity="0.75"
          style={{ pointerEvents: "none" }}
        >
          {yl.year}
        </text>
      ))}

      {/* Overlay bands (discrets) */}
      <g clipPath="url(#chartClip)">
        {overlayBands.map((band) => {
          const isBull = band.type === "bullish";
          const isVigilance = band.type === "vigilance";
          const inProgress = band.status === "in_progress";
          const isHovered = hoveredBandKey === band.key;
          const fill = isBull
            ? (inProgress ? "rgba(34,197,94,0.10)" : "rgba(34,197,94,0.06)")
            : isVigilance
              ? (inProgress ? "rgba(245,158,11,0.12)" : "rgba(245,158,11,0.08)")
              : (inProgress ? "rgba(239,68,68,0.10)" : "rgba(239,68,68,0.06)");
          const showBorder = inProgress || isHovered;
          const stroke = isBull
            ? (inProgress ? "rgba(34,197,94,0.50)" : "rgba(34,197,94,0.35)")
            : isVigilance
              ? (inProgress ? "rgba(245,158,11,0.55)" : "rgba(245,158,11,0.4)")
              : (inProgress ? "rgba(239,68,68,0.50)" : "rgba(239,68,68,0.35)");
          return (
            <g key={band.key}>
              <rect
                x={band.left}
                y={PAD.top}
                width={band.width}
                height={chartH}
                fill={fill}
                stroke={showBorder ? stroke : "none"}
                strokeWidth={showBorder ? (inProgress ? 1.1 : 0.8) : 0}
                rx="1"
              />
            </g>
          );
        })}

        {/* Zones mixtes (chevauchement haussier/baissier) */}
        {(mixedZones ?? []).map((mix) => {
          const isHovered = hoveredBandKey === mix.key;
          return (
            <rect
              key={mix.key}
              x={mix.left}
              y={PAD.top}
              width={mix.width}
              height={chartH}
              fill="rgba(139,92,246,0.10)"
              stroke={isHovered ? "rgba(167,139,250,0.45)" : "rgba(139,92,246,0.22)"}
              strokeWidth={isHovered ? 0.9 : 0.5}
              rx="1"
            />
          );
        })}

        {/* Price area + line (dominant) */}
        <path d={areaPath} fill="url(#priceAreaGrad)" />
        <path
          d={linePath}
          fill="none"
          stroke={C.line}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </g>

      {/* Labels de bandes (peu nombreux, contextualisés) */}
      <g clipPath="url(#chartClip)" style={{ pointerEvents: "none" }}>
        {overlayBands.filter((b) => b.showLabel).map((band) => {
          const isBull = band.type === "bullish";
          const isVigilance = band.type === "vigilance";
          const inProgress = band.status === "in_progress";
          const baseY = inProgress ? 14 : 12;
          const yOff = band.labelYOffset ?? 0;
          return (
            <text
              key={`lbl-${band.key}`}
              x={band.centerX}
              y={PAD.top + baseY + yOff}
              textAnchor="middle"
              fontSize="7"
              fill={isBull ? C.green : isVigilance ? C.amber : C.red}
              fontWeight="700"
              opacity={inProgress ? 0.95 : 0.82}
            >
              {band.labelText}
            </text>
          );
        })}
      </g>

      {/* Hover dot on price */}
      {hover && priceSeries.some((p) => {
        const px = xOf(p.date);
        return Math.abs(px - hover.x) < 1;
      }) && (
        <circle cx={hover.x} cy={hover.y} r="3.5" fill={C.accentLight} stroke={C.panel} strokeWidth="1.5" />
      )}

      {/* Time axis */}
      {timeTicks.map((tick, i) => (
        <text
          key={i}
          x={tick.x}
          y={H - 8}
          textAnchor="middle"
          fontSize="8"
          fill={C.textFaint}
        >
          {formatDateIso(tick.iso).replace(/ \d{4}$/, "")}
        </text>
      ))}

      {/* Chart border */}
      <rect
        x={PAD.left}
        y={PAD.top}
        width={chartW}
        height={chartH}
        fill="none"
        stroke="rgba(143,163,191,0.12)"
        strokeWidth="0.5"
        rx="2"
      />

      <ChartTooltip tooltip={hover} />
    </svg>
  );
}

// ─── RSI compact (sous le prix) ───────────────────────────────────────────────

function RsiChartSvg({ data, rsiSeries, rsiMomentum }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const chartModel = useMemo(() => {
    const range = data?.range ?? {};
    const rangeStart = range.startDate;
    const rangeEnd = range.endDate;
    if (!rsiSeries?.length || !rangeStart || !rangeEnd) return null;

    const chartW = W - PAD_RSI.left - PAD_RSI.right;
    const chartH = H_RSI - PAD_RSI.top - PAD_RSI.bottom;
    const t0 = dateToMs(rangeStart);
    const t1 = dateToMs(rangeEnd);
    const span = t1 - t0 || 1;

    const xOf = (iso) => {
      const ratio = (dateToMs(iso) - t0) / span;
      return PAD_RSI.left + Math.max(0, Math.min(1, ratio)) * chartW;
    };

    const rsiPoints = rsiSeries.filter((p) => typeof p.rsi === "number" && isFinite(p.rsi));
    if (!rsiPoints.length) return null;

    const yOf = (rsi) => PAD_RSI.top + (1 - rsi / 100) * chartH;

    const linePath = rsiPoints
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.date).toFixed(1)} ${yOf(p.rsi).toFixed(1)}`)
      .join(" ");

    const refLines = [30, 50, 70].map((level) => ({ level, y: yOf(level) }));

    return { chartW, chartH, xOf, yOf, linePath, rsiPoints, refLines, rangeStart, rangeEnd };
  }, [data, rsiSeries]);

  const handleMouseMove = useCallback((e) => {
    if (!chartModel || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;

    const { rsiPoints, xOf } = chartModel;
    let nearest = null;
    let minDist = Infinity;
    for (const p of rsiPoints) {
      const dist = Math.abs(xOf(p.date) - mx);
      if (dist < minDist) {
        minDist = dist;
        nearest = p;
      }
    }

    if (nearest && minDist < 40) {
      setHover({
        x: xOf(nearest.date),
        y: chartModel.yOf(nearest.rsi),
        lines: [
          { text: formatDateIso(nearest.date), bold: true, color: C.text },
          { text: `RSI 14 : ${nearest.rsi.toFixed(1)}`, color: C.accentLight },
          ...(rsiMomentum?.label
            ? [{ text: `État : ${rsiMomentum.label}`, color: C.textMuted }]
            : []),
        ],
      });
      return;
    }
    setHover(null);
  }, [chartModel, rsiMomentum]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  if (!chartModel) return null;

  const { chartW, chartH, linePath, refLines, xOf, yOf, rsiPoints } = chartModel;
  const chartBottom = PAD_RSI.top + chartH;
  const chartRight = PAD_RSI.left + chartW;

  return (
    <div style={{ marginTop: "6px" }}>
      {rsiMomentum && (
        <div style={{
          fontSize: "10.5px",
          color: C.textMuted,
          marginBottom: "4px",
          lineHeight: 1.4,
        }}>
          <span style={{ color: C.text, fontWeight: 600 }}>
            RSI 14 : {rsiMomentum.rsiCurrent.toFixed(1)}
          </span>
          {" · "}
          <span style={{ color: C.accentLight }}>{rsiMomentum.label}</span>
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H_RSI}`}
        style={{ width: "100%", display: "block", cursor: "crosshair" }}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <g>
          {refLines.map((rl) => (
            <g key={rl.level}>
              <line
                x1={PAD_RSI.left}
                y1={rl.y}
                x2={chartRight}
                y2={rl.y}
                stroke={rl.level === 50 ? "rgba(143,163,191,0.22)" : "rgba(143,163,191,0.1)"}
                strokeWidth="0.5"
                strokeDasharray={rl.level === 50 ? "none" : "2 3"}
              />
              <text
                x={chartRight + 5}
                y={rl.y + 3}
                fontSize="7"
                fill={C.textFaint}
              >
                {rl.level}
              </text>
            </g>
          ))}
          <rect
            x={PAD_RSI.left}
            y={PAD_RSI.top}
            width={chartW}
            height={chartH}
            fill="none"
            stroke="rgba(143,163,191,0.1)"
            strokeWidth="0.5"
            rx="2"
          />
          <path
            d={linePath}
            fill="none"
            stroke={C.accentLight}
            strokeWidth="1.25"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.9"
          />
          {hover && rsiPoints.some((p) => Math.abs(xOf(p.date) - hover.x) < 1) && (
            <circle cx={hover.x} cy={hover.y} r="3" fill={C.accentLight} stroke={C.panel} strokeWidth="1.2" />
          )}
        </g>
        <ChartTooltip tooltip={hover} chartHeight={H_RSI} />
      </svg>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function ChartLegend({ showRsi = false }) {
  return (
    <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: "8px 14px",
      marginTop: "6px",
      fontSize: "9.5px",
      color: C.textMuted,
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 14, height: 0, borderTop: `2px solid ${C.line}` }} />
        Prix (close daily)
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(34,197,94,0.35)", border: "1px solid rgba(34,197,94,0.5)" }} />
        Fenêtre annuelle haussière
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(239,68,68,0.35)", border: "1px solid rgba(239,68,68,0.5)" }} />
        Fenêtre annuelle baissière confirmée
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(245,158,11,0.35)", border: "1px solid rgba(245,158,11,0.5)" }} />
        Vigilance récente
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(34,197,94,0.2)", border: "1px dashed rgba(34,197,94,0.55)" }} />
        Occurrence en cours
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(139,92,246,0.25)", border: "1px solid rgba(139,92,246,0.4)" }} />
        Signal mixte (chevauchement)
      </span>
      {showRsi && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: 14, height: 0, borderTop: `1.25px solid ${C.accentLight}` }} />
          RSI 14
        </span>
      )}
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default function ThreeYearSeasonalityChart({ data, loading, error, symbol, showActiveSummary = false }) {
  const rsiSeries = useMemo(
    () => computeRsi14(data?.priceSeries ?? []),
    [data?.priceSeries],
  );
  const rsiMomentum = useMemo(
    () => getRsiMomentumState(rsiSeries),
    [rsiSeries],
  );
  const showRsiPanel = countValidRsiPoints(rsiSeries) >= RSI_MIN_VALID_POINTS;

  if (loading) {
    return (
      <div style={{
        background: C.cardInner,
        border: `1px solid ${C.border}`,
        borderRadius: "8px",
        padding: "18px",
        textAlign: "center",
        color: C.textMuted,
        fontSize: "11.5px",
      }}>
        Chargement du graphique 3 ans…
      </div>
    );
  }

  if (error || !data?.ok) {
    return (
      <div style={{
        background: C.cardInner,
        border: `1px solid ${C.border}`,
        borderRadius: "8px",
        padding: "12px 14px",
        color: C.textFaint,
        fontSize: "11px",
      }}>
        Graphique 3 ans indisponible pour ce titre.
      </div>
    );
  }

  return (
    <div>
      {showActiveSummary && <ActiveWindowSummary active={data.activeWindowProgress} />}
      <div style={showActiveSummary ? { marginTop: "12px" } : undefined}>
        <SeasonalityChartSvg data={data} rsiSeries={rsiSeries} rsiMomentum={rsiMomentum} />
        {showRsiPanel && (
          <RsiChartSvg data={data} rsiSeries={rsiSeries} rsiMomentum={rsiMomentum} />
        )}
      </div>
      <ChartLegend showRsi={showRsiPanel} />
      {data.range && (
        <div style={{ marginTop: "4px", fontSize: "9px", color: C.textFaint }}>
          {data.range.points ?? "—"} séances · {formatDateIso(data.range.startDate)} → {formatDateIso(data.range.endDate)}
          {symbol ? ` · ${symbol}` : ""}
        </div>
      )}
    </div>
  );
}
