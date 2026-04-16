import React, { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  ShieldCheck,
  AlertTriangle,
  CalendarDays,
  Target,
  Search,
  Activity,
  ChevronRight,
  BarChart3,
  Layers3,
  X,
  RefreshCw,
} from "lucide-react";

const API_BASE = "https://wheel-mcp.onrender.com";

const stats = [
  { title: "Watchlist", value: "66", sub: "tickers analysés", icon: Search },
  { title: "Éligibles premium", value: "38", sub: "≥ 125 $ / action", icon: ShieldCheck },
  { title: "Post-earnings", value: "7", sub: "finalistes sûrs", icon: CalendarDays },
  { title: "Objectif", value: "0.5%+", sub: "/ semaine sur capital", icon: Target },
];

const alerts = [
  {
    type: "earnings",
    title: "Alerte earnings — cette semaine",
    body: "BAC, USB, SCHW, ABT et AXP ont des publications proches. Ces tickers sont exclus du short premium avant l'événement.",
  },
  {
    type: "rule",
    title: "TQQQ",
    body: "Interdit jusqu'à mi-mai 2026. Structure trop agressive pour le filtre conservateur.",
  },
];

const candidates = [
  {
    rank: 0,
    ticker: "NFLX",
    name: "Netflix",
    setup: "Mode earnings — entrée T-1 close / jour J intraday",
    price: 0,
    expectedMovePct: 0,
    expectedMoveMultiplier: 2,
    earningsMode: true,
    expectedMoveLow: 0,
    expectedMoveHigh: 0,
    minPremium: 0,
    safeStrike: null,
    maxPremiumStrike: null,
    premium: "—",
    weeklyReturn: 0,
    strikeDistance: 0,
    earnings: "16 avril après clôture",
    iv: 0,
    rsi: 0,
    macd: "—",
    zone: "mode earnings défensif",
    verdict: "balanced",
    ok: true,
    note: "Données volontairement dynamiques. Le modal va tenter de charger les vraies données live.",
  },
  {
    rank: 1,
    ticker: "SOFI",
    name: "SoFi Technologies",
    setup: "PUT scanner — semaine du 24 avr. 2026",
    price: 18.91,
    expectedMovePct: 6.35,
    expectedMoveLow: 18.05,
    expectedMoveHigh: 20.49,
    minPremium: 0.09,
    safeStrike: {
      strike: 16.5,
      mid: 0.1,
      weeklyYield: 0.61,
      annualizedYield: 31.5,
      label: "plus défensif",
    },
    maxPremiumStrike: {
      strike: 18.0,
      mid: 0.27,
      weeklyYield: 1.5,
      annualizedYield: 78.0,
      label: "prime max sous EM low",
    },
    premium: "0.10 / 0.27",
    weeklyReturn: 0.61,
    strikeDistance: -12.8,
    earnings: "pas cette semaine",
    iv: 68.4,
    rsi: 52,
    macd: "neutre à légèrement haussier",
    zone: "sous borne basse attendue",
    verdict: "balanced",
    ok: true,
    note: "Exemple parfait pour afficher les deux strikes : le strike sécuritaire qui valide 0.5% / semaine, et le strike max prime sous le low expected move.",
  },
  {
    rank: 3,
    ticker: "HIMS",
    name: "Hims & Hers",
    setup: "PUT 17.00 exp. 17 avril",
    price: 19.43,
    expectedMovePct: 8.6,
    expectedMoveLow: 17.25,
    expectedMoveHigh: 21.1,
    minPremium: 0.09,
    safeStrike: {
      strike: 17.0,
      mid: 0.12,
      weeklyYield: 0.71,
      annualizedYield: 36.9,
      label: "safe mais nerveux",
    },
    maxPremiumStrike: {
      strike: 17.0,
      mid: 0.12,
      weeklyYield: 0.71,
      annualizedYield: 36.9,
      label: "même strike disponible",
    },
    premium: "0.11 / 0.13",
    weeklyReturn: 0.65,
    strikeDistance: -12.5,
    earnings: "4-5 mai",
    iv: 88.3,
    rsi: 45,
    macd: "encore baissier",
    zone: "zone basse",
    verdict: "aggressive",
    ok: true,
    note: "Rendement excellent mais volatilité élevée. Ici un seul strike peut remplir les deux rôles.",
  },
  {
    rank: 4,
    ticker: "AMD",
    name: "AMD",
    setup: "PUT 145.00 exp. 17 avril",
    price: 158.12,
    expectedMovePct: 7.45,
    expectedMoveLow: 146.3,
    expectedMoveHigh: 169.9,
    minPremium: 0.73,
    safeStrike: {
      strike: 145.0,
      mid: 0.78,
      weeklyYield: 0.54,
      annualizedYield: 28.1,
      label: "objectif validé",
    },
    maxPremiumStrike: {
      strike: 145.0,
      mid: 0.78,
      weeklyYield: 0.54,
      annualizedYield: 28.1,
      label: "plus haut strike admissible",
    },
    premium: "0.72 / 0.84",
    weeklyReturn: 0.56,
    strikeDistance: -8.3,
    earnings: "30 avril",
    iv: 52.1,
    rsi: 49,
    macd: "neutre",
    zone: "support proche",
    verdict: "balanced",
    ok: true,
    note: "Bon compromis prime / distance / qualité technique.",
  },
];

