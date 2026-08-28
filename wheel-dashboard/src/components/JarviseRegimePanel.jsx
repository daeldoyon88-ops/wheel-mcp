import React, { useEffect, useRef, useState } from "react";

const EMPTY_CONTEXT = { status: "idle", symbol: null, data: null, error: null, reasonCode: null };
const EMPTY_REGIME = { status: "idle", symbol: null, cutoff: null, data: null, error: null, reasonCode: null };

const REGIME_VECTOR_FIELDS = [
  ["primaryMarketRegime", "Régime de marché principal"],
  ["volatilityState", "Volatilité"],
  ["inflationState", "Inflation"],
  ["ratesState", "Taux"],
  ["yieldCurveShape", "Forme de la courbe des taux"],
  ["yieldCurveDirection", "Direction de la courbe des taux"],
];

const DIAGNOSTIC_FIELDS = [
  ["DatasetId_feature", "DatasetId_feature"],
  ["ParameterSetId", "ParameterSetId"],
  ["ClassifierVersionId", "ClassifierVersionId"],
  ["MacroContextBindingId", "MacroContextBindingId"],
];

function asReasonCode(payload) {
  const value = payload?.reasonCode ?? payload?.code ?? payload?.reason ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : "REFUS_JARVISE";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Réponse JSON Jarvise invalide.");
  }
}

