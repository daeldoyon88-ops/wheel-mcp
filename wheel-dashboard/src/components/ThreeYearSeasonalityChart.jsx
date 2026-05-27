/**
 * Graphique 3 ans — prix réel + fenêtres swing saisonnières (Patch 2C-C).
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
const PAD = { top: 14, right: 52, bottom: 28, left: 8 };

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
  if (v === "robuste") return "Robuste";
  if (v === "mesurable") return "Mesurable";
  if (v === "préliminaire" || v === "preliminaire") return "Préliminaire";
  if (raw) return String(raw);
  return "—";
}

function getSampleSize(source) {
  if (!source || typeof source !== "object") return null;
  const candidates = [
    source.sampleSize,
    typeof source.occurrences === "number" ? source.occurrences : null,
    source.years,
    source.observations,
    source.occurrencesCount,
  ];
  for (const n of candidates) {
    if (typeof n === "number" && isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function normalizeRateFraction(val) {
  if (typeof val !== "number" || !isFinite(val)) return null;
  if (val >= 0 && val <= 1) return val;
  if (val > 1 && val <= 100) return val / 100;
  return null;
}

function getDirectionalWinRate(source, type) {
  if (!source) return null;
  const isBullish = type === "bullish";

  if (isBullish && typeof source.bullishWinRate === "number") {
    return normalizeRateFraction(source.bullishWinRate);
  }
  if (!isBullish && typeof source.bearishWinRate === "number") {
    return normalizeRateFraction(source.bearishWinRate);
  }
  if (!isBullish && typeof source.downRate === "number") {
    return normalizeRateFraction(source.downRate);
  }

  const winRate = normalizeRateFraction(source.winRate);
  if (winRate == null) return null;
  return isBullish ? winRate : 1 - winRate;
}

function buildHistoricalContextLines(overlay) {
  const lines = [];
  const sample = getSampleSize(overlay);
  if (sample != null) {
    lines.push({
      text: `Historique : ${sample} ${sample === 1 ? "an" : "ans"}`,
      color: C.textMuted,
    });
  }
  const rateFrac = getDirectionalWinRate(overlay, overlay.type);
  if (rateFrac != null) {
    const typeWord = overlay.type === "bullish" ? "haussier" : "baissier";
    lines.push({
      text: `Réussite : ${Math.round(rateFrac * 100)} % ${typeWord}`,
      color: C.textMuted,
    });
  }
  const conf = formatConfidenceLabel(overlay.confidence);
  if (conf && conf !== "—") {
    lines.push({ text: `Confiance : ${conf}`, color: C.textFaint });
  }
  return lines;
}

function findMixedZones(bands) {
  const bullish = bands.filter((b) => b.type === "bullish");
  const bearish = bands.filter((b) => b.type === "bearish");
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
        Aucune fenêtre swing active aujourd&apos;hui.
      </div>
    );
  }

  const typeLabel = active.type === "bullish" ? "Haussière" : "Baissière";
  const typeColor = active.type === "bullish" ? C.green : C.red;
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
          Fenêtre active : {active.displayLabel ?? formatDateRangeShort(active.startDate, active.endDate)}
        </span>
        <span style={{
          background: active.type === "bullish" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)",
          border: `1px solid ${active.type === "bullish" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
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
          <div style={statStyle}>Attendu historique</div>
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

function ChartTooltip({ tooltip }) {
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
  if (top + boxH > H - 4) top = H - boxH - 4;

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

function SeasonalityChartSvg({ data }) {
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
    for (const overlay of data?.swingOverlays ?? []) {
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
    };
  }, [data]);

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
              { text: `Fenêtre active : ${formatDateRangeShort(occ.startDate, occ.endDate)}`, bold: true, color: C.text },
              { text: `Attendu historique : ${formatPct(overlay.expectedReturn)}`, color: overlay.type === "bullish" ? C.green : C.red },
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
              { text: `Fenêtre : ${formatDateRangeShort(occ.startDate, occ.endDate)}`, bold: true, color: C.text },
              ...(occ.year ? [{ text: `Occurrence : ${occ.year}`, color: C.textMuted }] : []),
              { text: `Attendu historique : ${formatPct(overlay.expectedReturn)}`, color: overlay.type === "bullish" ? C.green : C.red },
              { text: `Réalisé occurrence : ${formatPct(occ.realizedReturn)}`, color: occ.realizedReturn >= 0 ? C.green : C.red },
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
      setHover({
        x: xOf(nearest.date),
        y: yOf(nearest.close),
        lines: [
          { text: formatDateIso(nearest.date), bold: true, color: C.text },
          { text: `Close : ${formatPrice(nearest.close)}`, color: C.line },
          ...(chg != null ? [{ text: `Depuis début : ${formatPct(chg)}`, color: chg >= 0 ? C.green : C.red }] : []),
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
          const inProgress = band.status === "in_progress";
          const isHovered = hoveredBandKey === band.key;
          const fill = isBull
            ? (inProgress ? "rgba(34,197,94,0.10)" : "rgba(34,197,94,0.06)")
            : (inProgress ? "rgba(239,68,68,0.10)" : "rgba(239,68,68,0.06)");
          const showBorder = inProgress || isHovered;
          const stroke = isBull
            ? (inProgress ? "rgba(34,197,94,0.50)" : "rgba(34,197,94,0.35)")
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
              fill={isBull ? C.green : C.red}
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

// ─── Legend ───────────────────────────────────────────────────────────────────

function ChartLegend() {
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
        Fenêtre haussière
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(239,68,68,0.35)", border: "1px solid rgba(239,68,68,0.5)" }} />
        Fenêtre baissière
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(34,197,94,0.2)", border: "1px dashed rgba(34,197,94,0.55)" }} />
        Occurrence en cours
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 12, height: 10, borderRadius: 2, background: "rgba(139,92,246,0.25)", border: "1px solid rgba(139,92,246,0.4)" }} />
        Signal mixte (chevauchement)
      </span>
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default function ThreeYearSeasonalityChart({ data, loading, error, symbol, showActiveSummary = false }) {
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
        <SeasonalityChartSvg data={data} />
      </div>
      <ChartLegend />
      {data.range && (
        <div style={{ marginTop: "4px", fontSize: "9px", color: C.textFaint }}>
          {data.range.points ?? "—"} séances · {formatDateIso(data.range.startDate)} → {formatDateIso(data.range.endDate)}
          {symbol ? ` · ${symbol}` : ""}
        </div>
      )}
    </div>
  );
}
