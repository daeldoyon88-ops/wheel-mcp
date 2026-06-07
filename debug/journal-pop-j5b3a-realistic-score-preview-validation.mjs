#!/usr/bin/env node
/**
 * Validation J5-B3-A — Preview score réaliste (simulation seulement).
 * Génère debug/journal-pop-j5b3a-realistic-score-preview-validation.{md,json}
 */

import fs from "node:fs";
import path from "node:path";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import {
  createWheelValidationService,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
  computeRealisticPreviewScore,
} from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve("debug", "journal-pop-j5b3a-realistic-score-preview-validation.json");
const OUT_MD = path.resolve("debug", "journal-pop-j5b3a-realistic-score-preview-validation.md");
const FOCUS_TICKERS = ["TQQQ", "APLD", "HOOD", "SOFI", "CCL", "HIMS"];

function resolveStore() {
  const sqlitePath = path.resolve("data", "wheelValidationJournal.sqlite");
  if (fs.existsSync(sqlitePath)) {
    return createWheelValidationStoreSqlite({ sqlitePath });
  }
  const jsonPath = path.resolve("wheel-dashboard/data/wheelValidationJournal.sqlite");
  if (fs.existsSync(jsonPath)) {
    return createWheelValidationStoreSqlite({ sqlitePath: jsonPath });
  }
  return createWheelValidationStore();
}

function rowSnapshot(row) {
  return {
    ticker: row.ticker,
    currentRank: row.rank,
    previewRank: row.realisticPreviewRank ?? null,
    officialScore: row.dynamicTop20Score,
    previewScore: row.realisticPreview?.score ?? null,
    rankDelta: row.realisticPreview?.rankDelta ?? 0,
    rankImpactReason: row.realisticPreview?.rankImpactReason ?? null,
    confidence: row.realisticPreview?.confidence ?? null,
    status: row.dynamicTop20Status,
  };
}

