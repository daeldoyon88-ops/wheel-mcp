import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JarviseRegimePanel } from "./JarviseRegimePanel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const API_BASE = "http://127.0.0.1:3001";
const ORIGINAL_FETCH = globalThis.fetch;

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderPanel(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (nextProps) => {
    act(() => {
      root.render(<JarviseRegimePanel apiBase={API_BASE} {...nextProps} />);
    });
  };
  render(props);
  return {
    container,
    render,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("JarviseRegimePanel", () => {
  it("charge un seul contexte sélectionné, informe sans capture et ne lance aucune acquisition", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(
      response(200, {
        symbol: "AAPL",
        captureAvailable: false,
        sessionDate: null,
        effectiveKnowledgeCutoff: null,
        historicalReplaySupport: "UNAVAILABLE",
      }),
    );
    const view = renderPanel({ symbol: "AAPL" });
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(`${API_BASE}/jarvise/r1/context?symbol=AAPL`);
    expect(view.container.textContent).toContain("Capture Jarvise indisponible");
    expect(view.container.querySelector("button")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(300000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][0]).not.toContain("/scan_shortlist");
    expect(globalThis.fetch.mock.calls[0][0]).not.toContain("/tools/get_technicals");
    view.cleanup();
  });

  it("utilise exclusivement le cutoff reçu pour l'action manuelle et rend le résultat PARTIAL", async () => {
    const cutoff = "2026-08-26T20:00:00.000Z";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          symbol: "AAPL",
          captureAvailable: true,
          sessionDate: "2026-08-26",
          effectiveKnowledgeCutoff: cutoff,
          historicalReplaySupport: "UNAVAILABLE",
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          status: "AVAILABLE",
          reasonCode: null,
          symbol: "AAPL",
          RegimeRecordId: "root-decoy-regime",
          primaryMarketRegime: "ROOT_RISK_ON",
          classificationQuality: "ROOT_COMPLETE",
          regimeRecord: {
            regimeRecordId: "regime-r1",
            classificationQuality: "PARTIAL",
            regimeVector: {
              primaryMarketRegime: "RISK_ON",
              volatilityState: null,
              inflationState: null,
              ratesState: null,
              yieldCurveShape: null,
              yieldCurveDirection: null,
            },
            DatasetId_feature: "feature-r1",
            ParameterSetId: "parameter-r1",
            ClassifierVersionId: "classifier-r1",
            MacroContextBindingId: "macro-r1",
          },
        }),
      );
    const view = renderPanel({ symbol: "AAPL" });
    await settle();

    const button = view.container.querySelector("button");
    expect(button?.textContent).toContain("Analyser avec Jarvise");
    await click(button);
    await settle();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${API_BASE}/jarvise/r1/regime?symbol=AAPL&knowledgeCutoff=${encodeURIComponent(cutoff)}`,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("RISK_ON");
    expect(view.container.textContent).toContain("Partiel — F1 initial");
    expect(view.container.textContent).toContain("regime-r1");
    expect(view.container.textContent).toContain("Non classifié — indisponible");
    expect(view.container.textContent).toContain("feature-r1");
    expect(view.container.textContent).not.toContain("ROOT_RISK_ON");
    expect(view.container.textContent).not.toContain("ROOT_COMPLETE");
    expect(view.container.textContent).not.toContain("root-decoy-regime");
    view.cleanup();
  });

  it("distingue les refus métier contrôlés des erreurs techniques", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          symbol: "AAPL",
          captureAvailable: true,
          sessionDate: "2026-08-26",
          effectiveKnowledgeCutoff: "cutoff-a",
        }),
      )
      .mockResolvedValueOnce(response(409, { reasonCode: "INSUFFICIENT_DATA" }))
      .mockResolvedValueOnce(
        response(200, {
          symbol: "MSFT",
          captureAvailable: true,
          sessionDate: "2026-08-26",
          effectiveKnowledgeCutoff: "cutoff-m",
        }),
      )
      .mockResolvedValueOnce(response(500, { message: "failure" }));
    const view = renderPanel({ symbol: "AAPL" });
    await settle();
    await click(view.container.querySelector("button"));
    await settle();
    expect(view.container.textContent).toContain("Refus Jarvise : INSUFFICIENT_DATA");
    expect(view.container.textContent).not.toContain("Erreur technique Jarvise");

    view.render({ symbol: "MSFT" });
    await settle();
    await click(view.container.querySelector("button"));
    await settle();
    expect(view.container.querySelector("[role='alert']")?.textContent).toContain("HTTP 500");
    view.cleanup();
  });

  it("bloque les requêtes concurrentes et masque les résultats périmés au changement de symbole ou cutoff", async () => {
    const pendingRegime = deferred();
    const pendingMsftContext = deferred();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          symbol: "AAPL",
          captureAvailable: true,
          sessionDate: "2026-08-26",
          effectiveKnowledgeCutoff: "cutoff-a1",
        }),
      )
      .mockReturnValueOnce(pendingRegime.promise)
      .mockReturnValueOnce(pendingMsftContext.promise)
      .mockResolvedValueOnce(
        response(200, {
          symbol: "AAPL",
          captureAvailable: true,
          sessionDate: "2026-08-27",
          effectiveKnowledgeCutoff: "cutoff-a2",
        }),
      );
    const view = renderPanel({ symbol: "AAPL" });
    await settle();

    const firstButton = view.container.querySelector("button");
    await click(firstButton);
    expect(firstButton.disabled).toBe(true);
    await click(firstButton);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingRegime.resolve(response(200, {
        status: "AVAILABLE",
        symbol: "AAPL",
        regimeRecord: {
          regimeRecordId: "stale-aapl",
          classificationQuality: "PARTIAL",
          regimeVector: { primaryMarketRegime: "STALE_AAPL" },
        },
      }));
      await Promise.resolve();
    });
    await settle();
    expect(view.container.textContent).toContain("STALE_AAPL");

    view.render({ symbol: "MSFT" });
    expect(view.container.textContent).not.toContain("STALE_AAPL");
    await act(async () => {
      pendingMsftContext.resolve(
        response(200, {
          symbol: "MSFT",
          captureAvailable: false,
          sessionDate: null,
          effectiveKnowledgeCutoff: null,
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(view.container.textContent).toContain("Capture Jarvise indisponible");

    view.render({ symbol: "AAPL" });
    await settle();
    expect(view.container.textContent).not.toContain("STALE_AAPL");
    expect(view.container.textContent).toContain("cutoff-a2");
    view.cleanup();
  });

  it("ne rend aucun contrôle de trading, ordre ou IBKR", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      response(200, {
        symbol: "AAPL",
        captureAvailable: true,
        sessionDate: "2026-08-26",
        effectiveKnowledgeCutoff: "cutoff-a",
      }),
    );
    const view = renderPanel({ symbol: "AAPL" });
    await settle();

    expect([...view.container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Analyser avec Jarvise",
    ]);
    expect(view.container.textContent).not.toMatch(/IBKR|acheter|vendre|ordre|trade/i);
    view.cleanup();
  });
});
