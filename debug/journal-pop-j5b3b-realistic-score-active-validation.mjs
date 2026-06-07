#!/usr/bin/env node
/**
 * Validation J5-B3-B — Score réaliste ACTIF comme score principal du Top 20.
 *
 * Le pipeline compétitif E2b classe désormais par le score réaliste (décision réelle
 * BALANCED + garde-fous). L'ancien score E2b est conservé dans dynamicTop20ScoreLegacy.
 * Ce script compare AVANT (ordre par ancien score E2b) vs APRÈS (ordre par score
 * réaliste actif) sur les données réelles du journal, sans rien modifier.
 *
 * Génère debug/journal-pop-j5b3b-realistic-score-active-validation.{md,json}
 */

import fs from "node:fs";
import path from "node:path";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import {
  createWheelValidationService,
  computeDynamicTop20WheelProfiles,
} from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve("debug", "journal-pop-j5b3b-realistic-score-active-validation.json");
const OUT_MD = path.resolve("debug", "journal-pop-j5b3b-realistic-score-active-validation.md");
const FOCUS_TICKERS = ["HOOD", "CCL", "HIMS", "APLD", "TQQQ", "INTC", "AFRM", "SOFI"];

function resolveStore() {
  const sqlitePath = path.resolve("data", "wheelValidationJournal.sqlite");
  if (fs.existsSync(sqlitePath)) return createWheelValidationStoreSqlite({ sqlitePath });
  const alt = path.resolve("wheel-dashboard/data/wheelValidationJournal.sqlite");
  if (fs.existsSync(alt)) return createWheelValidationStoreSqlite({ sqlitePath: alt });
  return createWheelValidationStore();
}

// Buckets « classables » (hors crypto / exclusions dures) pour comparer les ordres.
const RANK_BUCKETS = ["top20", "nearEntry", "watchValidate", "stressed", "excludedHighYield", "insufficientSample"];

function collectRows(result) {
  const rows = [];
  for (const b of RANK_BUCKETS) for (const r of result[b] ?? []) rows.push(r);
  return rows;
}

