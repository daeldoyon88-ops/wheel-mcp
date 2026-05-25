import React from "react";

/**
 * SeasonalityBadge — V1 read-only seasonal bias indicator.
 * Renders a compact inline badge for dashboard shortlist cards.
 * Returns null when no data is available — always safe to render.
 */

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

const BIAS_CONFIG = {
  favorable: {
    label: "Sais ↑",
    className: "bg-emerald-950/50 text-emerald-400 border-emerald-800",
    title: "Fenêtre saisonnière favorable (historique bullish sur cette période)",
  },
  unfavorable: {
    label: "Sais ↓",
    className: "bg-rose-950/50 text-rose-400 border-rose-800",
    title: "Fenêtre saisonnière défavorable (risque strike élevé sur cette période)",
  },
  neutral: {
    label: "Sais →",
    className: "bg-slate-800/60 text-slate-400 border-slate-600",
    title: "Fenêtre saisonnière neutre",
  },
};

/**
 * @param {{ bias: "favorable"|"unfavorable"|"neutral", score?: number|null }} props
 */
export function SeasonalityBadge({ bias, score }) {
  if (!bias) return null;
  const config = BIAS_CONFIG[bias] ?? BIAS_CONFIG.neutral;

  const scoreDisplay =
    typeof score === "number" && Number.isFinite(score)
      ? ` ${score >= 0 ? "+" : ""}${Math.round(score * 100)}`
      : "";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        config.className,
      )}
      title={`${config.title}${scoreDisplay ? ` · score: ${scoreDisplay}` : ""}`}
    >
      {config.label}
      {scoreDisplay && <span className="ml-0.5 opacity-75">{scoreDisplay}</span>}
    </span>
  );
}
