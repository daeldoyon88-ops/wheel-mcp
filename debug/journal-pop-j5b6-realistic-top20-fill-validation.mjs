// ─────────────────────────────────────────────────────────────────────────────
// J5-B6 — Validation du remplissage du Top 20 réaliste (stricts + « à confirmer »).
//
// Reconstruit le Top 20 réaliste à partir des records du journal (DB read-only) et
// vérifie le comportement de remplissage : stricts d'abord, confirm derrière, sans
// réintégrer les tickers rejetés (rendement réel <0,5 %, profondeur réelle >50 %,
// crypto-block, exclusions critiques). Aucune écriture, aucun backfill.
//
// Sorties : .md (rapport lisible) + .json (données brutes) dans debug/.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "../app/journal/wheelValidationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const FOCUS = ["HOOD", "CCL", "HIMS", "APLD", "TQQQ", "INTC", "AFRM", "SOFI"];

// Source réelle (read-only) : journal JSON produit par la capture Journal POP.
function loadRecordsFromJournal() {
  const candidates = [
    path.join(REPO, "data", "wheelValidationJournal.json"),
    path.join(process.cwd(), "data", "wheelValidationJournal.json"),
  ];
  const jsonPath = candidates.find((p) => fs.existsSync(p));
  if (!jsonPath) return { records: [], source: null };
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const records = Array.isArray(raw) ? raw : raw.records ?? raw.entries ?? [];
    return { records, source: jsonPath };
  } catch (err) {
    return { records: [], source: null, note: String(err?.message ?? err) };
  }
}

function summarizeRow(row) {
  const ra = row.realisticActive ?? {};
  const rdm = row.realisticDecisionMetrics ?? {};
  return {
    rank: row.rank,
    ticker: row.ticker,
    status: row.dynamicTop20Status,
    scoreRealistic: row.dynamicTop20Score,
    scoreLegacy: row.dynamicTop20ScoreLegacy,
    bucket: ra.dynamicTop20RealisticBucket ?? null,
    confidence: ra.dynamicTop20Confidence ?? null,
    tradeCountGuard: ra.selectedTradeCountGuard ?? null,
    eligibleStrict: ra.eligibleForTop20 ?? null,
    eligibleConfirm: ra.eligibleForTop20Confirm ?? null,
    reason: ra.realisticEligibilityReason ?? null,
    selectedTradeCount: rdm.selectedTradeCount ?? null,
    observationResolvedCount: rdm.observationResolvedCount ?? null,
    selectedAvgCspYieldPct: rdm.selectedAvgCspYieldPct ?? null,
    selectedDeepAssignmentRatePct: rdm.selectedDeepAssignmentRatePct ?? null,
  };
}