function num(v) {
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

async function main() {
  const store = resolveStore();
  const service = createWheelValidationService({ store });
  const journal = await store.load();
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const onePercent = await service.computeOnePercentWheelProfiles();
  const profiles = onePercent?.profiles ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const result = computeDynamicTop20WheelProfiles(profiles, { records, today });
  const rows = collectRows(result);

  // APRÈS = ordre par score réaliste actif (dynamicTop20Score). AVANT = ancien E2b.
  const afterRank = new Map();
  rows
    .slice()
    .sort((a, b) => (num(b.dynamicTop20Score) ?? -1e9) - (num(a.dynamicTop20Score) ?? -1e9))
    .forEach((r, i) => afterRank.set(r.ticker, i + 1));
  const beforeRank = new Map();
  rows
    .slice()
    .sort((a, b) => (num(b.dynamicTop20ScoreLegacy) ?? -1e9) - (num(a.dynamicTop20ScoreLegacy) ?? -1e9))
    .forEach((r, i) => beforeRank.set(r.ticker, i + 1));

  const snapshot = (r) => {
    const rdm = r.realisticDecisionMetrics ?? {};
    return {
      ticker: r.ticker,
      beforeRank: beforeRank.get(r.ticker) ?? null,
      afterRank: afterRank.get(r.ticker) ?? null,
      rankDelta: (beforeRank.get(r.ticker) ?? 0) - (afterRank.get(r.ticker) ?? 0),
      legacyScore: num(r.dynamicTop20ScoreLegacy),
      realisticScore: num(r.dynamicTop20Score),
      scoreSource: r.dynamicTop20ScoreSource ?? null,
      status: r.dynamicTop20Status,
      eligibleForTop20: r.realisticActive?.eligibleForTop20 ?? null,
      eligibilityReason: r.realisticActive?.eligibilityReason ?? null,
      confidenceBadge: r.realisticActive?.confidenceBadge ?? null,
      selectedTradeCount: num(rdm.selectedTradeCount),
      selectedAssignmentRatePct: num(rdm.selectedAssignmentRatePct),
      selectedDeepAssignmentRatePct: num(rdm.selectedDeepAssignmentRatePct),
      selectedAvgCspYieldPct: num(rdm.selectedAvgCspYieldPct),
      duplicationRatio: num(rdm.duplicationRatio),
      reason: r.realisticReasonSummary ?? null,
    };
  };

  const byTicker = new Map(rows.map((r) => [String(r.ticker).toUpperCase(), r]));

  const ranked = rows.map(snapshot);
  const risers = ranked.filter((r) => r.rankDelta > 0).sort((a, b) => b.rankDelta - a.rankDelta).slice(0, 10);
  const fallers = ranked.filter((r) => r.rankDelta < 0).sort((a, b) => a.rankDelta - b.rankDelta).slice(0, 10);

  const top20After = (result.top20 ?? []).map(snapshot);
  // Reconstitution AVANT (ancien Top 20 par score E2b, anciennes portes n≥10 & score≥35).
  const top20Before = rows
    .filter((r) => (num(r.dynamicTop20ScoreLegacy) ?? -1e9) >= 35 && (num(r.n) ?? 0) >= 10)
    .sort((a, b) => (num(b.dynamicTop20ScoreLegacy) ?? -1e9) - (num(a.dynamicTop20ScoreLegacy) ?? -1e9))
    .slice(0, 20)
    .map(snapshot);

  const afterSet = new Set(top20After.map((r) => r.ticker));
  const beforeSet = new Set(top20Before.map((r) => r.ticker));
  const entrants = top20After.filter((r) => !beforeSet.has(r.ticker)).map((r) => r.ticker);
  const sortants = top20Before.filter((r) => !afterSet.has(r.ticker)).map((r) => r.ticker);

  const focus = FOCUS_TICKERS.map((t) => {
    const r = byTicker.get(t);
    return r ? snapshot(r) : { ticker: t, note: "absent des buckets classables" };
  });

  const noSecondRanking =
    result.top20Realistic === undefined &&
    result.realisticTop20 === undefined &&
    result.meta?.scoreType === "dynamicTop20ScoreRealistic";

  const report = {
    phase: "Journal POP J5-B3-B — score réaliste actif (score principal Top 20)",
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    profileCount: profiles.length,
    top20UsesRealisticScore:
      top20After.length === 0 || top20After.every((r) => r.scoreSource === "realistic"),
    legacyPreserved: top20After.length === 0 || top20After.every((r) => r.legacyScore != null),
    noSecondRanking,
    scoreType: result.meta?.scoreType ?? null,
    scoreSource: result.meta?.scoreSource ?? null,
    guardrails: result.meta?.guardrails ?? null,
    top20Before,
    top20After,
    entrants,
    sortants,
    topRisers: risers,
    topFallers: fallers,
    focusTickers: focus,
    limits: [
      "Comparaison AVANT reconstruite à partir de dynamicTop20ScoreLegacy (ancien score E2b) sur le même pool de profils.",
      "Le score réaliste s'appuie sur la sélection BALANCED post-mortem pour la base décision — légitime en analyse, jamais en capture live.",
      "n max après déduplication ≈ distinctExpirationCount ; selectedTradeCount<5 reste fréquent → near_entry / insufficient_sample.",
      "Scanner / IBKR / Yahoo / Archive Funnel / DB / formules POP : non touchés.",
    ],
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  const fmtRow = (r) =>
    `| ${r.afterRank ?? "—"} | ${r.ticker} | ${r.realisticScore ?? "—"} | ${r.legacyScore ?? "—"} | ${r.selectedTradeCount ?? "—"} | ${r.selectedAssignmentRatePct ?? "—"} | ${r.selectedDeepAssignmentRatePct ?? "—"} | ${r.selectedAvgCspYieldPct ?? "—"} | ${r.duplicationRatio ?? "—"} | ${r.status} |`;

  const md = `# Validation J5-B3-B — Score réaliste actif (score principal Top 20)

> Phase J5-B3-B · ${report.generatedAt.slice(0, 10)} · ${report.recordCount} records · ${report.profileCount} profils
> Le score réaliste (décision réelle BALANCED + garde-fous) **pilote désormais le classement Top 20**. L'ancien score E2b est conservé en référence.

## Confirmations

- Top 20 utilise le score réaliste actif (\`dynamicTop20ScoreSource = "realistic"\`) : **${report.top20UsesRealisticScore ? "OUI" : "NON"}**
- Ancien score conservé (\`dynamicTop20ScoreLegacy\`) : **${report.legacyPreserved ? "OUI" : "NON"}**
- Pas de deuxième classement (un seul Top 20, \`scoreType = ${report.scoreType}\`) : **${report.noSecondRanking ? "OUI" : "NON"}**

## Garde-fous actifs

\`\`\`
${JSON.stringify(report.guardrails, null, 2)}
\`\`\`

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| \`app/journal/wheelValidationService.js\` | \`computeRealisticPreviewScore\` (garde-fous), \`computeRealisticActiveScoreForProfile\`, \`buildRealisticActiveReasonSummary\`, \`computeE2bDynamicTop20\` (tri/buckets par score réaliste), \`mapDynamicTop20ProfileRow\` (champs legacy/realistic), \`attachRealisticPreviewToDynamicTop20Result\` (base legacy) |
| \`wheel-dashboard/src/components/JournalPopPanel.jsx\` | Colonne « Score réaliste », ancien score en référence, badges confiance/admissibilité, textes « actif » |

## Champs ajoutés / renommés (ligne Top 20, pipeline E2b)

- \`dynamicTop20Score\` = **score réaliste actif** (pilote le classement)
- \`dynamicTop20ScoreRealistic\` = score réaliste
- \`dynamicTop20ScoreSource\` = \`"realistic"\`
- \`dynamicTop20ScoreLegacy\` = ancien score compétitif E2b (référence)
- \`dynamicTop20ScoreLaboratory\` = ancien score laboratoire observationnel (référence secondaire)
- \`realisticActive\` = { score, baseScore, eligibleForTop20, eligibilityReason, confidence, confidenceBadge, penalties, bonuses }
- \`realisticReasonSummary\` = raison lisible (score réaliste + ancien score + n déc. / assign. / prof. / rend. / dup.)

## Top 20 APRÈS (trié par score réaliste actif)

| Rang | Ticker | Score réaliste | Ancien E2b | n déc. | Assign.% | Prof.% | Rend.% | Dup. | Statut |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${top20After.map(fmtRow).join("\n") || "_Top 20 vide._"}

## Entrants / sortants vs ancien Top 20 (par score E2b)

- **Entrants** : ${entrants.length ? entrants.join(", ") : "_aucun_"}
- **Sortants** : ${sortants.length ? sortants.join(", ") : "_aucun_"}

## Tickers qui montent (score réaliste actif)

${risers.length ? risers.map((r) => `- **${r.ticker}** : rang ${r.beforeRank} → ${r.afterRank} (+${r.rankDelta}) · ${r.reason ?? r.eligibilityReason ?? "—"}`).join("\n") : "_Aucun._"}

## Tickers qui descendent (score réaliste actif)

${fallers.length ? fallers.map((r) => `- **${r.ticker}** : rang ${r.beforeRank} → ${r.afterRank} (${r.rankDelta}) · ${r.reason ?? r.eligibilityReason ?? "—"}`).join("\n") : "_Aucun._"}

## Impact sur les tickers focus

| Ticker | Rang av. | Rang ap. | Score réaliste | Ancien E2b | n déc. | Admissible | Raison |
| --- | --- | --- | --- | --- | --- | --- | --- |
${focus
  .map((r) =>
    r.note
      ? `| ${r.ticker} | — | — | — | — | — | — | ${r.note} |`
      : `| ${r.ticker} | ${r.beforeRank ?? "—"} | ${r.afterRank ?? "—"} | ${r.realisticScore ?? "—"} | ${r.legacyScore ?? "—"} | ${r.selectedTradeCount ?? "—"} | ${r.eligibleForTop20 === false ? "non" : "oui"} | ${r.eligibilityReason ?? r.reason ?? "—"} |`,
  )
  .join("\n")}

## Limites restantes

${report.limits.map((l) => `- ${l}`).join("\n")}

## Tests / build

- \`node --test app/journal/*.test.mjs\` — voir rapport agent.
- \`npx vite build\` (wheel-dashboard) — voir rapport agent.
- \`git diff --check\` — voir rapport agent.
`;

  fs.writeFileSync(OUT_MD, md, "utf8");
  console.log("OK", OUT_JSON);
  console.log("OK", OUT_MD);
  console.log("top20UsesRealisticScore:", report.top20UsesRealisticScore);
  console.log("noSecondRanking:", report.noSecondRanking);
  console.log("top20 size:", top20After.length, "entrants:", entrants.length, "sortants:", sortants.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
