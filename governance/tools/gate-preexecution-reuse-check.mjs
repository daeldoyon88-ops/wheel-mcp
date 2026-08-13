#!/usr/bin/env node
/**
 * GATE_PREEXECUTION_REUSE_CHECK — run this before authorizing any future Gate.
 *
 * WHAT THIS EXISTS TO PREVENT. Work is produced, ratified, and then forgotten,
 * so the next Gate rediscovers it from scratch. Every check below is therefore
 * either "does the canonical machinery this Gate will need already exist and
 * actually run", or "has the prior research for this Gate already been done and
 * can it still be resolved from its declared source".
 *
 * NO HARDCODED PASS. Every verdict is recomputed from real bytes on every run.
 * Nothing is read out of a status field. The GEE admission probes do not assert
 * that GEE is live — they execute R2, R3, R4 and R5 against a real work unit and
 * report what actually happened.
 *
 * WHAT THESE PROBES DO AND DO NOT PROVE. They answer "do the engines run against
 * this repository right now", which is an ADMISSION question. They do NOT prove
 * that the Gate lifecycle runs THROUGH those engines — a probe in a corner is
 * not a consumer. That second question belongs to
 * governance/tools/gate-fast-path-control-plane.mjs, which compiles the real
 * R2→R3→R4→R5 chain for a specific Gate and binds each layer's output to the
 * next layer's input. This file therefore checks that the consumer EXISTS
 * (GEE_LIFECYCLE_CONSUMER_EXISTS) and stops there; it deliberately makes no
 * claim about lifecycle consumption on its own.
 *
 * THE DISTINCTION THAT MATTERS. A future Gate legitimately has no execution
 * contract, no state revision and no START authority before it starts. That is
 * NOT a gap. A gap is when the *mechanism* to produce one does not exist. Every
 * finding is therefore classified:
 *
 *   GATE_LOCAL_EXPECTED  — normal for a not-yet-started Gate; not a gap.
 *   PREEXECUTION_GAP     — this Gate cannot start until someone fixes it.
 *   SYSTEMIC_GAP         — the generic lifecycle itself is broken.
 *
 * FAIL CLOSED. Unknown gate, unreadable canonical source, or any unclassified
 * error is BLOCKED. Absence of evidence is never treated as evidence.
 *
 * Local, offline, deterministic. Reads the repository; writes nothing inside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkExistingWorkIndex } from './governance-existing-work-index.mjs';
import { establishComparability } from './regression-identity-delta.mjs';

export const CHECK_DOCUMENT = 'GATE_PREEXECUTION_REUSE_CHECK';
export const CHECK_VERSION = 'V1';

const GATE_RE = /^GATE[0-9]{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CLOSED_STATUSES = new Set(['COMPLETE_CONFIRMED', 'SUPERSEDED']);

const NONE = 'NONE';
const GATE_LOCAL_EXPECTED = 'GATE_LOCAL_EXPECTED';
const PREEXECUTION_GAP = 'PREEXECUTION_GAP';
const SYSTEMIC_GAP = 'SYSTEMIC_GAP';

const REGISTRY_PATH = 'governance/GATE_REGISTRY_00_40.json';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const GAP_REGISTER_PATH = 'governance/master-matrix/MASTER_GAP_REGISTER_V1.json';
const REGRESSION_BASELINE_PATH = 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json';

/** Primitive modules the generic Gate lifecycle is made of. Absence is SYSTEMIC. */
const LIFECYCLE_PRIMITIVES = Object.freeze({
  AUTHORITY_PRIMITIVE_EXISTS: [
    'governance/gee-v1/core/gate-authorization-authority.mjs',
    'governance/tools/validate-gate-authorization-authority.mjs'
  ],
  START_PRIMITIVE_EXISTS: [
    'governance/gee-v1/core/gate-start-authority.mjs',
    'governance/tools/validate-gate-authorization-authority.mjs'
  ],
  STATE_PRIMITIVE_EXISTS: [
    'governance/gee-v1/core/state-revision-resolver.mjs',
    'governance/tools/validate-state-revision.mjs',
    'governance/tools/validate-state-seal.mjs'
  ],
  CLOSURE_PRIMITIVE_EXISTS: [
    'governance/gee-v1/core/post-freeze-maintenance-authority.mjs',
    'governance/tools/validate-post-freeze-maintenance-authority.mjs'
  ],
  CONTRACT_SUCCESSION_PRIMITIVE_EXISTS: [
    'governance/gee-v1/core/gate-contract-succession-authority.mjs',
    'governance/tools/validate-gate-contract-succession-authority.mjs'
  ],
  EVIDENCE_MODEL_EXISTS: [
    'governance/gee-v1/evidence/evidence-graph.mjs',
    'governance/gee-v1/cas/content-addressed-store.mjs'
  ]
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readText(root, relativePath) {
  return fs.readFileSync(path.resolve(root, ...relativePath.split('/')), 'utf8').replace(/^﻿/, '');
}

function readJson(root, relativePath) {
  return JSON.parse(readText(root, relativePath));
}

function exists(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

function check(id, status, gapClass, message, detail = null) {
  return detail === null ? { id, status, class: gapClass, message } : { id, status, class: gapClass, message, detail };
}

/**
 * Resolve the highest-numbered CLOSED gate whose sealed state actually verifies.
 *
 * Deliberately computed, never hardcoded: this is the work unit the GEE liveness
 * probes run against, and pinning it to a literal gate id is exactly how the R7
 * fixtures ended up frozen against a gate whose seal later stopped verifying.
 */
export function resolveGeeReferenceWorkUnit({ root, session }) {
  const events = readText(root, LEDGER_PATH).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const latestByGate = new Map();
  for (const event of events) if (GATE_RE.test(event.gateId || '')) latestByGate.set(event.gateId, event);
  const candidates = [...latestByGate.entries()]
    .filter(([, event]) => CLOSED_STATUSES.has(event.toStatus))
    .map(([gateId]) => gateId)
    .sort()
    .reverse();
  for (const gateId of candidates) {
    try {
      const view = session.getWorkUnit(gateId);
      if (view?.authorityState?.sealValid === true) return { workUnitId: gateId, candidates };
    } catch { /* a view that cannot be built is not a usable reference */ }
  }
  return { workUnitId: null, candidates };
}

export async function runPreexecutionReuseCheck({ root, gateId, now = new Date() } = {}) {
  const checks = [];
  const errors = [];
  const reuse = { priorResearchSources: [], unresolvedSources: [], geeReferenceWorkUnit: null };

  if (!GATE_RE.test(gateId || '')) {
    return {
      document: CHECK_DOCUMENT,
      version: CHECK_VERSION,
      verdict: 'BLOCKED',
      gateId: gateId ?? null,
      checks: [check('GATE_ID', 'FAIL', SYSTEMIC_GAP, 'Gate id must match GATE\\d{2}.')],
      errors: ['GATE_ID_INVALID'],
      reuse,
      counts: { pass: 0, fail: 1, gateLocalExpected: 0, preexecutionGaps: 0, systemicGaps: 1 },
      generatedAt: now.toISOString()
    };
  }

  let registry = null;
  let gate = null;
  try {
    registry = readJson(root, REGISTRY_PATH);
    gate = (registry.gates || []).find((entry) => entry.gateId === gateId) ?? null;
  } catch (error) {
    errors.push(`REGISTRY_UNREADABLE:${error.message}`);
  }

  // ---- 1. MANDATE_CANONICAL ------------------------------------------------
  if (!gate) {
    checks.push(check('MANDATE_CANONICAL', 'FAIL', PREEXECUTION_GAP, 'Gate is absent from the canonical registry.'));
  } else {
    const objectiveOk = typeof gate.canonicalObjective === 'string' && gate.canonicalObjective.trim().length > 0;
    const completeOk = gate.definitionCompleteness === 'EXPLICIT_COMPLETE';
    const missingOk = Array.isArray(gate.missingCanonicalFields) && gate.missingCanonicalFields.length === 0;
    const sourcedOk = Array.isArray(gate.sourceReferences) && gate.sourceReferences.length > 0;
    const ok = objectiveOk && completeOk && missingOk && sourcedOk;
    checks.push(check(
      'MANDATE_CANONICAL', ok ? 'PASS' : 'FAIL', ok ? NONE : PREEXECUTION_GAP,
      ok ? 'Canonical mandate is complete and sourced.' : 'Canonical mandate is incomplete.',
      { objectiveOk, completeOk, missingOk, sourcedOk, missingCanonicalFields: gate.missingCanonicalFields ?? null }
    ));
  }

  // ---- 2. PRIOR_RESEARCH_SEARCHED / PRIOR_RESEARCH_REUSED ------------------
  // The anti-amnesia check. Every source the registry says this Gate's mandate
  // came from must still resolve, and where a digest was pinned it must still
  // agree with the live bytes.
  const sourceRefs = Array.isArray(gate?.sourceReferences) ? gate.sourceReferences : [];
  const withPaths = sourceRefs.filter((ref) => typeof ref.sourcePath === 'string' && ref.sourcePath);
  const seenPaths = [...new Set(withPaths.map((ref) => ref.sourcePath))];
  for (const sourcePath of seenPaths) {
    if (!exists(root, sourcePath)) {
      reuse.unresolvedSources.push({ sourcePath, reason: 'ABSENT' });
      continue;
    }
    const bytes = fs.readFileSync(path.resolve(root, ...sourcePath.split('/')));
    const pinned = withPaths.find((ref) => ref.sourcePath === sourcePath && SHA256_RE.test(ref.sourceSha256 || ''));
    const liveSha = sha256(bytes);
    if (pinned && pinned.sourceSha256 !== liveSha) {
      reuse.unresolvedSources.push({ sourcePath, reason: 'DIGEST_DRIFT', pinned: pinned.sourceSha256, live: liveSha });
      continue;
    }
    reuse.priorResearchSources.push({ sourcePath, sha256: liveSha, byteLength: bytes.length, digestPinned: Boolean(pinned) });
  }
  checks.push(check(
    'PRIOR_RESEARCH_SEARCHED', seenPaths.length > 0 ? 'PASS' : 'FAIL',
    seenPaths.length > 0 ? NONE : PREEXECUTION_GAP,
    seenPaths.length > 0 ? 'Mandate names its prior-research sources.' : 'Mandate names no resolvable prior-research source.',
    { declaredSourcePaths: seenPaths.length }
  ));
  const reuseOk = seenPaths.length > 0 && reuse.unresolvedSources.length === 0;
  checks.push(check(
    'PRIOR_RESEARCH_REUSED', reuseOk ? 'PASS' : 'FAIL', reuseOk ? NONE : PREEXECUTION_GAP,
    reuseOk ? 'Every declared prior-research source resolves and its pinned digest still agrees.'
      : 'A declared prior-research source is missing or has drifted; the Gate would rediscover it.',
    { resolved: reuse.priorResearchSources.length, unresolved: reuse.unresolvedSources }
  ));

  // ---- 3. DEPENDENCIES -----------------------------------------------------
  let ledgerStatuses = new Map();
  try {
    const events = readText(root, LEDGER_PATH).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    for (const event of events) if (GATE_RE.test(event.gateId || '')) ledgerStatuses.set(event.gateId, event.toStatus);
  } catch (error) {
    errors.push(`LEDGER_UNREADABLE:${error.message}`);
  }
  const dependencies = Array.isArray(gate?.dependencies) ? gate.dependencies : [];
  const isGenesisGate = gateId === 'GATE00';
  const declaredOk = isGenesisGate || dependencies.length > 0;
  checks.push(check(
    'DEPENDENCIES_DECLARED', declaredOk ? 'PASS' : 'FAIL', declaredOk ? NONE : PREEXECUTION_GAP,
    declaredOk ? 'Dependencies are declared.' : 'No dependency is declared.', { dependencies }
  ));
  const unsatisfied = dependencies.filter((dependency) => !CLOSED_STATUSES.has(ledgerStatuses.get(dependency)));
  const satisfiable = unsatisfied.length === 0;
  checks.push(check(
    'DEPENDENCIES_SATISFIABLE', satisfiable ? 'PASS' : 'FAIL',
    satisfiable ? NONE : GATE_LOCAL_EXPECTED,
    satisfiable ? 'Every dependency is closed in the canonical ledger.'
      : 'A dependency is not yet closed; this Gate is not next in sequence.',
    { unsatisfied: unsatisfied.map((dependency) => ({ gateId: dependency, status: ledgerStatuses.get(dependency) ?? 'ABSENT' })) }
  ));

  // ---- 4. ENTRY_CONDITIONS_DEFINED ----------------------------------------
  const entryOk = Array.isArray(gate?.entryConditions) && gate.entryConditions.length > 0;
  checks.push(check('ENTRY_CONDITIONS_DEFINED', entryOk ? 'PASS' : 'FAIL', entryOk ? NONE : PREEXECUTION_GAP,
    entryOk ? 'Entry conditions are declared.' : 'Entry conditions are absent.',
    { entryConditionCount: gate?.entryConditions?.length ?? 0 }));

  // ---- 5. CONTRACT_DERIVABLE / VALIDATORS_DERIVABLE ------------------------
  // Derivable, not present. A future Gate has no contract yet, and must not.
  const outputsOk = Array.isArray(gate?.expectedOutputs) && gate.expectedOutputs.length > 0;
  const exitOk = Array.isArray(gate?.exitConditions) && gate.exitConditions.length > 0;
  const mandateDocs = reuse.priorResearchSources
    .filter((entry) => entry.sourcePath.endsWith('.json'))
    .map((entry) => { try { return { sourcePath: entry.sourcePath, json: readJson(root, entry.sourcePath) }; } catch { return null; } })
    .filter(Boolean);
  const mandateFor = (field) => mandateDocs.some((doc) => {
    const direct = doc.json?.[field];
    if (Array.isArray(direct) && direct.length > 0) return true;
    const projected = Array.isArray(doc.json?.gates) ? doc.json.gates.find((entry) => entry.gateId === gateId) : null;
    return Array.isArray(projected?.[field]) && projected[field].length > 0;
  });
  const contractDerivable = (outputsOk && exitOk) || mandateFor('requiredArtifacts') || mandateFor('closureConditions');
  checks.push(check('CONTRACT_DERIVABLE', contractDerivable ? 'PASS' : 'FAIL', contractDerivable ? NONE : PREEXECUTION_GAP,
    contractDerivable ? 'An execution contract can be derived from canonical sources without new research.'
      : 'Nothing canonical declares required outputs or closure conditions for this Gate.',
    { registryExpectedOutputs: outputsOk, registryExitConditions: exitOk, mandateRequiredArtifacts: mandateFor('requiredArtifacts'), mandateClosureConditions: mandateFor('closureConditions') }));
  const validatorsDerivable = mandateFor('validators') || mandateFor('negativeTests') || outputsOk;
  checks.push(check('VALIDATORS_DERIVABLE', validatorsDerivable ? 'PASS' : 'FAIL', validatorsDerivable ? NONE : PREEXECUTION_GAP,
    validatorsDerivable ? 'Validators and tests are derivable from canonical sources.' : 'No canonical source declares validators or tests.'));

  // ---- 6. LIFECYCLE PRIMITIVES --------------------------------------------
  for (const [id, modules] of Object.entries(LIFECYCLE_PRIMITIVES)) {
    const missing = modules.filter((modulePath) => !exists(root, modulePath));
    checks.push(check(id, missing.length === 0 ? 'PASS' : 'FAIL', missing.length === 0 ? NONE : SYSTEMIC_GAP,
      missing.length === 0 ? 'Primitive is present.' : 'Primitive module is absent.', { missing }));
  }

  // ---- 7. INDEPENDENCE_PATH_EXISTS ----------------------------------------
  // Independent reinspection is a governance boundary, not a module: what must
  // exist is the authority purpose that admits it plus at least one precedent.
  let independenceOk = false;
  let independenceDetail = {};
  try {
    const purposes = readText(root, 'governance/gee-v1/core/post-freeze-maintenance-authority.mjs');
    const hasExternalPurpose = purposes.includes("'GATE_EXTERNAL_CONFIRMATION'");
    const hasClosurePurpose = purposes.includes("'GATE_FINAL_CLOSURE'");
    const sourcesDir = path.resolve(root, 'governance', 'sources');
    const precedents = fs.existsSync(sourcesDir)
      ? fs.readdirSync(sourcesDir).filter((entry) => entry.includes('EXTERNAL_REINSPECTION_REPORT'))
      : [];
    independenceOk = hasExternalPurpose && hasClosurePurpose && precedents.length > 0;
    independenceDetail = { hasExternalPurpose, hasClosurePurpose, precedentReports: precedents.length };
  } catch (error) {
    errors.push(`INDEPENDENCE_PATH_UNREADABLE:${error.message}`);
  }
  checks.push(check('INDEPENDENCE_PATH_EXISTS', independenceOk ? 'PASS' : 'FAIL', independenceOk ? NONE : SYSTEMIC_GAP,
    independenceOk ? 'External confirmation authority purpose and a reinspection precedent both exist.'
      : 'No usable independent-reinspection path.', independenceDetail));

  // ---- 8. GEE ADMISSION PROBES — executed, never asserted -----------------
  // These four checks import the real engines and run them against a real,
  // currently-verifiable work unit. They establish that the machinery RUNS.
  // They are not the lifecycle consumer; see GEE_LIFECYCLE_CONSUMER_EXISTS.
  const geeIds = ['GEE_CONTEXT_LIVE', 'GEE_DELTA_LIVE', 'GEE_EVIDENCE_REUSE_LIVE', 'GEE_MIN_FRONTIER_LIVE'];
  let geeResults = null;
  try {
    geeResults = await probeGeeLiveness({ root });
    reuse.geeReferenceWorkUnit = geeResults.workUnitId;
    checks.push(check('GEE_CONTEXT_LIVE', geeResults.r2.ok ? 'PASS' : 'FAIL', geeResults.r2.ok ? NONE : SYSTEMIC_GAP,
      geeResults.r2.ok ? 'R2 compiled a real context.' : 'R2 context compiler did not run.', geeResults.r2));
    checks.push(check('GEE_DELTA_LIVE', geeResults.r3.ok ? 'PASS' : 'FAIL', geeResults.r3.ok ? NONE : SYSTEMIC_GAP,
      geeResults.r3.ok ? 'R3 produced a real delta snapshot.' : 'R3 delta engine did not run.', geeResults.r3));
    checks.push(check('GEE_EVIDENCE_REUSE_LIVE', geeResults.r4.ok ? 'PASS' : 'FAIL', geeResults.r4.ok ? NONE : SYSTEMIC_GAP,
      geeResults.r4.ok ? 'R4 built a real evidence graph.' : 'R4 evidence graph did not run.', geeResults.r4));
    checks.push(check('GEE_MIN_FRONTIER_LIVE', geeResults.r5.ok ? 'PASS' : 'FAIL', geeResults.r5.ok ? NONE : SYSTEMIC_GAP,
      geeResults.r5.ok ? 'R5 produced a real route plan — the minimum evidence frontier is computable.'
        : 'R5 router did not run.', geeResults.r5));
  } catch (error) {
    errors.push(`GEE_PROBE_FAILED:${error.message}`);
    for (const id of geeIds) checks.push(check(id, 'FAIL', SYSTEMIC_GAP, 'GEE probe could not be executed.', { error: error.message }));
  }

  // ---- 9. REGRESSION_BASELINE_KNOWN ---------------------------------------
  // Self-consistency is necessary and not sufficient. A baseline that agrees
  // with itself can still be uncomparable to the current suite — for instance
  // when a file it names has been deleted, in which case that test's absence
  // from a current run would look like a repair rather than a removal. What is
  // required is COMPARABILITY, and it is established rather than assumed.
  //
  // Note what is deliberately NOT required: baseHead === current HEAD. A
  // governed baseline legitimately spans later commits, and demanding equality
  // would force a mechanical regeneration that empties the baseline of meaning.
  let baselineOk = false;
  let baselineDetail = {};
  try {
    if (exists(root, REGRESSION_BASELINE_PATH)) {
      const baseline = readJson(root, REGRESSION_BASELINE_PATH);
      const comparability = establishComparability({
        baseline,
        current: { head: null, suiteSpec: { command: baseline?.suiteSpec?.command ?? null }, failureIdentities: [] },
        root
      });
      baselineOk = comparability.comparable && typeof baseline.baseHead === 'string';
      baselineDetail = {
        failureIdentityCount: baseline.failureIdentityCount,
        declaredIdentities: Array.isArray(baseline.failureIdentities) ? baseline.failureIdentities.length : null,
        baseHead: baseline.baseHead,
        comparisonRule: baseline.comparisonRule ?? null,
        comparable: comparability.comparable,
        comparabilityReasons: comparability.reasons,
        unresolvableBaselineFiles: comparability.unresolvableBaselineFiles,
        headEqualityRequired: false
      };
    } else {
      baselineDetail = { present: false };
    }
  } catch (error) {
    errors.push(`REGRESSION_BASELINE_UNREADABLE:${error.message}`);
  }
  checks.push(check('REGRESSION_BASELINE_KNOWN', baselineOk ? 'PASS' : 'FAIL', baselineOk ? NONE : PREEXECUTION_GAP,
    baselineOk ? 'A failure-identity regression baseline exists and is comparable to a current run.'
      : 'No comparable regression baseline: new failures could not be told apart from pre-existing ones.', baselineDetail));

  // ---- 10. GIT_CONTAINMENT_AVAILABLE --------------------------------------
  // Unrelated dirty work is normal in this repository and must never be a
  // blocker. What must be true is that governed paths are separable.
  let gitDetail = {};
  let gitOk = false;
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = porcelain.split(/\r?\n/).filter((line) => line.trim());
    const governanceDirty = lines.filter((line) => line.slice(3).startsWith('governance/'));
    gitDetail = { totalDirtyPaths: lines.length, governanceDirtyPaths: governanceDirty.length, unrelatedDirtyPaths: lines.length - governanceDirty.length };
    gitOk = true;
  } catch (error) {
    errors.push(`GIT_UNAVAILABLE:${error.message}`);
  }
  checks.push(check('GIT_CONTAINMENT_AVAILABLE', gitOk ? 'PASS' : 'FAIL', gitOk ? NONE : SYSTEMIC_GAP,
    gitOk ? 'Exact-cohort staging is available; unrelated dirty work is separable and is not a blocker.'
      : 'Git state could not be read.', gitDetail));

  // ---- 11. UNKNOWN_PREWORK / SYSTEMIC_GAPS --------------------------------
  // Two different amnesias, and the first alone was never enough.
  //
  //   DECLARED, UNRESOLVABLE — the Gate cites prior work that no longer
  //     resolves. Detected by walking what the mandate references.
  //   UNDECLARED, UNCLASSIFIED — governed work exists that nothing cites and
  //     nobody dispositioned. Nothing in the citation graph can see it, because
  //     the whole problem is that it is not in the citation graph.
  //
  // The second is the one that actually causes rediscovery, so UNKNOWN_PREWORK
  // now fails on either.
  const unknownPrework = reuse.unresolvedSources.length;
  let unclassifiedRelevant = null;
  try {
    const indexReport = checkExistingWorkIndex({ root });
    unclassifiedRelevant = indexReport.unclassifiedRelevantArtifacts;
    reuse.existingWorkIndex = {
      verdict: indexReport.verdict,
      relevantArtifactCount: indexReport.relevantArtifactCount,
      classifiedCount: indexReport.classifiedCount,
      unclassifiedRelevantArtifactCount: indexReport.unclassifiedRelevantArtifactCount,
      indexStale: indexReport.indexFreshness.stale
    };
  } catch (error) {
    errors.push(`EXISTING_WORK_INDEX_UNREADABLE:${error.message}`);
  }
  const preworkOk = unknownPrework === 0 && Array.isArray(unclassifiedRelevant) && unclassifiedRelevant.length === 0;
  checks.push(check('UNKNOWN_PREWORK', preworkOk ? 'PASS' : 'FAIL', preworkOk ? NONE : PREEXECUTION_GAP,
    preworkOk ? 'No declared prior work is unaccounted for, and every relevant governed artifact carries a disposition.'
      : unknownPrework > 0 ? 'Declared prior work cannot be resolved.'
        : 'Relevant governed work exists with no disposition; it would be rediscovered.',
    { unknownPrework, unclassifiedRelevantArtifacts: unclassifiedRelevant ?? 'UNKNOWN' }));

  // ---- 11b. GEE_LIFECYCLE_CONSUMER_EXISTS ---------------------------------
  // The probes above prove the engines run. This proves a lifecycle consumer
  // exists to run them AS A CHAIN. It is checked by path rather than imported,
  // because the control plane imports this file and a cycle would be worse than
  // the weaker check.
  const consumerPath = 'governance/tools/gate-fast-path-control-plane.mjs';
  const consumerPresent = exists(root, consumerPath);
  checks.push(check('GEE_LIFECYCLE_CONSUMER_EXISTS', consumerPresent ? 'PASS' : 'FAIL', consumerPresent ? NONE : SYSTEMIC_GAP,
    consumerPresent ? 'A Gate lifecycle consumer of the R2-R5 chain exists.'
      : 'No lifecycle consumer: R2-R5 would only ever be probed, never consumed.',
    { consumerPath }));

  let openBlocking = null;
  try {
    if (exists(root, GAP_REGISTER_PATH)) {
      const register = readJson(root, GAP_REGISTER_PATH);
      const findings = Array.isArray(register.findings) ? register.findings : [];
      openBlocking = findings.filter((entry) => ['P0', 'P1'].includes(entry.severity) && entry.status === 'OPEN').length;
    }
  } catch (error) {
    errors.push(`GAP_REGISTER_UNREADABLE:${error.message}`);
  }
  checks.push(check('SYSTEMIC_GAPS', openBlocking === 0 ? 'PASS' : 'FAIL', openBlocking === 0 ? NONE : SYSTEMIC_GAP,
    openBlocking === 0 ? 'The master gap register carries no open P0/P1 finding.'
      : openBlocking === null ? 'The master gap register is absent; systemic state is unknown.'
        : 'The master gap register carries open P0/P1 findings.',
    { openP0P1: openBlocking }));

  const counts = {
    pass: checks.filter((entry) => entry.status === 'PASS').length,
    fail: checks.filter((entry) => entry.status === 'FAIL').length,
    gateLocalExpected: checks.filter((entry) => entry.class === GATE_LOCAL_EXPECTED).length,
    preexecutionGaps: checks.filter((entry) => entry.class === PREEXECUTION_GAP).length,
    systemicGaps: checks.filter((entry) => entry.class === SYSTEMIC_GAP).length
  };

  // A Gate is READY when nothing blocking remains. Failures classified
  // GATE_LOCAL_EXPECTED do not block readiness — they only mean this Gate is
  // not the next one in sequence, which is a scheduling fact, not a defect.
  const verdict = errors.length === 0 && counts.preexecutionGaps === 0 && counts.systemicGaps === 0
    ? (counts.gateLocalExpected === 0 ? 'READY' : 'READY_WHEN_SEQUENCED')
    : 'BLOCKED';

  return {
    document: CHECK_DOCUMENT,
    version: CHECK_VERSION,
    verdict,
    gateId,
    officialName: gate?.officialName ?? null,
    checks,
    errors,
    reuse,
    counts,
    generatedAt: now.toISOString()
  };
}

/**
 * Execute R2, R3, R4 and R5 for real.
 *
 * This is the live consumer the GEE layers otherwise lack. The reference work
 * unit is resolved, never hardcoded, and the content-addressed store is created
 * under the OS temp directory so nothing is written inside the repository.
 */
async function probeGeeLiveness({ root }) {
  const geeRoot = path.resolve(root, 'governance', 'gee-v1');
  const load = (relative) => import(new URL(`file://${path.resolve(geeRoot, relative).split(path.sep).join('/')}`).href);

  const [{ createWheelProjectAdapter }, { createProjectSession }] = await Promise.all([
    load('adapters/wheel/wheel-project-adapter.mjs'),
    load('core/work-unit-core.mjs')
  ]);
  const session = createProjectSession(createWheelProjectAdapter(root));
  const { workUnitId, candidates } = resolveGeeReferenceWorkUnit({ root, session });

  const out = {
    workUnitId,
    closedCandidates: candidates,
    r2: { ok: false, reason: 'NO_VERIFIABLE_REFERENCE_WORK_UNIT' },
    r3: { ok: false, reason: 'NO_VERIFIABLE_REFERENCE_WORK_UNIT' },
    r4: { ok: false, reason: 'NO_VERIFIABLE_REFERENCE_WORK_UNIT' },
    r5: { ok: false, reason: 'NO_VERIFIABLE_REFERENCE_WORK_UNIT' }
  };
  if (!workUnitId) return out;

  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const [
    { createWheelContextAdapter }, { compileContext }, { createWheelDeltaSnapshot },
    { createWheelEvidenceGraph, evaluateWheelEvidenceGraph }, { routeWheelWorkUnit }, { createContentAddressedStore }
  ] = await Promise.all([
    load('adapters/wheel/context-wheel-adapter.mjs'),
    load('context/compile-context.mjs'),
    load('adapters/wheel/delta-wheel-adapter.mjs'),
    load('adapters/wheel/evidence-wheel-adapter.mjs'),
    load('adapters/wheel/router-wheel-adapter.mjs'),
    load('cas/content-addressed-store.mjs')
  ]);

  let compiled = null;
  try {
    compiled = compileContext({ repoRoot: root, adapter: createWheelContextAdapter(root), workUnitId, sourceHead });
    out.r2 = {
      ok: true, workUnitId,
      sourceBytes: compiled.metrics.sourceBytes,
      compiledJsonBytes: compiled.metrics.compiledJsonBytes,
      reductionRatio: Number(compiled.metrics.reductionRatio.toFixed(3))
    };
  } catch (error) {
    out.r2 = { ok: false, workUnitId, reason: error.message };
    return out;
  }

  // The R3 delta produced here is the SAME object R4 is given below. An earlier
  // revision of this probe called R4 with `r3Delta: null`, which let R4 build a
  // graph without ever evaluating reuse against a delta — the probe went green
  // while proving nothing about the link between the two layers.
  let r3Delta = null;
  try {
    const snapshot = createWheelDeltaSnapshot({ repoRoot: root, context: compiled.json });
    r3Delta = { previousSnapshot: snapshot, currentSnapshot: snapshot };
    out.r3 = { ok: true, snapshotSha256: snapshot.snapshotSha256, factCount: Array.isArray(snapshot.facts) ? snapshot.facts.length : null };
  } catch (error) {
    out.r3 = { ok: false, reason: error.message };
  }

  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-preexec-cas-'));
  try {
    const cas = createContentAddressedStore(casRoot);
    try {
      // Fail closed rather than substituting null: without a real R3 delta there
      // is no R4 result worth reporting.
      if (!r3Delta) throw new Error('R3_DELTA_UNAVAILABLE_R4_NOT_PROBED');
      const graph = createWheelEvidenceGraph({ cas, context: compiled.json, repoRoot: root, r3Delta });
      const evaluated = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, previousGraph: null, r3Delta });
      out.r4 = {
        ok: true,
        graphSha256: graph.graphSha256,
        nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : null,
        consumedR3DeltaSha256: evaluated.graph.evaluation.r3DeltaSha256,
        reusableNodes: evaluated.metrics.REUSABLE_NODES,
        invalidatedNodes: evaluated.metrics.INVALIDATED_NODES
      };
    } catch (error) {
      out.r4 = { ok: false, reason: error.message };
    }
    try {
      const routed = routeWheelWorkUnit({ repoRoot: root, workUnitId, cas, sourceHead });
      out.r5 = { ok: true, taskCount: Array.isArray(routed.plan?.tasks) ? routed.plan.tasks.length : null };
    } catch (error) {
      out.r5 = { ok: false, reason: error.message };
    }
  } finally {
    fs.rmSync(casRoot, { recursive: true, force: true });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = await runPreexecutionReuseCheck({ root, gateId: option('--gate') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === 'BLOCKED' ? 2 : 0;
}