const verdictStyle = {
  conservative: "bg-emerald-50 text-emerald-700 border-emerald-200",
  balanced: "bg-amber-50 text-amber-700 border-amber-200",
  aggressive: "bg-rose-50 text-rose-700 border-rose-200",
};

const riskToProgress = {
  conservative: 28,
  balanced: 56,
  aggressive: 82,
};

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

function Card({ className = "", children }) {
  return <div className={cn("rounded-2xl border bg-white", className)}>{children}</div>;
}

function CardHeader({ className = "", children }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

function CardContent({ className = "", children }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

function CardTitle({ className = "", children }) {
  return <h3 className={cn("font-semibold", className)}>{children}</h3>;
}

function Input({ className = "", ...props }) {
  return <input {...props} className={cn("border bg-white px-3 py-2 outline-none", className)} />;
}

function Badge({ className = "", children }) {
  return (
    <span className={cn("inline-flex items-center border px-2.5 py-1 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

function Button({ className = "", variant = "default", size = "default", children, ...props }) {
  const variantClass =
    variant === "outline"
      ? "border border-slate-300 bg-white text-slate-700"
      : "border border-slate-900 bg-slate-900 text-white";
  const sizeClass = size === "icon" ? "h-9 w-9 justify-center p-0" : "px-4 py-2";

  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center rounded-xl text-sm font-medium transition hover:opacity-90",
        variantClass,
        sizeClass,
        className
      )}
    >
      {children}
    </button>
  );
}

function Progress({ value }) {
  return (
    <div className="h-2 w-full rounded-full bg-slate-200">
      <div
        className="h-2 rounded-full bg-slate-900"
        style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }}
      />
    </div>
  );
}

function StatCard({ item }) {
  const Icon = item.icon;

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">{item.title}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{item.value}</p>
            <p className="mt-1 text-sm text-slate-500">{item.sub}</p>
          </div>
          <div className="rounded-2xl bg-slate-100 p-3">
            <Icon className="h-5 w-5 text-slate-700" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertPanel() {
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <Card
          key={alert.title}
          className={cn(
            "shadow-sm",
            alert.type === "earnings"
              ? "border-rose-200 bg-rose-50/70"
              : "border-emerald-200 bg-emerald-50/70"
          )}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-white/80 p-2">
                {alert.type === "earnings" ? (
                  <AlertTriangle className="h-4 w-4 text-rose-600" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{alert.title}</p>
                <p className="mt-1 text-sm leading-6 text-slate-700">{alert.body}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value, strong = false, tone = "default" }) {
  const toneClass =
    tone === "good"
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : tone === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-800"
      : tone === "bad"
      ? "bg-rose-50 border-rose-200 text-rose-800"
      : "bg-white border-slate-200 text-slate-700";

  return (
    <div className={cn("rounded-xl border p-3", toneClass)}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("mt-1 text-sm", strong && "font-semibold")}>{value}</p>
    </div>
  );
}

function StrikeCard({
  title,
  subtitle,
  strike,
  mid,
  weeklyYield,
  annualizedYield,
  distancePct,
  label,
}) {
  const distanceTone = distancePct <= -10 ? "good" : distancePct <= -5 ? "warn" : "bad";
  const yieldTone = weeklyYield >= 1 ? "good" : weeklyYield >= 0.5 ? "warn" : "bad";
  const midTone = mid >= 0.2 ? "good" : mid >= 0.09 ? "warn" : "bad";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <Badge className="rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700">
          {label}
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Strike" value={`$${strike.toFixed(2)}`} strong />
        <Metric label="Mid" value={`$${mid.toFixed(2)}`} strong={mid >= 0.09} tone={midTone} />
        <Metric label="Distance" value={`${distancePct.toFixed(1)}%`} strong tone={distanceTone} />
        <Metric label="Hebdo" value={`${weeklyYield.toFixed(2)}%`} strong tone={yieldTone} />
        <Metric label="Annualisé" value={`${annualizedYield.toFixed(1)}%`} tone={yieldTone} />
      </div>
    </div>
  );
}

function StrikeOpportunities({ item }) {
  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;

  const hasSafe = !!item.safeStrike;
  const hasMax = !!item.maxPremiumStrike;

  const safeDistance =
    hasSafe && item.price > 0 ? ((item.safeStrike.strike - item.price) / item.price) * 100 : 0;
  const maxDistance =
    hasMax && item.price > 0 ? ((item.maxPremiumStrike.strike - item.price) / item.price) * 100 : 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Opportunités sous la borne basse attendue</p>
          <p className="mt-1 text-sm text-slate-600">
            Spot actuel <span className="font-medium text-slate-900">${item.price.toFixed(2)}</span> · borne basse attendue{" "}
            <span className="font-medium text-rose-700">${item.expectedMoveLow.toFixed(2)}</span> · borne haute attendue{" "}
            <span className="font-medium text-emerald-700">${item.expectedMoveHigh.toFixed(2)}</span>
          </p>
          {item.earningsMode && (
            <p className="mt-2 text-sm text-violet-700">
              Mode earnings actif : mouvement attendu normal{" "}
              <span className="font-semibold">{item.expectedMovePct.toFixed(2)}%</span> ×{" "}
              {item.expectedMoveMultiplier || 2} ={" "}
              <span className="font-semibold">{adjustedMovePct.toFixed(2)}%</span>.
            </p>
          )}
        </div>

        <Badge className="rounded-full border border-slate-300 bg-white text-slate-700">
          objectif 0.5% / semaine
        </Badge>
      </div>

      {hasSafe || hasMax ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {hasSafe && (
            <StrikeCard
              title="Strike sécuritaire"
              subtitle="le plus prudent qui atteint la prime cible"
              strike={item.safeStrike.strike}
              mid={item.safeStrike.mid}
              weeklyYield={item.safeStrike.weeklyYield}
              annualizedYield={item.safeStrike.annualizedYield}
              distancePct={safeDistance}
              label={item.safeStrike.label}
            />
          )}
          {hasMax && (
            <StrikeCard
              title="Strike max prime"
              subtitle="le plus haut strike admissible sous la borne basse"
              strike={item.maxPremiumStrike.strike}
              mid={item.maxPremiumStrike.mid}
              weeklyYield={item.maxPremiumStrike.weeklyYield}
              annualizedYield={item.maxPremiumStrike.annualizedYield}
              distancePct={maxDistance}
              label={item.maxPremiumStrike.label}
            />
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          {item.earningsMode
            ? "Cas earnings visible avec la règle mouvement attendu x2. Les strikes réels seront injectés dès le branchement live."
            : "Aucun strike sous le bas du mouvement attendu n'atteint la prime minimale cible."}
        </div>
      )}
    </div>
  );
}

function CandidateCard({ item, onOpenDetail }) {
  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-slate-200 shadow-sm transition-all hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
                  Choix #{item.rank}
                </Badge>
                <Badge className={cn("rounded-full border", verdictStyle[item.verdict])}>
                  {item.verdict}
                </Badge>
                {item.earningsMode && (
                  <Badge className="rounded-full border border-violet-200 bg-violet-50 text-violet-700">
                    mode earnings x{item.expectedMoveMultiplier || 2}
                  </Badge>
                )}
                {item.ok ? (
                  <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                    objectif validé
                  </Badge>
                ) : (
                  <Badge className="rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                    à surveiller
                  </Badge>
                )}
              </div>

              <div>
                <h3 className="text-xl font-semibold tracking-tight text-slate-900">
                  {item.ticker} <span className="font-normal text-slate-500">— {item.name}</span>
                </h3>
                <p className="mt-1 text-sm text-slate-600">{item.setup}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4 xl:grid-cols-5">
                <Metric label="Prix actuel" value={`$${item.price.toFixed(2)}`} />
                <Metric
                  label="Mouvement attendu"
                  value={
                    item.earningsMode
                      ? `${item.expectedMovePct.toFixed(2)}% → ${adjustedMovePct.toFixed(2)}%`
                      : `${item.expectedMovePct.toFixed(2)}%`
                  }
                  strong
                  tone={item.earningsMode ? "bad" : "warn"}
                />
                <Metric label="Prix plus bas" value={`$${item.expectedMoveLow.toFixed(2)}`} strong tone="bad" />
                <Metric label="Prix supérieur" value={`$${item.expectedMoveHigh.toFixed(2)}`} strong tone="good" />
                <Metric label="Prime bid/ask" value={item.premium} />
                <Metric
                  label="Rendement"
                  value={`${item.weeklyReturn.toFixed(2)}% / sem`}
                  strong={item.weeklyReturn >= 0.5}
                  tone={item.weeklyReturn >= 0.5 ? "good" : "bad"}
                />
                <Metric label="Distance strike" value={`${item.strikeDistance.toFixed(1)}%`} />
                <Metric label="Earnings" value={item.earnings} />
                <Metric
                  label="IV"
                  value={`${item.iv.toFixed(1)}%`}
                  strong={item.iv >= 60}
                  tone={item.iv >= 70 ? "bad" : item.iv >= 50 ? "warn" : "default"}
                />
                <Metric label="RSI" value={`${item.rsi}`} />
              </div>

              <StrikeOpportunities item={item} />
            </div>

            <div className="min-w-[240px] max-w-[280px] rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Risque</span>
                <span className="text-sm capitalize text-slate-500">{item.verdict}</span>
              </div>
              <div className="mt-3">
                <Progress value={riskToProgress[item.verdict]} />
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">{item.note}</p>
              <Button className="mt-4 w-full rounded-xl" onClick={() => onOpenDetail(item)}>
                Voir la fiche complète <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function RiskRow({ label, value, total }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <span className="text-slate-700">{label}</span>
        <span className="font-medium text-slate-900">
          {value} / {total}
        </span>
      </div>
      <div className="mt-3">
        <Progress value={(value / total) * 100} />
      </div>
    </div>
  );
}

function StepItem({ step, title, text }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-slate-200 p-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
        {step}
      </div>
      <div>
        <p className="font-medium text-slate-900">{title}</p>
        <p className="mt-1 leading-6 text-slate-600">{text}</p>
      </div>
    </div>
  );
}