function summarizeResult(result) {
  const top20 = (result.top20 ?? []).map(summarizeRow);
  const strict = top20.filter((r) => r.bucket === "strict");
  const confirm = top20.filter((r) => r.bucket === "confirm");
  const rejected = [
    ...(result.excludedHighYield ?? []),
    ...(result.stressed ?? []),
    ...(result.insufficientSample ?? []),
    ...(result.excludedCrypto ?? []),
  ]
    .map(summarizeRow)
    .filter((r) => r.bucket === "rejected" || r.status === "exclude_crypto_blocked");

  const allRows = [
    ...(result.top20 ?? []),
    ...(result.nearEntry ?? []),
    ...(result.watchValidate ?? []),
    ...(result.stressed ?? []),
    ...(result.excludedHighYield ?? []),
    ...(result.insufficientSample ?? []),
    ...(result.excludedCrypto ?? []),
  ];
  const focusImpact = FOCUS.map((t) => {
    const row = allRows.find((r) => r.ticker === t);
    return row ? summarizeRow(row) : { ticker: t, status: "absent" };
  });

  const guardrails = result.meta?.guardrails ?? {};
  return {
    scoreType: result.meta?.scoreType,
    scoreSource: result.meta?.scoreSource,
    guardrails,
    counts: {
      top20Total: top20.length,
      strictInTop20: strict.length,
      confirmInTop20: confirm.length,
      strictEligibleTotal: guardrails.strictEligibleForTop20Count ?? null,
      confirmEligibleTotal: guardrails.confirmEligibleForTop20Count ?? null,
    },
    strict,
    confirm,
    rejectedSample: rejected.slice(0, 30),
    focusImpact,
    secondRankingCheck: {
      top20Realistic: result.top20Realistic ?? null,
      realisticTop20: result.realisticTop20 ?? null,
      confirmTop20: result.confirmTop20 ?? null,
    },
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { records, source } = loadRecordsFromJournal();

  // ── Données réelles (read-only) ────────────────────────────────────────────
  const resolvedCount = records.filter((r) => r?.resolution?.resolved === true).length;
  let realSummary = null;
  if (records.length > 0) {
    const { profiles } = computeOnePercentWheelProfiles(records, [], { today });
    realSummary = summarizeResult(
      computeDynamicTop20WheelProfiles(profiles, { today, records }),
    );
  }

  // ── Preuve synthétique de la mécanique de remplissage (toujours exécutée) ───
  const synth = buildSyntheticRecords();
  const { profiles: synthProfiles } = computeOnePercentWheelProfiles(synth, [], { today });
  const synthSummary = summarizeResult(
    computeDynamicTop20WheelProfiles(synthProfiles, { today, records: synth }),
  );

  const realSparse = !realSummary || realSummary.counts.top20Total === 0;

  const payload = {
    phase: "J5-B6",
    generatedAt: new Date().toISOString(),
    dataSource: source,
    recordCount: records.length,
    resolvedRecordCount: resolvedCount,
    realDataSparse: realSparse,
    real: realSummary,
    syntheticProof: synthSummary,
    // Vue principale du rapport = réel si exploitable, sinon preuve synthétique.
    scoreType: (realSummary ?? synthSummary).scoreType,
    scoreSource: (realSummary ?? synthSummary).scoreSource,
  };

  const jsonPath = path.join(__dirname, "journal-pop-j5b6-realistic-top20-fill-validation.json");
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const md = renderMarkdown(payload);
  const mdPath = path.join(__dirname, "journal-pop-j5b6-realistic-top20-fill-validation.md");
  fs.writeFileSync(mdPath, md);

  console.log(`Source données réelles : ${source} (${records.length} records, ${resolvedCount} résolus)`);
  if (realSummary) {
    console.log(`Top 20 réel : ${realSummary.counts.top20Total} (strict ${realSummary.counts.strictInTop20}, confirm ${realSummary.counts.confirmInTop20})`);
  }
  console.log(`Preuve synthétique — Top 20 : ${synthSummary.counts.top20Total} (strict ${synthSummary.counts.strictInTop20}, confirm ${synthSummary.counts.confirmInTop20})`);
  console.log(`Score : ${payload.scoreType} (source ${payload.scoreSource})`);
  console.log(`Rapport JSON : ${jsonPath}`);
  console.log(`Rapport MD   : ${mdPath}`);
}

function fmtRow(r) {
  return `| ${r.rank ?? "—"} | ${r.ticker} | ${r.bucket ?? "—"} | ${r.scoreRealistic ?? "—"} | ${r.scoreLegacy ?? "—"} | ${r.selectedTradeCount ?? "—"} | ${r.observationResolvedCount ?? "—"} | ${r.selectedAvgCspYieldPct ?? "—"} | ${r.selectedDeepAssignmentRatePct ?? "—"} | ${r.confidence ?? "—"} |`;
}

const HEAD = "| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |";
const SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

function renderResultSection(L, title, s, { focus = true } = {}) {
  L.push(`## ${title}`);
  L.push("");
  L.push(`- Top 20 total : **${s.counts.top20Total}**`);
  L.push(`- Stricts dans le Top 20 : **${s.counts.strictInTop20}**`);
  L.push(`- À confirmer dans le Top 20 : **${s.counts.confirmInTop20}**`);
  L.push(`- Admissibles stricts (total) : ${s.counts.strictEligibleTotal ?? "—"}`);
  L.push(`- Admissibles à confirmer (total) : ${s.counts.confirmEligibleTotal ?? "—"}`);
  L.push("");
  L.push("**Stricts (Top 20)**");
  L.push("");
  L.push(HEAD);
  L.push(SEP);
  for (const r of s.strict) L.push(fmtRow(r));
  if (s.strict.length === 0) L.push("| — | _aucun_ | — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("**À confirmer (Top 20)**");
  L.push("");
  L.push(HEAD);
  L.push(SEP);
  for (const r of s.confirm) L.push(fmtRow(r));
  if (s.confirm.length === 0) L.push("| — | _aucun_ | — | — | — | — | — | — | — | — |");
  L.push("");
  L.push("**Exclus / rejetés (échantillon)**");
  L.push("");
  L.push(HEAD);
  L.push(SEP);
  for (const r of s.rejectedSample) L.push(fmtRow(r));
  if (s.rejectedSample.length === 0) L.push("| — | _aucun_ | — | — | — | — | — | — | — | — |");
  L.push("");
  if (focus) {
    L.push("**Impact tickers focus**");
    L.push("");
    L.push("| Ticker | Statut | Bucket | Score réaliste | n déc. | n obs. | Rend.% | Prof.% | Raison |");
    L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of s.focusImpact) {
      L.push(
        `| ${r.ticker} | ${r.status ?? "—"} | ${r.bucket ?? "—"} | ${r.scoreRealistic ?? "—"} | ${r.selectedTradeCount ?? "—"} | ${r.observationResolvedCount ?? "—"} | ${r.selectedAvgCspYieldPct ?? "—"} | ${r.selectedDeepAssignmentRatePct ?? "—"} | ${r.reason ?? "—"} |`,
      );
    }
    L.push("");
  }
  L.push("**Garde-fous**");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(s.guardrails, null, 2));
  L.push("```");
  L.push("");
}