function technicalMessage(error) {
  const message = String(error?.message || error || "").trim();
  return message || "Erreur technique Jarvise inattendue.";
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isAvailableRegimePayload(payload) {
  return payload?.status === "AVAILABLE" && isObject(payload.regimeRecord) && isObject(payload.regimeRecord.regimeVector);
}

export function JarviseRegimePanel({ symbol, apiBase }) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedApiBase = String(apiBase ?? "").replace(/\/$/, "");
  const [contextState, setContextState] = useState(EMPTY_CONTEXT);
  const [regimeState, setRegimeState] = useState(EMPTY_REGIME);
  const latestSymbolRef = useRef(normalizedSymbol);
  const contextKeyRef = useRef(null);
  const regimeInFlightRef = useRef(false);

  latestSymbolRef.current = normalizedSymbol;

  useEffect(() => {
    let active = true;

    contextKeyRef.current = null;
    regimeInFlightRef.current = false;
    setContextState({ status: normalizedSymbol ? "loading" : "idle", symbol: normalizedSymbol || null, data: null, error: null, reasonCode: null });
    setRegimeState(EMPTY_REGIME);

    if (!normalizedSymbol) return () => {
      active = false;
    };

    async function loadContext() {
      try {
        const response = await fetch(
          `${normalizedApiBase}/jarvise/r1/context?symbol=${encodeURIComponent(normalizedSymbol)}`,
        );
        const payload = await readJson(response);

        if (!active || latestSymbolRef.current !== normalizedSymbol) return;

        if (!response?.ok) {
          if (response?.status === 409) {
            setContextState({
              status: "domain-refusal",
              symbol: normalizedSymbol,
              data: null,
              error: null,
              reasonCode: asReasonCode(payload),
            });
            return;
          }
          throw new Error(`HTTP ${response?.status ?? "inconnu"} lors du contexte Jarvise.`);
        }

        if (!isObject(payload) || typeof payload.captureAvailable !== "boolean") {
          throw new Error("Réponse de contexte Jarvise inattendue.");
        }

        const cutoff = payload.effectiveKnowledgeCutoff;
        const nextContextKey = payload.captureAvailable ? `${normalizedSymbol}\u0000${String(cutoff ?? "")}` : null;
        if (contextKeyRef.current && contextKeyRef.current !== nextContextKey) {
          setRegimeState(EMPTY_REGIME);
        }
        contextKeyRef.current = nextContextKey;
        setContextState({ status: "available", symbol: normalizedSymbol, data: payload, error: null, reasonCode: null });
      } catch (error) {
        if (!active || latestSymbolRef.current !== normalizedSymbol) return;
        contextKeyRef.current = null;
        setContextState({
          status: "technical-error",
          symbol: normalizedSymbol,
          data: null,
          error: technicalMessage(error),
          reasonCode: null,
        });
      }
    }

    void loadContext();
    return () => {
      active = false;
    };
  }, [normalizedApiBase, normalizedSymbol]);

  const currentContext =
    contextState.symbol === normalizedSymbol && contextState.status === "available" ? contextState.data : null;
  const currentCutoff = currentContext?.effectiveKnowledgeCutoff ?? null;
  const currentRegime =
    regimeState.symbol === normalizedSymbol &&
    regimeState.cutoff === currentCutoff &&
    regimeState.status === "available"
      ? regimeState.data
      : null;

  async function analyseRegime() {
    if (
      !currentContext?.captureAvailable ||
      !currentCutoff ||
      regimeState.status === "loading" ||
      regimeInFlightRef.current
    ) {
      return;
    }

    const requestedSymbol = normalizedSymbol;
    const requestedCutoff = currentContext.effectiveKnowledgeCutoff;
    const requestedContextKey = `${requestedSymbol}\u0000${String(requestedCutoff)}`;
    regimeInFlightRef.current = true;
    setRegimeState({ status: "loading", symbol: requestedSymbol, cutoff: requestedCutoff, data: null, error: null, reasonCode: null });

    try {
      const response = await fetch(
        `${normalizedApiBase}/jarvise/r1/regime?symbol=${encodeURIComponent(requestedSymbol)}&knowledgeCutoff=${encodeURIComponent(requestedCutoff)}`,
      );
      const payload = await readJson(response);

      if (latestSymbolRef.current !== requestedSymbol || contextKeyRef.current !== requestedContextKey) return;

      if (!response?.ok) {
        if (response?.status === 409) {
          setRegimeState({
            status: "domain-refusal",
            symbol: requestedSymbol,
            cutoff: requestedCutoff,
            data: null,
            error: null,
            reasonCode: asReasonCode(payload),
          });
          return;
        }
        throw new Error(`HTTP ${response?.status ?? "inconnu"} lors de l'analyse Jarvise.`);
      }

      if (!isAvailableRegimePayload(payload)) {
        throw new Error("Réponse de régime Jarvise inattendue.");
      }
      setRegimeState({ status: "available", symbol: requestedSymbol, cutoff: requestedCutoff, data: payload, error: null, reasonCode: null });
    } catch (error) {
      if (latestSymbolRef.current !== requestedSymbol || contextKeyRef.current !== requestedContextKey) return;
      setRegimeState({
        status: "technical-error",
        symbol: requestedSymbol,
        cutoff: requestedCutoff,
        data: null,
        error: technicalMessage(error),
        reasonCode: null,
      });
    } finally {
      regimeInFlightRef.current = false;
    }
  }

  if (!normalizedSymbol) return null;

  const isRegimeLoading = regimeState.status === "loading" && regimeState.symbol === normalizedSymbol;
  const currentDomainRefusal =
    regimeState.symbol === normalizedSymbol && regimeState.cutoff === currentCutoff && regimeState.status === "domain-refusal"
      ? regimeState.reasonCode
      : contextState.symbol === normalizedSymbol && contextState.status === "domain-refusal"
      ? contextState.reasonCode
      : null;
  const currentTechnicalError =
    regimeState.symbol === normalizedSymbol && regimeState.cutoff === currentCutoff && regimeState.status === "technical-error"
      ? regimeState.error
      : contextState.symbol === normalizedSymbol && contextState.status === "technical-error"
      ? contextState.error
      : null;
  const currentRegimeRecord = currentRegime?.regimeRecord ?? null;
  const currentRegimeVector = currentRegimeRecord?.regimeVector ?? null;
  const diagnosticEntries = currentRegimeRecord
    ? DIAGNOSTIC_FIELDS.filter(([field]) => currentRegimeRecord[field] != null)
      .map(([field, label]) => [field, label, currentRegimeRecord[field]])
    : [];
  const regimeVectorEntries = currentRegimeVector
    ? REGIME_VECTOR_FIELDS.filter(([field]) => Object.prototype.hasOwnProperty.call(currentRegimeVector, field))
      .map(([field, label]) => [field, label, currentRegimeVector[field]])
    : [];

  return (
    <section className="rounded-2xl border border-cyan-800/50 bg-cyan-950/15 p-4" aria-label="Jarvise">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-cyan-100">Jarvise — contexte de régime</p>
          <p className="mt-1 text-xs text-cyan-200/70">Symbole sélectionné : {normalizedSymbol}</p>
        </div>
        <span className="rounded border border-cyan-700/60 bg-cyan-900/30 px-2 py-1 text-xs text-cyan-200">Lecture seule</span>
      </div>

      {contextState.status === "loading" ? <p className="mt-3 text-sm text-slate-300">Chargement du contexte Jarvise…</p> : null}

      {currentContext?.captureAvailable === false ? (
        <p className="mt-3 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm text-slate-300">
          Capture Jarvise indisponible pour ce symbole. Aucune analyse de régime n&apos;est lancée.
        </p>
      ) : null}

      {currentContext?.captureAvailable === true ? (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
            {currentContext.sessionDate != null ? <p>Session : {String(currentContext.sessionDate)}</p> : null}
            {currentContext.effectiveKnowledgeCutoff != null ? (
              <p>Cutoff de connaissance : {String(currentContext.effectiveKnowledgeCutoff)}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={analyseRegime}
            disabled={isRegimeLoading || !currentCutoff}
            className="rounded-lg border border-cyan-500/60 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRegimeLoading ? "Analyse Jarvise en cours…" : "Analyser avec Jarvise"}
          </button>
        </div>
      ) : null}

      {currentDomainRefusal ? (
        <p className="mt-3 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          Refus Jarvise : <span className="font-mono">{currentDomainRefusal}</span>
        </p>
      ) : null}

      {currentTechnicalError ? (
        <p role="alert" className="mt-3 rounded-lg border border-rose-700/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
          Erreur technique Jarvise : {currentTechnicalError}
        </p>
      ) : null}

      {currentRegime ? (
        <div className="mt-3 rounded-lg border border-cyan-800/60 bg-slate-950/35 p-3">
          <p className="text-sm font-semibold text-cyan-100">Résultat Jarvise</p>
          <div className="mt-2 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
            <p>Symbole : {String(currentRegime.symbol ?? normalizedSymbol)}</p>
            {currentContext.sessionDate != null ? <p>Session : {String(currentContext.sessionDate)}</p> : null}
            {currentCutoff != null ? <p>Cutoff : {String(currentCutoff)}</p> : null}
            <p>RegimeRecordId : {String(currentRegimeRecord.regimeRecordId)}</p>
            <p>
              Qualité de classification : {String(currentRegimeRecord.classificationQuality ?? "Non disponible")}
              {currentRegimeRecord.classificationQuality === "PARTIAL" ? " — Partiel — F1 initial" : ""}
            </p>
            {regimeVectorEntries.map(([field, label, value]) => (
              <p key={field}>
                {label} : {value == null ? "Non classifié — indisponible" : String(value)}
              </p>
            ))}
          </div>
          {diagnosticEntries.length > 0 ? (
            <details className="mt-3 text-xs text-slate-400">
              <summary className="cursor-pointer text-slate-300">Identités diagnostiques</summary>
              <dl className="mt-2 space-y-1">
                {diagnosticEntries.map(([field, label, value]) => (
                  <div key={field}>
                    <dt className="inline font-medium text-slate-300">{label} :</dt> <dd className="inline font-mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default JarviseRegimePanel;