async function callTool(toolName, args) {
  const response = await fetch(`${API_BASE}/tools/${toolName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload.result;
}

function DetailModal({ item, onClose }) {
  const [loading, setLoading] = useState(false);
  const [liveData, setLiveData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!item) return;

      setLoading(true);
      setError("");
      setLiveData(null);

      try {
        const quote = await callTool("get_quote", { symbol: item.ticker });
        const expirations = await callTool("get_option_expirations", { symbol: item.ticker });

        const firstExpiration = expirations?.expirationDates?.[0] || null;

        let expectedMove = null;

        if (firstExpiration) {
          expectedMove = await callTool("get_expected_move", {
            symbol: item.ticker,
            expiration: firstExpiration,
          });
        }

        if (!cancelled) {
          setLiveData({
            quote,
            expirations,
            firstExpiration,
            expectedMove,
          });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = String(err?.message || err || "");
          if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
            setError("Yahoo a temporairement limité les requêtes (429). Réessaie dans un instant.");
          } else {
            setError(msg || "Impossible de charger les données live.");
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item) return null;

  const livePrice =
    liveData?.quote?.regularMarketPrice ??
    item.price;

  const liveExpectedMovePct =
    liveData?.expectedMove?.expectedMovePercent ?? item.expectedMovePct;

  const liveLow =
    liveData?.expectedMove?.oneSigmaRange?.lower ?? item.expectedMoveLow;

  const liveHigh =
    liveData?.expectedMove?.oneSigmaRange?.upper ?? item.expectedMoveHigh;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {item.ticker} — {item.name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{item.setup}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-6 px-6 py-5">
          {loading && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Chargement des données live...
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {error}
            </div>
          )}

          {!loading && !error && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
              Données live chargées pour le modal.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Metric label="Prix actuel" value={`$${Number(livePrice || 0).toFixed(2)}`} />
            <Metric
              label="Mouvement attendu"
              value={
                item.earningsMode
                  ? `${Number(liveExpectedMovePct || 0).toFixed(2)}% → ${(Number(liveExpectedMovePct || 0) * (item.expectedMoveMultiplier || 1)).toFixed(2)}%`
                  : `${Number(liveExpectedMovePct || 0).toFixed(2)}%`
              }
              strong
              tone={item.earningsMode ? "bad" : "warn"}
            />
            <Metric label="Prix plus bas" value={`$${Number(liveLow || 0).toFixed(2)}`} strong tone="bad" />
            <Metric label="Prix supérieur" value={`$${Number(liveHigh || 0).toFixed(2)}`} strong tone="good" />
            <Metric label="Expiration" value={liveData?.firstExpiration || "—"} />
            <Metric label="RSI" value={`${item.rsi}`} />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Résumé</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.note}</p>
            {item.earningsMode && (
              <p className="mt-3 text-sm text-violet-700">
                Mode earnings x{item.expectedMoveMultiplier || 2} conservé dans le modal.
              </p>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {item.safeStrike ? (
              <StrikeCard
                title="Strike sécuritaire"
                subtitle="le plus prudent qui atteint la prime cible"
                strike={item.safeStrike.strike}
                mid={item.safeStrike.mid}
                weeklyYield={item.safeStrike.weeklyYield}
                annualizedYield={item.safeStrike.annualizedYield}
                distancePct={
                  livePrice > 0 ? ((item.safeStrike.strike - livePrice) / livePrice) * 100 : 0
                }
                label={item.safeStrike.label}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike sécuritaire disponible.
              </div>
            )}

            {item.maxPremiumStrike ? (
              <StrikeCard
                title="Strike max prime"
                subtitle="le plus haut strike admissible sous la borne basse"
                strike={item.maxPremiumStrike.strike}
                mid={item.maxPremiumStrike.mid}
                weeklyYield={item.maxPremiumStrike.weeklyYield}
                annualizedYield={item.maxPremiumStrike.annualizedYield}
                distancePct={
                  livePrice > 0 ? ((item.maxPremiumStrike.strike - livePrice) / livePrice) * 100 : 0
                }
                label={item.maxPremiumStrike.label}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike max prime disponible.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedItem, setSelectedItem] = useState(null);

  const filtered = useMemo(() => {
    return candidates.filter((item) => {
      const passesYieldFilter = item.weeklyReturn >= 0.5;
      const passesAnnualizedFilter =
        (item.safeStrike && item.safeStrike.annualizedYield >= 26) ||
        (item.maxPremiumStrike && item.maxPremiumStrike.annualizedYield >= 26) ||
        item.weeklyReturn * 52 >= 26;

      const passesDashboardGate = item.earningsMode
        ? true
        : passesYieldFilter && passesAnnualizedFilter;

      const matchesQuery =
        item.ticker.toLowerCase().includes(query.toLowerCase()) ||
        item.name.toLowerCase().includes(query.toLowerCase());

      const matchesFilter =
        filter === "all"
          ? true
          : filter === "validated"
          ? item.ok
          : item.verdict === filter;

      return passesDashboardGate && matchesQuery && matchesFilter;
    });
  }, [query, filter]);

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-7xl p-4 md:p-6 lg:p-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                <Layers3 className="h-3.5 w-3.5" />
                Wheel Strategy Dashboard — live-ready modal
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Dashboard options lisible, premium et actionnable
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                Dashboard frontend séparé du backend. Le modal tente de charger les données live sans toucher à server.js.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:w-[560px]">
              {stats.map((item) => (
                <StatCard key={item.title} item={item} />
              ))}
            </div>
          </div>
        </motion.div>

        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-6">
            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-xl text-slate-900">Shortlist hebdomadaire</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      Les dossiers standards doivent passer 0.5% / semaine et 26% annualisé. Les cas earnings x2 restent visibles avec leur règle spéciale.
                    </p>
                  </div>

                  <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
                    <div className="relative min-w-[240px]">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Ticker ou nom..."
                        className="rounded-xl border-slate-200 pl-9"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {[
                        ["all", "Tous"],
                        ["validated", "Validés"],
                        ["conservative", "Safe"],
                        ["balanced", "Balanced"],
                        ["aggressive", "Aggressive"],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          variant={filter === value ? "default" : "outline"}
                          className="rounded-xl"
                          onClick={() => setFilter(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {filtered.map((item) => (
                  <CandidateCard
                    key={`${item.ticker}-${item.setup}`}
                    item={item}
                    onOpenDetail={setSelectedItem}
                  />
                ))}

                {filtered.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
                    Aucun résultat avec ce filtre.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <AlertPanel />

            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                  <Activity className="h-5 w-5" />
                  Résumé semaine
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="font-medium text-slate-900">Lecture rapide</p>
                  <p className="mt-2 leading-6">
                    On garde le dashboard stable et on branche le live uniquement dans le modal pour réduire le risque.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Candidats affichés</span>
                    <span className="font-semibold text-slate-900">{filtered.length}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                  <BarChart3 className="h-5 w-5" />
                  Priorité UX proposée
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <StepItem
                  step="1"
                  title="Dashboard lecture rapide"
                  text="On garde ton backend intact et on améliore uniquement la présentation."
                />
                <StepItem
                  step="2"
                  title="Modal live"
                  text="Le live est tenté uniquement à l’ouverture du détail."
                />
                <StepItem
                  step="3"
                  title="Brancher les strikes live"
                  text="Ensuite seulement, on remplacera progressivement les mocks."
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
    </div>
  );
}