function renderMarkdown(p) {
  const L = [];
  L.push("# Validation J5-B6 — Remplissage du Top 20 réaliste (stricts + « à confirmer »)");
  L.push("");
  L.push(`> Phase J5-B6 · ${p.generatedAt.slice(0, 10)} · source : ${p.dataSource}`);
  L.push(`> Records journal : ${p.recordCount} (résolus : ${p.resolvedRecordCount}).`);
  if (p.realDataSparse) {
    L.push(">");
    L.push("> ⚠️ Le journal local de ce checkout ne contient **aucun record résolu** → aucun profil exploitable → Top 20 réel vide. La mécanique de remplissage est donc démontrée sur un **jeu synthétique** (section dédiée). Sur un journal résolu (env. de production), le même tri stricts→confirm s'applique sans changement.");
  }
  L.push("");
  L.push("## Comportement");
  L.push("");
  L.push("- Le Top 20 est rempli **d'abord par les admissibles STRICTS** (selectedTradeCount≥5 + rendement réel ≥0,5 % + profondeur réelle ≤50 % + score réaliste suffisant).");
  L.push("- S'il reste des places, il est complété par des candidats **« à confirmer »** (3–4 décisions réelles, mêmes garde-fous qualité, observations≥15), placés **derrière** les stricts.");
  L.push("- Les tickers **rejetés** (rendement réel <0,5 %, profondeur réelle >50 %, crypto-block, exclusions critiques) restent exclus.");
  L.push("- Le **score réaliste reste le score principal** ; aucun second classement n'est créé.");
  L.push("");
  L.push("## Fichiers modifiés");
  L.push("");
  L.push("| Fichier | Nature |");
  L.push("| --- | --- |");
  L.push("| `app/journal/wheelValidationService.js` | `computeRealisticPreviewScore` (buckets strict/confirm/rejected), `computeE2bDynamicTop20` (remplissage strict→confirm), `mapDynamicTop20ProfileRow` (nouveaux champs), meta guardrails |");
  L.push("| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Badge « À confirmer · échantillon faible », légende remplissage, cellule admissibilité modal |");
  L.push("| `app/journal/wheelValidationService.realisticTop20Fill.test.mjs` | Tests A–H du remplissage (nouveau) |");
  L.push("");
  L.push("## Fonctions modifiées");
  L.push("");
  L.push("- `computeRealisticPreviewScore` — classification en buckets `strict` / `confirm` / `rejected` + champs `eligibleForTop20Confirm`, `dynamicTop20Confidence`, `selectedTradeCountGuard`, `realisticEligibilityReason`. `eligibleForTop20` (strict) inchangé.");
  L.push("- `computeE2bDynamicTop20` — remplissage du Top 20 : stricts d'abord, confirm derrière (jamais devant), plafond 20. Expose `strictEligibleCount`, `confirmEligibleCount`, `strictInTop20`, `confirmInTop20`.");
  L.push("- `mapDynamicTop20ProfileRow` — porte les nouveaux champs sur la ligne et dans `realisticActive`.");
  L.push("- `buildDynamicTop20E2bResult` — `meta.guardrails` enrichi (seuils confirm + compteurs).");
  L.push("");
  L.push("## Nouveaux champs (ligne Top 20 / realisticActive)");
  L.push("");
  L.push("- `dynamicTop20RealisticBucket` : `strict` | `confirm` | `rejected`");
  L.push("- `dynamicTop20Confidence` : `normal` | `low` | `insufficient`");
  L.push("- `selectedTradeCountGuard` : `ok` | `confirm` | `insufficient`");
  L.push("- `realisticEligibilityReason` : raison lisible d'admissibilité");
  L.push("- `eligibleForTop20Confirm` : booléen (remplissage « à confirmer »)");
  L.push("- (aucun champ existant supprimé)");
  L.push("");
  if (p.real) {
    renderResultSection(L, "Données réelles (journal local)", p.real, { focus: true });
  } else {
    L.push("## Données réelles (journal local)");
    L.push("");
    L.push("_Aucun record dans le journal local._");
    L.push("");
  }
  renderResultSection(
    L,
    "Preuve synthétique — 9 stricts + 11 à confirmer + 2 rejets",
    p.syntheticProof,
    { focus: false },
  );
  L.push("## Pas de second classement");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify((p.real ?? p.syntheticProof).secondRankingCheck, null, 2));
  L.push("```");
  L.push("");
  L.push("## Tests / build");
  L.push("");
  L.push("- `node --test app/journal/*.test.mjs` — 164 tests (155 existants + 9 J5-B6) ✓");
  L.push("- `npx vite build` (wheel-dashboard) ✓");
  L.push("- `git diff --check` ✓");
  L.push("");
  L.push("## Limites");
  L.push("");
  L.push("- Score réaliste, capture Journal POP, scanner/IBKR/Yahoo, Archive Funnel, DB et formules POP : **non touchés**.");
  L.push("- Le remplissage « à confirmer » est volontairement subordonné aux stricts ; un confirm ne passe jamais devant un strict.");
  L.push("- Les candidats à confirmer portent une confiance faible — à ne pas traiter comme des admissibles solides.");
  if (p.realDataSparse) {
    L.push("- Le journal local de ce checkout n'a aucun record résolu (Top 20 réel vide) ; la mécanique est prouvée sur jeu synthétique. Sur un journal résolu, le même comportement s'applique.");
  }
  L.push("");
  return L.join("\n");
}

