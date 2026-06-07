#!/usr/bin/env node
/**
 * BACKFILL CONTRÔLÉ J2-C — expiration = selectedExpiration (Journal POP)
 * ---------------------------------------------------------------------
 * Aligne les données historiques en base : pour chaque record où
 *   expiration !== selectedExpiration (les deux présents)
 * met `expiration = selectedExpiration`.
 *
 * NE TOUCHE PAS : selectedExpiration, resolution, assigned, strike, premium,
 * yield, POP, DTE, mode, scanSessionId, expirationCohort, schéma DB.
 *
 * Deux champs sont synchronisés pour chaque record ciblé :
 *   - colonne dénormalisée `expiration`
 *   - champ `expiration` dans `rawJson` (source lue par store.load())
 *
 * Modes :
 *   node debug/journal-pop-j2-expiration-backfill.mjs --dry-run
 *   node debug/journal-pop-j2-expiration-backfill.mjs --apply
 *
 * Sécurité :
 *   - dry-run obligatoire avant mutation (le mode par défaut est dry-run).
 *   - --apply requis pour muter ; sinon refus.
 *   - backup SQLite avant toute mutation ; si backup échoue → arrêt.
 *   - cible attendue = 142 records ; tout écart → arrêt (apply) / warning (dry-run).
 *   - validation post-apply : totalMismatchAfter === 0, counts inchangés.
 *   - jamais de suppression de record. Aucun git add / commit.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";

const EXPECTED_TARGET = 142;
const FOCUS_TICKERS = ["TQQQ", "APLD", "HOOD", "SOFI", "BAC"];

const OUT_DIR = path.resolve("debug");
const BACKUP_DIR = path.resolve("debug", "backups");
const OUT_DRYRUN_JSON = path.join(OUT_DIR, "journal-pop-j2-expiration-backfill-dryrun.json");
const OUT_DRYRUN_MD = path.join(OUT_DIR, "journal-pop-j2-expiration-backfill-dryrun.md");
const OUT_APPLY_JSON = path.join(OUT_DIR, "journal-pop-j2-expiration-backfill-apply.json");
const OUT_APPLY_MD = path.join(OUT_DIR, "journal-pop-j2-expiration-backfill-apply.md");

// ── helpers (alignés sur journal-pop-j2-expiration-mismatch-audit.mjs) ──────────
const sym = (v) => String(v ?? "").trim().toUpperCase();

function normCompact(value) {
  const raw = String(value ?? "").trim().replace(/-/g, "");
  return /^\d{8}$/.test(raw) ? raw : "";
}

function getResolvedFlag(record) {
  return (record?.resolution?.resolved ?? record?.resolved) === true;
}

function getAssignedFlag(record) {
  if (record?.resolution?.assigned_flag === true || record?.resolution?.assigned === true) return true;
  if (record?.resolution?.assigned_flag === false || record?.resolution?.assigned === false) return false;
  if (record?.assigned_flag === true || record?.assigned === true) return true;
  if (record?.assigned_flag === false || record?.assigned === false) return false;
  return null;
}

function isMismatchRecord(record) {
  const exp = normCompact(record?.expiration);
  const sel = normCompact(record?.selectedExpiration);
  return Boolean(exp && sel && exp !== sel);
}

function countBy(records, picker) {
  const m = {};
  for (const r of records) {
    const k = picker(r) ?? "—";
    m[k] = (m[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function summarizeCounts(records) {
  return {
    recordCount: records.length,
    resolvedCount: records.filter(getResolvedFlag).length,
    pendingCount: records.filter((r) => !getResolvedFlag(r)).length,
    assignedCount: records.filter((r) => getAssignedFlag(r) === true).length,
    notAssignedCount: records.filter((r) => getAssignedFlag(r) === false).length,
    mismatchCount: records.filter(isMismatchRecord).length,
    byFocusTicker: Object.fromEntries(
      FOCUS_TICKERS.map((t) => [
        t,
        records.filter((r) => sym(r?.symbol ?? r?.ticker) === t).length,
      ]),
    ),
  };
}

function mapMismatchRow(record) {
  return {
    id: record?.id ?? null,
    ticker: sym(record?.symbol ?? record?.ticker),
    strikeMode: record?.strikeMode ?? null,
    scanDate: record?.scanDate ?? null,
    captureClass: record?.captureClass ?? "primaryDaily",
    expiration: record?.expiration ?? null,
    selectedExpiration: record?.selectedExpiration ?? null,
    resolved: getResolvedFlag(record),
    assigned: getAssignedFlag(record),
  };
}

function buildDistribution(mismatchRecords) {
  return {
    totalMismatch: mismatchRecords.length,
    resolvedMismatch: mismatchRecords.filter(getResolvedFlag).length,
    pendingMismatch: mismatchRecords.filter((r) => !getResolvedFlag(r)).length,
    byTicker: countBy(mismatchRecords, (r) => sym(r?.symbol ?? r?.ticker)),
    byCaptureClass: countBy(mismatchRecords, (r) => r?.captureClass ?? "primaryDaily"),
    byExpiration: countBy(mismatchRecords, (r) => normCompact(r?.expiration)),
    bySelectedExpiration: countBy(mismatchRecords, (r) => normCompact(r?.selectedExpiration)),
    byScanDate: countBy(mismatchRecords, (r) => String(r?.scanDate ?? "").slice(0, 10)),
  };
}

function focusExamples(mismatchRows) {
  const out = {};
  for (const t of FOCUS_TICKERS) {
    out[t] = mismatchRows.filter((r) => r.ticker === t).slice(0, 5);
  }
  return out;
}

// ── load via le store (lit rawJson — source faisant foi, identique à l'audit) ──
async function loadRecords() {
  const store = createWheelValidationStoreSqlite();
  const journal = await store.load();
  const records = Array.isArray(journal?.records) ? journal.records : [];
  return { dbPath: store.sqlitePath, records };
}

// ── MODE DRY-RUN ───────────────────────────────────────────────────────────────
async function runDryRun() {
  const { dbPath, records } = await loadRecords();
  const mismatchRecords = records.filter(isMismatchRecord);
  const mismatchRows = mismatchRecords.map(mapMismatchRow);
  const distribution = buildDistribution(mismatchRecords);
  const countsBefore = summarizeCounts(records);

  const payload = {
    generatedAt: new Date().toISOString(),
    phase: "Journal POP J2-C — backfill expiration = selectedExpiration (DRY-RUN)",
    mode: "dry-run",
    mutated: false,
    dbPath,
    expectedTarget: EXPECTED_TARGET,
    totalMismatch: distribution.totalMismatch,
    resolvedMismatch: distribution.resolvedMismatch,
    pendingMismatch: distribution.pendingMismatch,
    countMatchesExpected: distribution.totalMismatch === EXPECTED_TARGET,
    countsBefore,
    distribution,
    focusExamples: focusExamples(mismatchRows),
    mismatchRecords: mismatchRows,
    plannedMutation: {
      action: "SET expiration = selectedExpiration (colonne + rawJson) sur les records ciblés",
      doesNotTouch: [
        "selectedExpiration", "resolution", "assigned", "resolved", "strike", "premium",
        "annualizedYield", "popEstimate", "dteAtScan", "strikeMode", "scanSessionId",
        "expirationCohort", "schéma DB",
      ],
    },
  };

  fs.writeFileSync(OUT_DRYRUN_JSON, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(OUT_DRYRUN_MD, renderDryRunMd(payload), "utf8");

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  BACKFILL J2-C — DRY-RUN (aucune mutation)");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  DB                : ${dbPath}`);
  console.log(`  Records total     : ${countsBefore.recordCount}`);
  console.log(`  totalMismatch     : ${distribution.totalMismatch} (attendu ${EXPECTED_TARGET})`);
  console.log(`  resolvedMismatch  : ${distribution.resolvedMismatch}`);
  console.log(`  pendingMismatch   : ${distribution.pendingMismatch}`);
  console.log(`  Tickers affectés  : ${Object.keys(distribution.byTicker).length}`);
  console.log("");
  console.log("  Distribution par captureClass :");
  for (const [k, v] of Object.entries(distribution.byCaptureClass)) console.log(`    - ${k}: ${v}`);
  console.log("");
  console.log("  Focus tickers (mismatch) :");
  for (const t of FOCUS_TICKERS) {
    const n = distribution.byTicker[t] ?? 0;
    console.log(`    - ${t}: ${n}`);
  }
  console.log("");
  console.log(`  JSON : ${OUT_DRYRUN_JSON}`);
  console.log(`  MD   : ${OUT_DRYRUN_MD}`);
  console.log("");

  if (distribution.totalMismatch !== EXPECTED_TARGET) {
    console.error(
      `⚠️  ARRÊT : totalMismatch=${distribution.totalMismatch} ≠ ${EXPECTED_TARGET} attendu. ` +
        `Vérifier avant tout --apply (le mode apply refusera de muter).`,
    );
    process.exitCode = 2;
  } else {
    console.log(`✅ DRY-RUN OK : ${EXPECTED_TARGET} records ciblés. Prêt pour --apply.`);
  }
}

function renderDryRunMd(p) {
  const md = [];
  md.push("# Backfill J2-C — expiration = selectedExpiration (DRY-RUN)");
  md.push("");
  md.push(`> **Aucune mutation** — généré le ${p.generatedAt.slice(0, 19)}`);
  md.push(`> DB : \`${p.dbPath}\` · ${p.countsBefore.recordCount} records`);
  md.push("");
  md.push("## Résumé");
  md.push("");
  md.push("| Métrique | Valeur |");
  md.push("| --- | --- |");
  md.push(`| totalMismatch | **${p.totalMismatch}** (attendu ${p.expectedTarget}) |`);
  md.push(`| Conforme à l'attendu | ${p.countMatchesExpected ? "✅ oui" : "❌ NON"} |`);
  md.push(`| resolvedMismatch | ${p.resolvedMismatch} |`);
  md.push(`| pendingMismatch | ${p.pendingMismatch} |`);
  md.push(`| Tickers affectés | ${Object.keys(p.distribution.byTicker).length} |`);
  md.push("");
  md.push("## Distribution par ticker");
  md.push("");
  md.push(Object.entries(p.distribution.byTicker).map(([k, v]) => `- ${k} : ${v}`).join("\n"));
  md.push("");
  md.push("## Distribution par captureClass");
  md.push("");
  md.push(Object.entries(p.distribution.byCaptureClass).map(([k, v]) => `- ${k} : ${v}`).join("\n"));
  md.push("");
  md.push("## Distribution par scanDate");
  md.push("");
  md.push(Object.entries(p.distribution.byScanDate).map(([k, v]) => `- ${k} : ${v}`).join("\n"));
  md.push("");
  md.push("## Exemples focus");
  md.push("");
  for (const t of FOCUS_TICKERS) {
    const rows = p.focusExamples[t] ?? [];
    md.push(`### ${t} (${rows.length})`);
    if (rows.length === 0) {
      md.push("- _aucun_");
    } else {
      for (const r of rows) {
        md.push(
          `- \`${r.expiration}\` → \`${r.selectedExpiration}\` · ${r.strikeMode} · scan ${r.scanDate} · ${r.captureClass} · résolu=${r.resolved} assigné=${r.assigned}`,
        );
      }
    }
    md.push("");
  }
  md.push("## Mutation planifiée (NON appliquée)");
  md.push("");
  md.push(`- ${p.plannedMutation.action}`);
  md.push(`- Ne touche pas : ${p.plannedMutation.doesNotTouch.join(", ")}`);
  md.push("");
  return md.join("\n");
}

// ── MODE APPLY ───────────────────────────────────────────────────────────────
async function runApply() {
  // 1. Charger l'état AVANT (source faisant foi = rawJson via store.load)
  const { dbPath, records: recordsBefore } = await loadRecords();
  const mismatchBefore = recordsBefore.filter(isMismatchRecord);
  const countsBefore = summarizeCounts(recordsBefore);
  const distributionBefore = buildDistribution(mismatchBefore);

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  BACKFILL J2-C — APPLY");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  DB                : ${dbPath}`);
  console.log(`  Records total     : ${countsBefore.recordCount}`);
  console.log(`  totalMismatch     : ${mismatchBefore.length} (attendu ${EXPECTED_TARGET})`);

  // 2. Garde-fou : cible doit être exactement 142
  if (mismatchBefore.length !== EXPECTED_TARGET) {
    console.error(
      `❌ ARRÊT : nombre ciblé ${mismatchBefore.length} ≠ ${EXPECTED_TARGET} attendu. Aucune mutation.`,
    );
    process.exitCode = 2;
    return;
  }

  // 3. Snapshot AVANT par id (pour vérifier qu'on ne touche QUE expiration)
  const beforeById = new Map();
  for (const r of recordsBefore) {
    beforeById.set(r.id, {
      selectedExpiration: r?.selectedExpiration ?? null,
      expiration: r?.expiration ?? null,
      resolutionJson: JSON.stringify(r?.resolution ?? null),
      resolved: getResolvedFlag(r),
      assigned: getAssignedFlag(r),
    });
  }

  // 4. Backup AVANT mutation (si échec → arrêt). Copie .sqlite + sidecars -wal/-shm.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(
    BACKUP_DIR,
    `wheelValidationJournal-before-j2-expiration-backfill-${ts()}.sqlite`,
  );
  try {
    fs.copyFileSync(dbPath, backupPath);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, backupPath + ext);
    }
    const sz = fs.statSync(backupPath).size;
    console.log(`  Backup créé       : ${backupPath} (${sz} octets)`);
    if (sz <= 0) throw new Error("backup vide");
  } catch (err) {
    console.error(`❌ ARRÊT : échec de la sauvegarde — ${err?.message ?? err}. Aucune mutation.`);
    process.exitCode = 3;
    return;
  }

  // 5. Mutation ciblée : connexion d'écriture directe, transaction atomique.
  const targetIds = mismatchBefore.map((r) => r.id);
  const conn = new DatabaseSync(dbPath);
  const nowIso = new Date().toISOString();
  let mutated = 0;
  const mutations = [];
  try {
    const selectStmt = conn.prepare(
      "SELECT id, expiration, selectedExpiration, rawJson FROM wheel_validation_records WHERE id = @id",
    );
    const updateStmt = conn.prepare(
      "UPDATE wheel_validation_records SET expiration = @expiration, rawJson = @rawJson, updatedAt = @updatedAt " +
        "WHERE id = @id AND selectedExpiration IS NOT NULL AND expiration IS NOT NULL AND expiration != selectedExpiration",
    );
    conn.exec("BEGIN");
    for (const id of targetIds) {
      const row = selectStmt.get({ id });
      if (!row) throw new Error(`record introuvable en base : ${id}`);
      const sel = row.selectedExpiration;
      if (sel == null || row.expiration == null) {
        throw new Error(`record sans expiration/selectedExpiration : ${id}`);
      }
      if (normCompact(row.expiration) === normCompact(sel)) {
        throw new Error(`record n'est plus en mismatch (incohérence) : ${id}`);
      }
      // Modifier rawJson de façon minimale : seul le champ expiration change.
      const parsed = JSON.parse(String(row.rawJson ?? "{}"));
      parsed.expiration = sel;
      const newRaw = JSON.stringify(parsed);
      const res = updateStmt.run({
        id,
        expiration: sel,
        rawJson: newRaw,
        updatedAt: nowIso,
      });
      const changes = Number(res?.changes ?? 0);
      if (changes !== 1) throw new Error(`UPDATE inattendu (changes=${changes}) pour ${id}`);
      mutated += 1;
      mutations.push({ id, from: row.expiration, to: sel });
    }
    if (mutated !== EXPECTED_TARGET) {
      throw new Error(`mutations=${mutated} ≠ ${EXPECTED_TARGET} — rollback`);
    }
    conn.exec("COMMIT");
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch (_) {
      /* preserve original error */
    }
    conn.close();
    console.error(`❌ ARRÊT : mutation échouée — ${err?.message ?? err}. Rollback effectué.`);
    process.exitCode = 4;
    return;
  }
  conn.close();
  console.log(`  Records backfillés : ${mutated}`);

  // 6. Validation APRÈS (rechargement frais via une nouvelle instance de store)
  const { records: recordsAfter } = await loadRecords();
  const mismatchAfter = recordsAfter.filter(isMismatchRecord);
  const countsAfter = summarizeCounts(recordsAfter);

  // Comparaison par id : seul expiration a changé ; rien d'autre.
  const integrityViolations = [];
  for (const r of recordsAfter) {
    const b = beforeById.get(r.id);
    if (!b) continue; // record non présent avant (impossible ici, mais sûr)
    if ((r?.selectedExpiration ?? null) !== b.selectedExpiration) {
      integrityViolations.push({ id: r.id, field: "selectedExpiration", before: b.selectedExpiration, after: r?.selectedExpiration ?? null });
    }
    if (JSON.stringify(r?.resolution ?? null) !== b.resolutionJson) {
      integrityViolations.push({ id: r.id, field: "resolution", before: b.resolutionJson, after: JSON.stringify(r?.resolution ?? null) });
    }
  }
  const emptiedSelected = recordsAfter.filter(
    (r) => beforeById.has(r.id) && beforeById.get(r.id).selectedExpiration != null && (r?.selectedExpiration ?? null) == null,
  ).length;

  const validation = {
    totalMismatchAfter: mismatchAfter.length,
    recordCountUnchanged: countsAfter.recordCount === countsBefore.recordCount,
    resolvedCountUnchanged: countsAfter.resolvedCount === countsBefore.resolvedCount,
    assignedCountUnchanged: countsAfter.assignedCount === countsBefore.assignedCount,
    pendingCountUnchanged: countsAfter.pendingCount === countsBefore.pendingCount,
    noSelectedEmptied: emptiedSelected === 0,
    noResolutionModified: integrityViolations.filter((v) => v.field === "resolution").length === 0,
    integrityViolations,
  };
  const success =
    validation.totalMismatchAfter === 0 &&
    validation.recordCountUnchanged &&
    validation.resolvedCountUnchanged &&
    validation.assignedCountUnchanged &&
    validation.pendingCountUnchanged &&
    validation.noSelectedEmptied &&
    validation.noResolutionModified &&
    integrityViolations.length === 0;

  const payload = {
    generatedAt: new Date().toISOString(),
    phase: "Journal POP J2-C — backfill expiration = selectedExpiration (APPLY)",
    mode: "apply",
    mutated: true,
    success,
    dbPath,
    backupPath,
    expectedTarget: EXPECTED_TARGET,
    recordsBackfilled: mutated,
    before: { counts: countsBefore, distribution: distributionBefore },
    after: { counts: countsAfter, totalMismatch: mismatchAfter.length },
    validation,
    mutations,
  };

  fs.writeFileSync(OUT_APPLY_JSON, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(OUT_APPLY_MD, renderApplyMd(payload), "utf8");

  console.log("");
  console.log("  ── Validation post-apply ──");
  console.log(`  totalMismatchAfter : ${validation.totalMismatchAfter} (attendu 0)`);
  console.log(`  recordCount        : ${countsBefore.recordCount} → ${countsAfter.recordCount} (${validation.recordCountUnchanged ? "inchangé" : "CHANGÉ"})`);
  console.log(`  resolvedCount      : ${countsBefore.resolvedCount} → ${countsAfter.resolvedCount} (${validation.resolvedCountUnchanged ? "inchangé" : "CHANGÉ"})`);
  console.log(`  assignedCount      : ${countsBefore.assignedCount} → ${countsAfter.assignedCount} (${validation.assignedCountUnchanged ? "inchangé" : "CHANGÉ"})`);
  console.log(`  pendingCount       : ${countsBefore.pendingCount} → ${countsAfter.pendingCount} (${validation.pendingCountUnchanged ? "inchangé" : "CHANGÉ"})`);
  console.log(`  selectedExp vidés  : ${emptiedSelected}`);
  console.log(`  resolution modif.  : ${validation.noResolutionModified ? "0" : "DÉTECTÉ"}`);
  console.log(`  violations intégrité: ${integrityViolations.length}`);
  console.log("");
  console.log(`  JSON : ${OUT_APPLY_JSON}`);
  console.log(`  MD   : ${OUT_APPLY_MD}`);
  console.log("");

  if (success) {
    console.log("✅ APPLY RÉUSSI : 142 records backfillés, mismatch=0, counts inchangés.");
  } else {
    console.error("❌ APPLY ÉCHEC : voir validation ci-dessus / JSON. Backup disponible :");
    console.error(`   ${backupPath}`);
    process.exitCode = 5;
  }
}

