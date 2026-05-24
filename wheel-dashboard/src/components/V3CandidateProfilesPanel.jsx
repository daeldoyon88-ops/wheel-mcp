import React, { useCallback, useEffect, useMemo, useState } from "react";

const SAMPLE_QUALITY_RANK = { strong: 4, medium: 3, preliminary: 2, weak: 1 };
const DEFAULT_VISIBLE = 8;
const MAX_INLINE_WARNINGS = 2;

const SAMPLE_QUALITY_LABELS = {
  weak: "faible",
  preliminary: "préliminaire",
  medium: "moyen",
  strong: "fort",
};

const PRIME_STRENGTH_LABELS = {
  forte: "prime forte",
  normale: "prime normale",
  faible: "prime faible",
  inconnue: "prime inconnue",
};

const WARNING_PRIORITY_RULES = [
  { key: "historique_court", match: (w) => w === "Historique court", short: "Historique court" },
  {
    key: "exp_uniques",
    match: (w) => w === "Moins de 6 expirations uniques",
    short: "Moins de 6 exp. uniques",
  },
  {
    key: "lower_bound",
    match: (w) => w === "LowerBound cassé détecté",
    short: "LowerBound cassé",
  },
  { key: "touch_strike", match: (w) => w === "Touch strike élevé", short: "Touch strike élevé" },
  {
    key: "bucket_fragment",
    match: (w) => w.includes("Même expiration observée dans plusieurs buckets DTE"),
    short: "Expiration fragmentée entre buckets DTE",
  },
  {
    key: "ticker_mode",
    match: (w) => w === "Données ticker/mode, pas strike exact",
    short: "Données ticker/mode, pas strike exact",
  },
];

function formatModeLabel(mode) {
  const raw = String(mode ?? "").trim().toUpperCase();
  if (raw === "AGGRESSIVE" || raw === "AGRESSIF") return "AGRESSIF";
  if (raw === "SAFE") return "SAFE";
  return raw || "—";
}

function formatYieldPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} %`;
}

function getSampleQualityMinRank(filter) {
  if (filter === "strong") return SAMPLE_QUALITY_RANK.strong;
  if (filter === "medium+") return SAMPLE_QUALITY_RANK.medium;
  if (filter === "preliminary+") return SAMPLE_QUALITY_RANK.preliminary;
  return 0;
}

function sortProfiles(profiles) {
  return [...profiles].sort((a, b) => {
    const qA = SAMPLE_QUALITY_RANK[a.sampleQuality] ?? 0;
    const qB = SAMPLE_QUALITY_RANK[b.sampleQuality] ?? 0;
    if (qB !== qA) return qB - qA;

    const primeA = a.primeStrengthLabel === "forte" ? 1 : 0;
    const primeB = b.primeStrengthLabel === "forte" ? 1 : 0;
    if (primeB !== primeA) return primeB - primeA;

    const assignA = a.assignmentRatePct ?? 999;
    const assignB = b.assignmentRatePct ?? 999;
    if (assignA !== assignB) return assignA - assignB;

    const expA = a.uniqueExpirationCount ?? 0;
    const expB = b.uniqueExpirationCount ?? 0;
    if (expB !== expA) return expB - expA;

    const yieldA = a.latestYieldPct ?? -1;
    const yieldB = b.latestYieldPct ?? -1;
    return yieldB - yieldA;
  });
}

function pickBestProfilePerTicker(sortedProfiles) {
  const tickerCounts = new Map();
  for (const profile of sortedProfiles) {
    const ticker = String(profile.ticker ?? "").toUpperCase();
    if (!ticker) continue;
    tickerCounts.set(ticker, (tickerCounts.get(ticker) ?? 0) + 1);
  }

  const seen = new Set();
  const entries = [];
  for (const profile of sortedProfiles) {
    const ticker = String(profile.ticker ?? "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const totalForTicker = tickerCounts.get(ticker) ?? 1;
    entries.push({
      profile,
      extraProfileCount: totalForTicker - 1,
    });
  }
  return entries;
}

function getSampleQualityBadgeClass(quality) {
  if (quality === "strong") return "border-emerald-800/50 bg-emerald-900/20 text-emerald-400";
  if (quality === "medium") return "border-sky-800/50 bg-sky-900/20 text-sky-400";
  if (quality === "preliminary") return "border-amber-800/50 bg-amber-900/20 text-amber-400";
  return "border-slate-700 bg-slate-800 text-slate-500";
}

function normalizeWarningText(warning) {
  return String(warning ?? "").trim();
}

function mapWarningForDisplay(warning) {
  const text = normalizeWarningText(warning);
  if (text.includes("Même expiration observée dans plusieurs buckets DTE")) {
    return "Expiration fragmentée entre buckets DTE.";
  }
  if (text === "Historique court") {
    return "Historique court.";
  }
  if (text === "Moins de 6 expirations uniques") {
    return "Moins de 6 exp. uniques.";
  }
  if (text === "LowerBound cassé détecté") {
    return "LowerBound cassé.";
  }
  if (text === "Données ticker/mode, pas strike exact") {
    return "Données ticker/mode, pas strike exact.";
  }
  if (text === "Plusieurs strikes dans une même cohorte") {
    return "Plusieurs strikes dans une cohorte.";
  }
  if (text === "Résultats mixtes sur même expiration") {
    return "Résultats mixtes sur même expiration.";
  }
  if (text === "Échantillon faible — ne pas surinterpréter") {
    return "Échantillon faible.";
  }
  return text;
}

function getWarningPriority(rawWarning) {
  const text = normalizeWarningText(rawWarning);
  const index = WARNING_PRIORITY_RULES.findIndex((rule) => rule.match(text));
  return index >= 0 ? index : WARNING_PRIORITY_RULES.length + 1;
}

function getProfileWarnings(profile) {
  const raw = Array.isArray(profile.warnings) ? profile.warnings : [];
  const unique = [...new Set(raw.map(normalizeWarningText).filter(Boolean))];
  return unique.sort((a, b) => getWarningPriority(a) - getWarningPriority(b));
}

function getInlineWarningLabel(rawWarning) {
  const text = normalizeWarningText(rawWarning);
  const rule = WARNING_PRIORITY_RULES.find((item) => item.match(text));
  if (rule) return rule.short;
  return mapWarningForDisplay(text).replace(/\.$/, "");
}

function shortenVerdict(verdict) {
  const text = String(verdict ?? "").trim();
  if (!text) return "";
  if (text.length <= 72) return text;
  return `${text.slice(0, 69)}…`;
}

function ProfileCard({ profile, extraProfileCount = 0 }) {
  const [warningsOpen, setWarningsOpen] = useState(false);

  const expCount = profile.uniqueExpirationCount ?? 0;
  const assignedCount = profile.assignedCount ?? 0;
  const strikeTouchedCount = profile.strikeTouchedCount ?? 0;
  const lowerBoundBrokenCount = profile.lowerBoundBrokenCount ?? 0;

  const sampleLabel = SAMPLE_QUALITY_LABELS[profile.sampleQuality] ?? profile.sampleQuality ?? "—";
  const primeLabel = PRIME_STRENGTH_LABELS[profile.primeStrengthLabel] ?? profile.primeStrengthLabel ?? "—";

  const sortedWarnings = getProfileWarnings(profile);
  const warningCount = sortedWarnings.length;
  const inlineWarnings = sortedWarnings.slice(0, MAX_INLINE_WARNINGS).map(getInlineWarningLabel);
  const hiddenWarningCount = Math.max(0, warningCount - inlineWarnings.length);

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-900/60 px-3 py-2 min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-bold text-slate-100">{profile.ticker}</span>
        <span className="text-[10px] text-slate-500">·</span>
        <span className="text-[10px] font-medium text-slate-300">{formatModeLabel(profile.mode)}</span>
        <span className="text-[10px] text-slate-500">·</span>
        <span className="text-[10px] text-slate-500">{profile.dteBucket ?? "—"}</span>
        {extraProfileCount > 0 && (
          <span className="rounded border border-violet-800/50 bg-violet-900/20 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">
            +{extraProfileCount} profil{extraProfileCount !== 1 ? "s" : ""}
          </span>
        )}
        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[9px] font-semibold ${getSampleQualityBadgeClass(profile.sampleQuality)}`}>
          {sampleLabel}
        </span>
      </div>

      <div className="mt-1 text-[10px] leading-snug text-slate-400">
        <span className="text-slate-300">{primeLabel.charAt(0).toUpperCase() + primeLabel.slice(1)}</span>
        {" · rendement "}
        <span className="tabular-nums text-sky-400">{formatYieldPct(profile.latestYieldPct)}</span>
      </div>

      <div className="mt-1 text-[10px] leading-snug text-slate-500">
        Assign.{" "}
        <span className="tabular-nums text-slate-300">
          {assignedCount}/{expCount}
        </span>
        {" · touch "}
        <span className="tabular-nums text-slate-300">
          {strikeTouchedCount}/{expCount}
        </span>
        {" · LB "}
        <span className="tabular-nums text-slate-300">
          {lowerBoundBrokenCount}/{expCount}
        </span>
      </div>

      <div className="mt-0.5 text-[10px] leading-snug text-slate-500">
        Hist.{" "}
        <span className="tabular-nums text-slate-300">
          {profile.historyDays != null ? `${profile.historyDays} j` : "—"}
        </span>
        {" · "}
        <span className="text-slate-400">{sampleLabel}</span>
      </div>

      {profile.v3Verdict && (
        <div className="mt-1 text-[10px] leading-snug text-amber-200/80">
          {shortenVerdict(profile.v3Verdict)}
        </div>
      )}

      {warningCount > 0 && (
        <div className="mt-1.5">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-snug text-amber-500/80">
            <span className="font-medium text-slate-500">
              Warnings : {warningCount}
            </span>
            {inlineWarnings.map((label) => (
              <span key={label} className="text-amber-500/80">
                · {label}
              </span>
            ))}
            {hiddenWarningCount > 0 && !warningsOpen && (
              <span className="text-slate-600">· +{hiddenWarningCount}</span>
            )}
          </div>

          {warningCount > MAX_INLINE_WARNINGS && (
            <button
              type="button"
              onClick={() => setWarningsOpen((v) => !v)}
              className="mt-0.5 text-[9px] text-sky-500 hover:text-sky-400"
            >
              {warningsOpen ? "Masquer warnings ▲" : "Voir warnings ▼"}
            </button>
          )}

          {warningsOpen && (
            <ul className="mt-1 space-y-0.5 text-[10px] leading-snug text-amber-500/70">
              {sortedWarnings.map((warning) => (
                <li key={warning}>· {mapWarningForDisplay(warning)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function V3CandidateProfilesPanel({ apiBase }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [payload, setPayload] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [qualityFilter, setQualityFilter] = useState("tous");
  const [primeFilter, setPrimeFilter] = useState("tous");
  const [assignmentFilter, setAssignmentFilter] = useState("tous");
  const [viewMode, setViewMode] = useState("bestPerTicker");
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      const response = await fetch(
        `${apiBase}/journal/wheel-validation/v3-candidate-profiles?limit=50&includeWeak=true`,
      ).catch(() => null);
      if (!response) {
        setFetchError("Endpoint V3 indisponible — redémarrer le serveur si nécessaire.");
        setPayload(null);
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        setFetchError(data?.error || "Impossible de charger les profils V3.");
        setPayload(null);
        return;
      }
      setPayload(data);
    } catch {
      setFetchError("Erreur réseau — profils V3 non chargés.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const rawProfiles = useMemo(() => {
    return Array.isArray(payload?.profiles) ? payload.profiles : [];
  }, [payload]);

  const normalizedSearch = searchQuery.trim().toUpperCase();

  const filteredProfiles = useMemo(() => {
    const minRank = getSampleQualityMinRank(qualityFilter);
    let filtered = rawProfiles;

    if (normalizedSearch) {
      filtered = filtered.filter((profile) =>
        String(profile.ticker ?? "").toUpperCase().includes(normalizedSearch),
      );
    }
    if (minRank > 0) {
      filtered = filtered.filter(
        (profile) => (SAMPLE_QUALITY_RANK[profile.sampleQuality] ?? 0) >= minRank,
      );
    }
    if (primeFilter === "forte") {
      filtered = filtered.filter((profile) => profile.primeStrengthLabel === "forte");
    }
    if (assignmentFilter === "rare") {
      filtered = filtered.filter((profile) => profile.assignmentRarityLabel === "rare");
    } else if (assignmentFilter === "exclude_insufficient") {
      filtered = filtered.filter((profile) => profile.assignmentRarityLabel !== "insufficient");
    }

    return filtered;
  }, [rawProfiles, normalizedSearch, qualityFilter, primeFilter, assignmentFilter]);

  const sortedProfiles = useMemo(() => sortProfiles(filteredProfiles), [filteredProfiles]);

  const displayEntries = useMemo(() => {
    if (viewMode === "raw") {
      return sortedProfiles.map((profile) => ({ profile, extraProfileCount: 0 }));
    }
    return pickBestProfilePerTicker(sortedProfiles);
  }, [sortedProfiles, viewMode]);

  const displayedEntries = useMemo(
    () => displayEntries.slice(0, visibleCount),
    [displayEntries, visibleCount],
  );

  const isBestPerTickerMode = viewMode === "bestPerTicker";

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE);
  }, [searchQuery, qualityFilter, primeFilter, assignmentFilter, viewMode]);

  const meta = payload?.meta ?? {};
  const totalProfiles = meta.totalProfiles ?? rawProfiles.length;
  const hasRawProfiles = rawProfiles.length > 0;
  const totalDisplayCount = displayEntries.length;
  const hasFilteredResults = totalDisplayCount > 0;
  const hasMoreProfiles = visibleCount < totalDisplayCount;
  const canReduceProfiles = visibleCount > DEFAULT_VISIBLE;
  const displayUnitLabel = isBestPerTickerMode ? "tickers" : "profils";
  const displayUnitLabelSingular = isBestPerTickerMode ? "ticker" : "profil";

  return (
    <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
              Prime forte + assignation rare — audit préliminaire
            </h3>
            <span className="rounded border border-violet-800/50 bg-violet-900/20 px-2 py-0.5 text-[10px] text-violet-400">
              V3B
            </span>
            {totalProfiles > 0 && (
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                {totalProfiles} profils
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-600">
            Basé sur les expirations résolues du Journal POP. Historique encore court — pas une recommandation finale.
          </p>
          {!open && totalDisplayCount > 0 && (
            <p className="mt-1.5 text-[11px] text-slate-500">
              {totalDisplayCount} {totalDisplayCount !== 1 ? displayUnitLabel : displayUnitLabelSingular} après filtres
              {meta.historyDays != null ? ` · historique ${meta.historyDays} j` : ""}
            </p>
          )}
        </div>
        <span className="flex-shrink-0 text-[10px] text-slate-500 pt-0.5">
          {open ? "Masquer ▼" : "Afficher ▶"}
        </span>
      </button>

      {open && (
        <div className="mt-5">
          {loading && (
            <p className="text-[11px] text-slate-600">Chargement des profils V3…</p>
          )}

          {!loading && fetchError && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2">
              <p className="text-[11px] text-slate-500">{fetchError}</p>
              <button
                type="button"
                onClick={loadProfiles}
                className="mt-1 text-[10px] text-sky-500 hover:text-sky-400"
              >
                Réessayer
              </button>
            </div>
          )}

          {!loading && !fetchError && !hasRawProfiles && (
            <p className="text-[11px] text-slate-600">
              Aucun profil V3 disponible pour l&apos;instant — historique résolu insuffisant.
            </p>
          )}

          {!loading && !fetchError && hasRawProfiles && (
            <>
              <div className="mb-4 rounded-xl border border-amber-900/30 bg-amber-950/20 px-3 py-2">
                <p className="text-[10px] leading-relaxed text-amber-200/70">
                  Historique encore court : la majorité des profils sont faibles/préliminaires.
                  Ne pas interpréter comme recommandation finale.
                </p>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Recherche ticker…"
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-500 w-36"
                />
                <select
                  value={qualityFilter}
                  onChange={(e) => setQualityFilter(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-slate-500"
                >
                  <option value="tous">Qualité : tous</option>
                  <option value="preliminary+">Préliminaire+</option>
                  <option value="medium+">Moyen+</option>
                  <option value="strong">Fort seulement</option>
                </select>
                <select
                  value={primeFilter}
                  onChange={(e) => setPrimeFilter(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-slate-500"
                >
                  <option value="tous">Prime : tous</option>
                  <option value="forte">Prime forte seulement</option>
                </select>
                <select
                  value={assignmentFilter}
                  onChange={(e) => setAssignmentFilter(e.target.value)}
                  className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-slate-500"
                >
                  <option value="tous">Assignation : tous</option>
                  <option value="rare">Assignation rare seulement</option>
                  <option value="exclude_insufficient">Exclure insuffisant</option>
                </select>
                <div className="flex overflow-hidden rounded-xl border border-slate-700">
                  <button
                    type="button"
                    onClick={() => setViewMode("bestPerTicker")}
                    className={`px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                      isBestPerTickerMode
                        ? "bg-violet-900/40 text-violet-300"
                        : "bg-slate-800 text-slate-500 hover:text-slate-400"
                    }`}
                  >
                    Meilleur profil par ticker
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("raw")}
                    className={`border-l border-slate-700 px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                      !isBestPerTickerMode
                        ? "bg-violet-900/40 text-violet-300"
                        : "bg-slate-800 text-slate-500 hover:text-slate-400"
                    }`}
                  >
                    Vue brute
                  </button>
                </div>
                <span className="text-[10px] text-slate-600 ml-auto">
                  {hasFilteredResults
                    ? `${Math.min(visibleCount, totalDisplayCount)} / ${totalDisplayCount} ${displayUnitLabel} affichés`
                    : `0 ${displayUnitLabelSingular} affiché`}
                </span>
              </div>

              {!hasFilteredResults && (
                <p className="text-[11px] text-slate-600">
                  {normalizedSearch
                    ? `Aucun profil V3 trouvé pour ${normalizedSearch}`
                    : "Aucun profil ne correspond aux filtres sélectionnés."}
                </p>
              )}

              {hasFilteredResults && (
                <>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {displayedEntries.map(({ profile, extraProfileCount }) => (
                      <ProfileCard
                        key={`${profile.ticker}|${profile.mode}|${profile.dteBucket}`}
                        profile={profile}
                        extraProfileCount={extraProfileCount}
                      />
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {hasMoreProfiles && (
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleCount((count) => Math.min(count + DEFAULT_VISIBLE, totalDisplayCount))
                        }
                        className="text-[11px] text-sky-500 hover:text-sky-400"
                      >
                        Afficher plus ({Math.min(visibleCount + DEFAULT_VISIBLE, totalDisplayCount)} /{" "}
                        {totalDisplayCount})
                      </button>
                    )}

                    {canReduceProfiles && (
                      <button
                        type="button"
                        onClick={() => setVisibleCount(DEFAULT_VISIBLE)}
                        className="text-[11px] text-slate-500 hover:text-slate-400"
                      >
                        Réduire à {DEFAULT_VISIBLE} {displayUnitLabel}
                      </button>
                    )}
                  </div>
                </>
              )}

              <p className="mt-4 text-[10px] text-slate-600 leading-relaxed">
                Audit préliminaire uniquement — à confirmer avec plus d&apos;historique et validation Wheel/CC.
                {payload?.generatedAt
                  ? ` Généré ${new Date(payload.generatedAt).toLocaleString()}.`
                  : ""}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