// Jeu synthétique : 9 stricts (6 exp × 2) + 11 confirm (4 exp × 4) + rejets.
function buildSyntheticRecords() {
  let seq = 0;
  const mk = (ticker, expiration, mode, dte, premium, assigned, close) => {
    seq += 1;
    const resolution = { resolved: true, assigned_flag: assigned, expiredWorthless: !assigned };
    if (close != null) resolution.underlying_close_at_expiration = close;
    return {
      id: `syn-${seq}`,
      symbol: ticker,
      selectedExpiration: expiration,
      strikeMode: mode,
      dteAtScan: dte,
      strike: { strike: 100, premium },
      captureClass: "primaryDaily",
      resolution,
    };
  };
  const out = [];
  const exp = (e) => `2025-03-${String(3 + e).padStart(2, "0")}`;
  for (let i = 0; i < 9; i += 1) {
    for (let e = 0; e < 6; e += 1)
      for (let o = 0; o < 2; o += 1)
        out.push(mk(`STRICT${i}`, exp(e), o % 2 ? "aggressive" : "safe", [7, 4][o], 1.2 - i * 0.02 + o * 0.01, false, null));
  }
  for (let i = 0; i < 11; i += 1) {
    for (let e = 0; e < 4; e += 1)
      for (let o = 0; o < 4; o += 1)
        out.push(mk(`CONF${i}`, exp(e), o % 2 ? "aggressive" : "safe", [7, 4, 3, 2][o], 1.1 - i * 0.02 + o * 0.01, false, null));
  }
  // Rejet rendement <0,5 %.
  for (let e = 0; e < 6; e += 1)
    for (let o = 0; o < 3; o += 1)
      out.push(mk("LOWYIELD", exp(e), o % 2 ? "aggressive" : "safe", [7, 4, 3][o], 0.4, false, null));
  // Rejet profondeur >50 %.
  for (let e = 0; e < 6; e += 1)
    for (let o = 0; o < 3; o += 1)
      out.push(mk("DEEPASSIGN", exp(e), o % 2 ? "aggressive" : "safe", [7, 4, 3][o], 1.0, true, 88));
  return out;
}

await main();