async function main() {
  const store = resolveStore();
  const service = createWheelValidationService({ store });
  const journal = await store.load();
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const onePercent = await service.computeOnePercentWheelProfiles();
  const profiles = onePercent?.profiles ?? [];
  const withPreview = computeDynamicTop20WheelProfiles(profiles, { records, today: new Date().toISOString().slice(0, 10) });

  const stripped = profiles.map((p) => {
    const { realisticDecisionMetrics, ...rest } = p;
    void realisticDecisionMetrics;
    return rest;
  });
  const withoutRdm = computeDynamicTop20WheelProfiles(stripped, { records, today: new Date().toISOString().slice(0, 10) });

  const order = (res) =>
    [...(res.top20 ?? []), ...(res.nearEntry ?? []), ...(res.watchValidate ?? []), ...(res.insufficientSample ?? [])].map(
      (r) => ({
        ticker: r.ticker,
        score: r.dynamicTop20Score,
        status: r.dynamicTop20Status,
        rank: r.rank,
      }),
    );

  const officialOrder = order(withPreview);
  const controlOrder = order(withoutRdm);
  const top20Unchanged = JSON.stringify(officialOrder) === JSON.stringify(controlOrder);

  const top20Rows = (withPreview.top20 ?? []).map(rowSnapshot);
  const risers = top20Rows
    .filter((r) => (r.rankDelta ?? 0) > 0)
    .sort((a, b) => b.rankDelta - a.rankDelta);
  const fallers = top20Rows
    .filter((r) => (r.rankDelta ?? 0) < 0)
    .sort((a, b) => a.rankDelta - b.rankDelta);

  const focusImpact = FOCUS_TICKERS.map((ticker) => {
    const row = [...(withPreview.top20 ?? []), ...(withPreview.nearEntry ?? []), ...(withPreview.watchValidate ?? [])].find(
      (r) => String(r.ticker).toUpperCase() === ticker,
    );
    return row ? rowSnapshot(row) : { ticker, currentRank: null, previewRank: null, note: "hors Top 20 / near / watch" };
  });

  const report = {
    phase: "Journal POP J5-B3-A — preview score réaliste (simulation)",
    generatedAt: new Date().toISOString(),
    additiveOnly: true,
    noScoreOrSortChange: top20Unchanged,
    noSecondRanking: true,
    filesModified: [
      { path: "app/journal/wheelValidationService.js", change: "additif" },
      { path: "wheel-dashboard/src/components/JournalPopPanel.jsx", change: "additif UI" },
    ],
    filesCreated: [
      "app/journal/wheelValidationService.realisticPreviewScore.test.mjs",
      "debug/journal-pop-j5b3a-realistic-score-preview-validation.mjs",
      "debug/journal-pop-j5b3a-realistic-score-preview-validation.md",
      "debug/journal-pop-j5b3a-realistic-score-preview-validation.json",
    ],
    functionsAdded: ["computeRealisticPreviewScore (exportée)", "attachRealisticPreviewToDynamicTop20Result (interne)"],
    fieldsAdded: {
      realisticPreview: [
        "score",
        "baseScore",
        "rankImpactReason",
        "penalties",
        "bonuses",
        "confidence",
        "wouldImprove",
        "wouldDecline",
        "rankDelta",
        "previewOnly",
      ],
      realisticPreviewRank: "rang simulé global (buckets top20 + nearEntry + watchValidate + insufficientSample)",
    },
    preservedFields: [
      "dynamicTop20Score",
      "dynamicTop20Status",
      "rank (officiel)",
      "verdicts",
      "formules POP",
    ],
    proofTop20Unchanged: {
      officialOrderMatchesControl: top20Unchanged,
      top20OfficialOrder: (withPreview.top20 ?? []).map((r) => ({ ticker: r.ticker, rank: r.rank, score: r.dynamicTop20Score })),
      sampleScoresUnchanged: top20Rows.every(
        (r) => r.officialScore === controlOrder.find((c) => c.ticker === r.ticker)?.score,
      ),
    },
    topRisers: risers.slice(0, 10),
    topFallers: fallers.slice(0, 10),
    focusTickers: focusImpact,
    limits: [
      "Pondération légère — pas la formule finale J5-B3.",
      "Preview rank compare tous les profils des buckets top20/nearEntry/watchValidate/insufficientSample.",
      "Ne remplace pas dynamicTop20Score ni le tri officiel.",
      "BALANCED reste post-mortem pour la sélection décision.",
    ],
    recordCount: records.length,
    top20Count: withPreview.top20?.length ?? 0,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const md = `# Validation J5-B3-A — Preview score réaliste (simulation)

> Phase J5-B3-A · ${report.generatedAt.slice(0, 10)} · **additif uniquement** — aucun score officiel, tri ni verdict modifié.

## Objectif

Calculer un **score réaliste simulé** à partir de \`dynamicTop20Score\` + \`realisticDecisionMetrics\`, afficher l'impact de rang potentiel, **sans** modifier le classement Top 20 réel.

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| \`app/journal/wheelValidationService.js\` | \`computeRealisticPreviewScore\`, \`attachRealisticPreviewToDynamicTop20Result\` |
| \`wheel-dashboard/src/components/JournalPopPanel.jsx\` | UI compacte + modal preview |

## Fichiers créés

| Fichier | Nature |
| --- | --- |
| \`app/journal/wheelValidationService.realisticPreviewScore.test.mjs\` | Tests unitaires |
| \`debug/journal-pop-j5b3a-realistic-score-preview-validation.mjs\` | Script rapport |
| \`debug/journal-pop-j5b3a-realistic-score-preview-validation.md\` | Rapport |
| \`debug/journal-pop-j5b3a-realistic-score-preview-validation.json\` | Rapport machine |

## Fonctions ajoutées

- **\`computeRealisticPreviewScore(profileOrRow)\`** — exportée. Base = \`dynamicTop20Score\` ; ajustements légers via duplication, profondeur réelle, échantillon, assignation, rendement, win rate.
- **\`attachRealisticPreviewToDynamicTop20Result(result)\`** — interne. Attache \`realisticPreview\` + \`realisticPreviewRank\` après construction du Top 20 ; **ne re-trie pas** les tableaux officiels.

## Champs ajoutés

\`\`\`
realisticPreview: {
  score, baseScore, rankImpactReason, penalties, bonuses,
  confidence, wouldImprove, wouldDecline, rankDelta, previewOnly
}
realisticPreviewRank
\`\`\`

## Preuve « Top 20 réel non modifié »

- Ordre officiel identique avec/sans \`realisticDecisionMetrics\` : **${top20Unchanged ? "OUI" : "NON"}**
- \`dynamicTop20Score\` inchangé sur chaque ligne Top 20 : **${report.proofTop20Unchanged.sampleScoresUnchanged ? "OUI" : "NON"}**
- Les tableaux \`top20\`, \`nearEntry\`, etc. gardent le même ordre ; seuls des champs additifs sont écrits sur les objets ligne.

### Top 20 officiel (ordre inchangé)

| Rang | Ticker | Score officiel | Preview | Rang sim. | Delta |
| --- | --- | --- | --- | --- | --- |
${top20Rows
  .map(
    (r) =>
      `| ${r.currentRank ?? "—"} | ${r.ticker} | ${r.officialScore ?? "—"} | ${r.previewScore ?? "—"} | ${r.previewRank ?? "—"} | ${r.rankDelta > 0 ? `+${r.rankDelta}` : r.rankDelta} |`,
  )
  .join("\n")}

## Tickers qui monteraient (preview)

${risers.length ? risers.map((r) => `- **${r.ticker}** : rang ${r.currentRank} → ${r.previewRank} (${r.rankImpactReason})`).join("\n") : "_Aucun dans le Top 20 actuel._"}

## Tickers qui descendraient (preview)

${fallers.length ? fallers.map((r) => `- **${r.ticker}** : rang ${r.currentRank} → ${r.previewRank} (${r.rankImpactReason})`).join("\n") : "_Aucun dans le Top 20 actuel._"}

## Focus TQQQ / APLD / HOOD / SOFI / CCL / HIMS

| Ticker | Rang off. | Rang sim. | Score off. | Preview | Raison |
| --- | --- | --- | --- | --- | --- |
${focusImpact
  .map(
    (r) =>
      `| ${r.ticker} | ${r.currentRank ?? "—"} | ${r.previewRank ?? "—"} | ${r.officialScore ?? "—"} | ${r.previewScore ?? "—"} | ${r.rankImpactReason ?? r.note ?? "—"} |`,
  )
  .join("\n")}

## Limites

${report.limits.map((l) => `- ${l}`).join("\n")}

## Tests / build

Voir exécution \`node --test app/journal/*.test.mjs\`, \`npx vite build\`, \`git diff --check\` dans le rapport final de l'agent.
`;

  fs.writeFileSync(OUT_MD, md, "utf8");
  console.log("OK", OUT_JSON);
  console.log("OK", OUT_MD);
  console.log("top20Unchanged:", top20Unchanged);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