function renderApplyMd(p) {
  const v = p.validation;
  const md = [];
  md.push("# Backfill J2-C — expiration = selectedExpiration (APPLY)");
  md.push("");
  md.push(`> Généré le ${p.generatedAt.slice(0, 19)} · ${p.success ? "✅ SUCCÈS" : "❌ ÉCHEC"}`);
  md.push(`> DB : \`${p.dbPath}\``);
  md.push(`> Backup : \`${p.backupPath}\``);
  md.push("");
  md.push("## Résultat");
  md.push("");
  md.push("| Métrique | Avant | Après |");
  md.push("| --- | --- | --- |");
  md.push(`| recordCount | ${p.before.counts.recordCount} | ${p.after.counts.recordCount} |`);
  md.push(`| totalMismatch | ${p.before.distribution.totalMismatch} | ${p.after.totalMismatch} |`);
  md.push(`| resolvedCount | ${p.before.counts.resolvedCount} | ${p.after.counts.resolvedCount} |`);
  md.push(`| assignedCount | ${p.before.counts.assignedCount} | ${p.after.counts.assignedCount} |`);
  md.push(`| pendingCount | ${p.before.counts.pendingCount} | ${p.after.counts.pendingCount} |`);
  md.push("");
  md.push(`**Records backfillés : ${p.recordsBackfilled}**`);
  md.push("");
  md.push("## Validation");
  md.push("");
  md.push("| Contrôle | Résultat |");
  md.push("| --- | --- |");
  md.push(`| totalMismatchAfter = 0 | ${v.totalMismatchAfter === 0 ? "✅" : "❌"} (${v.totalMismatchAfter}) |`);
  md.push(`| recordCount inchangé | ${v.recordCountUnchanged ? "✅" : "❌"} |`);
  md.push(`| resolvedCount inchangé | ${v.resolvedCountUnchanged ? "✅" : "❌"} |`);
  md.push(`| assignedCount inchangé | ${v.assignedCountUnchanged ? "✅" : "❌"} |`);
  md.push(`| pendingCount inchangé | ${v.pendingCountUnchanged ? "✅" : "❌"} |`);
  md.push(`| aucun selectedExpiration vidé | ${v.noSelectedEmptied ? "✅" : "❌"} |`);
  md.push(`| aucune resolution modifiée | ${v.noResolutionModified ? "✅" : "❌"} |`);
  md.push(`| violations d'intégrité | ${v.integrityViolations.length === 0 ? "✅ 0" : `❌ ${v.integrityViolations.length}`} |`);
  md.push("");
  md.push("## Focus tickers (count total, inchangé)");
  md.push("");
  md.push("| Ticker | Avant | Après |");
  md.push("| --- | --- | --- |");
  for (const t of FOCUS_TICKERS) {
    md.push(`| ${t} | ${p.before.counts.byFocusTicker[t]} | ${p.after.counts.byFocusTicker[t]} |`);
  }
  md.push("");
  return md.join("\n");
}

// ── entrée ───────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const isApply = args.has("--apply");
const isDryRun = args.has("--dry-run");

if (isApply && isDryRun) {
  console.error("❌ Choisir un seul mode : --dry-run OU --apply.");
  process.exit(1);
}

if (isApply) {
  await runApply();
} else if (isDryRun) {
  await runDryRun();
} else {
  console.error("Usage : node debug/journal-pop-j2-expiration-backfill.mjs --dry-run | --apply");
  console.error("(--apply est requis pour toute mutation ; le dry-run ne modifie rien.)");
  process.exit(1);
}
