#!/usr/bin/env node
/**
 * GOVERNANCE_EXISTING_WORK_INDEX — the anti-amnesia index.
 *
 * WHAT THIS EXISTS TO PREVENT. The preexecution check already answers "does
 * every source this Gate CITES still resolve?". That is necessary and not
 * sufficient: it can only see work somebody already remembered to reference. The
 * failure it cannot see is the opposite one — a ratification, decision pack or
 * reinspection report that was produced, filed under governance/, and then
 * referenced by nothing. Nobody rediscovers it, so the next Gate redoes it.
 *
 * This index therefore asks the inverse question: for every durable
 * decision-bearing artifact in the governed surface, what became of it?
 *
 * TWO KINDS OF ANSWER, AND THE DIFFERENCE MATTERS.
 *
 *   DERIVED_RULE — the disposition follows from where the artifact lives and
 *     whether anything links to it. Recomputed from bytes on every run, so it
 *     cannot rot.
 *   EXPLICIT — the derivation could not settle it, so a human decision is
 *     recorded in the index artifact. This is the only hand-maintained part, and
 *     it is deliberately small.
 *
 * An artifact with neither is UNCLASSIFIED, which is the condition that must
 * stay at zero. Absence of a disposition is never read as "probably fine".
 *
 * NOT A CLASSIFICATION REGISTRY. governance/historical-architecture/
 * ARTIFACT_CLASSIFICATION_REGISTRY.json answers a different question — what
 * counts as PROOF for an artifact (MODEL D class). This index links to it rather
 * than restating it, so there is one source of truth per question.
 *
 * BOUNDED BY DESIGN. Only the governed decision surfaces the master matrix
 * already identified are walked. Implementation code, schemas, tests and
 * generated projections are excluded by declared rule, not by omission.
 *
 * Local, offline, deterministic. Reads the repository; writes nothing inside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const INDEX_DOCUMENT = 'GOVERNANCE_EXISTING_WORK_INDEX';
export const INDEX_VERSION = 'V1';
export const INDEX_PATH = 'governance/master-matrix/GOVERNANCE_EXISTING_WORK_INDEX_V1.json';
export const CLASSIFICATION_REGISTRY_PATH = 'governance/historical-architecture/ARTIFACT_CLASSIFICATION_REGISTRY.json';

export const DISPOSITIONS = Object.freeze([
  'CANONICAL', 'CANONICAL_INPUT', 'CONSUMED', 'EVIDENCE_ONLY',
  'DERIVED', 'HISTORICAL_LEGACY', 'SUPERSEDED', 'PENDING_DECISION'
]);

/** The governed decision surface. Everything outside these roots is out of scope by declaration. */
export const RELEVANT_ROOTS = Object.freeze([
  'governance/sources',
  'governance/authority',
  'governance/historical-architecture',
  'governance/master-matrix',
  'governance/gee-v1/missions',
  'governance/implementation',
  'governance/active',
  'governance/gates'
]);

export const RELEVANT_ROOT_FILES = Object.freeze([
  'governance/PROJECT_CONSTITUTION.json',
  'governance/GATE_REGISTRY_00_40.json',
  'governance/MODEL_ROUTING_POLICY.json'
]);

/** Decision-bearing extensions. Code and data streams are not decisions. */
const RELEVANT_EXTENSIONS = Object.freeze(['.json', '.md', '.txt', '.ndjson']);

const EXCLUDED_SEGMENTS = Object.freeze(['/generated/', '/schemas/', '/tests/', '/node_modules/', '/.git/']);

/** Under governance/gates/, only the contract and state surfaces are decisions. */
const GATE_RELEVANT_SEGMENTS = Object.freeze(['/contracts/', '/state/']);

/**
 * Cohort manifests that digest THIS index. Excluded by explicit rule so the two
 * artifacts have a fixed point; see buildExistingWorkIndex.
 */
export const MUTUALLY_RECURSIVE_EXCLUSIONS = Object.freeze([
  'governance/historical-architecture/GATE_FAST_PATH_CONSUMPTION_R1.json'
]);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function walk(root, relativeDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.resolve(root, ...relativeDir.split('/')), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

export function isRelevantPath(relativePath) {
  if (EXCLUDED_SEGMENTS.some((segment) => `/${relativePath}`.includes(segment))) return false;
  if (relativePath.endsWith('.schema.json')) return false;
  if (!RELEVANT_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) return false;
  if (RELEVANT_ROOT_FILES.includes(relativePath)) return true;
  if (relativePath.startsWith('governance/gates/')) {
    return GATE_RELEVANT_SEGMENTS.some((segment) => relativePath.includes(segment));
  }
  return RELEVANT_ROOTS.some((root) => relativePath.startsWith(`${root}/`));
}

/** Deterministic enumeration of the relevant surface. */
export function enumerateRelevantArtifacts(root) {
  const found = [];
  for (const relativeRoot of RELEVANT_ROOTS) walk(root, relativeRoot, found);
  for (const file of RELEVANT_ROOT_FILES) {
    const resolved = path.resolve(root, ...file.split('/'));
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) found.push(file);
  }
  return [...new Set(found.filter(isRelevantPath))].sort();
}

/**
 * The link corpus: every governance file whose reference to an artifact would
 * actually constitute a disposition.
 *
 * TESTS ARE EXCLUDED, and this is load bearing rather than tidiness. A test that
 * names an artifact proves only that somebody wrote a test about it; it does not
 * mean any governed decision consumed it. Counting test mentions as links would
 * let a forgotten decision pack look filed the moment a fixture referenced its
 * path — including this index's own hostile tests, which name an orphan on
 * purpose. Generated projections are excluded for the same reason: a derived
 * file cannot be the thing that dispositions its own source.
 *
 * Read once and held in memory for the run, so N artifacts cost one pass over
 * the surface rather than N passes. Nothing outside governance/ is read.
 */
function buildLinkCorpus(root) {
  const files = walk(root, 'governance', [])
    .filter((file) => /\.(json|mjs|md|ndjson|txt)$/.test(file))
    .filter((file) => !file.includes('/tests/') && !file.endsWith('.test.mjs'))
    .filter((file) => !file.includes('/generated/'));
  const corpus = new Map();
  for (const file of files) {
    try {
      corpus.set(file, fs.readFileSync(path.resolve(root, ...file.split('/')), 'utf8'));
    } catch { /* an unreadable file simply provides no links */ }
  }
  return corpus;
}

/**
 * Who links to this artifact.
 *
 * A seal is named by construction (`<contract>_SEAL.json`) rather than by
 * literal string, so it inherits its contract's links. Without that, every seal
 * would look abandoned and the signal would be noise.
 */
function linkedBy(relativePath, corpus) {
  const basename = relativePath.split('/').pop();
  const viaContract = /_SEAL\.json$/.test(relativePath) ? relativePath.replace(/_SEAL\.json$/, '.json') : null;
  const viaContractBase = viaContract ? viaContract.split('/').pop() : null;
  const links = [];
  for (const [file, text] of corpus) {
    if (file === relativePath) continue;
    if (text.includes(relativePath) || text.includes(basename)
      || (viaContract && (text.includes(viaContract) || text.includes(viaContractBase)))) {
      links.push(file);
      if (links.length >= 4) break;
    }
  }
  return links;
}

/**
 * Rule-based disposition. Order matters: the first matching rule wins, and every
 * rule states the ground it decides on.
 */
export function deriveDisposition(relativePath, links) {
  if (RELEVANT_ROOT_FILES.includes(relativePath) || relativePath.startsWith('governance/active/')) {
    return { disposition: 'CANONICAL', rule: 'R-CANONICAL-ROOT' };
  }
  if (relativePath.startsWith('governance/gates/')) return { disposition: 'CANONICAL', rule: 'R-GATE-CANONICAL' };
  if (relativePath.startsWith('governance/gee-v1/missions/')) return { disposition: 'CANONICAL', rule: 'R-GEE-MISSION' };
  if (relativePath.startsWith('governance/authority/')) return { disposition: 'CANONICAL', rule: 'R-AUTHORITY' };
  if (relativePath.startsWith('governance/master-matrix/')) return { disposition: 'CANONICAL_INPUT', rule: 'R-MASTER-INPUT' };
  if (relativePath.startsWith('governance/historical-architecture/')) return { disposition: 'HISTORICAL_LEGACY', rule: 'R-HISTORICAL' };
  if (relativePath.startsWith('governance/implementation/')) return { disposition: 'DERIVED', rule: 'R-IMPLEMENTATION' };
  if (relativePath.startsWith('governance/sources/')) {
    // A source nothing links to is precisely the amnesia shape this index
    // exists to surface, so it is never derived — it needs an explicit answer.
    return links.length
      ? { disposition: 'CONSUMED', rule: 'R-SOURCE-CONSUMED' }
      : { disposition: null, rule: 'R-SOURCE-UNLINKED' };
  }
  return { disposition: null, rule: null };
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(root, ...relativePath.split('/')), 'utf8').replace(/^﻿/, ''));
}

function artifactClassMap(root) {
  try {
    const registry = readJson(root, CLASSIFICATION_REGISTRY_PATH);
    return new Map((registry.artifacts || []).map((entry) => [entry.path, entry.artifactClass]));
  } catch {
    return new Map();
  }
}

/**
 * Builds the live disposition view of the governed surface.
 *
 * `explicitDispositions` comes from the durable index artifact. Explicit entries
 * are honoured only for artifacts that actually exist and only when the recorded
 * disposition is in the vocabulary; a stale explicit entry for a deleted path is
 * reported rather than silently ignored.
 */
export function buildExistingWorkIndex({ root, explicitDispositions = {}, selfPath = INDEX_PATH } = {}) {
  // SELF-REFERENCE. The index cannot carry its own digest: writing the digest
  // changes the bytes it digests. The exclusion is therefore explicit, single,
  // deterministic and reported in the output — never a silent omission. The
  // index's own freshness is bound by the control plane, which hashes it.
  //
  // MUTUAL RECURSION. A cohort manifest digests this index, so indexing the
  // manifest in turn would give the two artifacts no fixed point: refreshing
  // either one invalidates the other forever. The manifests are excluded by the
  // same explicit rule and for the same reason, and their own integrity comes
  // from the commit they describe rather than from this index.
  const excluded = new Set([selfPath, ...MUTUALLY_RECURSIVE_EXCLUSIONS]);
  const artifacts = enumerateRelevantArtifacts(root).filter((relativePath) => !excluded.has(relativePath));
  const corpus = buildLinkCorpus(root);
  const classes = artifactClassMap(root);
  const rows = [];
  for (const relativePath of artifacts) {
    const bytes = fs.readFileSync(path.resolve(root, ...relativePath.split('/')));
    const links = linkedBy(relativePath, corpus);
    const derived = deriveDisposition(relativePath, links);
    const explicit = explicitDispositions[relativePath];
    const explicitValid = explicit && DISPOSITIONS.includes(explicit.disposition);
    const row = {
      path: relativePath,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      disposition: explicitValid ? explicit.disposition : derived.disposition,
      dispositionSource: explicitValid ? 'EXPLICIT' : derived.disposition ? 'DERIVED_RULE' : 'NONE',
      rule: derived.rule,
      linkCount: links.length,
      linkedBy: links
    };
    if (explicitValid && explicit.reason) row.reason = explicit.reason;
    if (explicitValid && explicit.supersededBy) row.supersededBy = explicit.supersededBy;
    const artifactClass = classes.get(relativePath);
    if (artifactClass) row.artifactClass = artifactClass;
    rows.push(row);
  }
  const known = new Set(artifacts);
  const staleExplicit = Object.keys(explicitDispositions).filter((relativePath) => !known.has(relativePath)).sort();
  const unclassified = rows.filter((row) => !row.disposition);
  const unlinked = rows.filter((row) => row.linkCount === 0);
  return {
    document: INDEX_DOCUMENT,
    version: INDEX_VERSION,
    selfExcludedPath: selfPath,
    mutuallyRecursiveExclusions: [...MUTUALLY_RECURSIVE_EXCLUSIONS],
    relevantRoots: [...RELEVANT_ROOTS],
    relevantRootFiles: [...RELEVANT_ROOT_FILES],
    dispositionVocabulary: [...DISPOSITIONS],
    relevantArtifactCount: rows.length,
    classifiedCount: rows.length - unclassified.length,
    unclassifiedRelevantArtifacts: unclassified.map((row) => row.path),
    unlinkedRelevantArtifacts: unlinked.map((row) => row.path),
    staleExplicitDispositions: staleExplicit,
    artifacts: rows
  };
}

/**
 * Compares the live surface against the durable index artifact.
 *
 * Three independent failures, kept separate because they mean different things:
 * an artifact nobody classified, an indexed artifact whose bytes moved, and an
 * indexed artifact that no longer exists.
 */
export function checkExistingWorkIndex({ root, indexPath = INDEX_PATH } = {}) {
  let stored = null;
  const errors = [];
  try {
    stored = readJson(root, indexPath);
  } catch (error) {
    errors.push(`INDEX_UNREADABLE:${error.message}`);
  }
  const explicitDispositions = Object.fromEntries(
    (stored?.artifacts || [])
      .filter((entry) => entry.dispositionSource === 'EXPLICIT')
      .map((entry) => [entry.path, { disposition: entry.disposition, reason: entry.reason, supersededBy: entry.supersededBy }])
  );
  const live = buildExistingWorkIndex({ root, explicitDispositions });
  const storedByPath = new Map((stored?.artifacts || []).map((entry) => [entry.path, entry]));
  const liveByPath = new Map(live.artifacts.map((entry) => [entry.path, entry]));

  const newArtifacts = live.artifacts.filter((entry) => !storedByPath.has(entry.path)).map((entry) => entry.path);
  const removedArtifacts = [...storedByPath.keys()].filter((entry) => !liveByPath.has(entry)).sort();
  const driftedArtifacts = live.artifacts
    .filter((entry) => storedByPath.has(entry.path) && storedByPath.get(entry.path).sha256 !== entry.sha256)
    .map((entry) => entry.path);

  const unclassified = live.unclassifiedRelevantArtifacts;
  const indexStale = newArtifacts.length > 0 || removedArtifacts.length > 0 || driftedArtifacts.length > 0;
  const verdict = errors.length ? 'BLOCKED'
    : unclassified.length ? 'BLOCKED_UNCLASSIFIED_RELEVANT_ARTIFACTS'
      : indexStale ? 'STALE_INDEX_REFRESH_REQUIRED'
        : 'PASS';
  return {
    document: INDEX_DOCUMENT,
    version: INDEX_VERSION,
    verdict,
    errors,
    relevantArtifactCount: live.relevantArtifactCount,
    classifiedCount: live.classifiedCount,
    unclassifiedRelevantArtifactCount: unclassified.length,
    unclassifiedRelevantArtifacts: unclassified,
    unlinkedRelevantArtifacts: live.unlinkedRelevantArtifacts,
    staleExplicitDispositions: live.staleExplicitDispositions,
    indexFreshness: { newArtifacts, removedArtifacts, driftedArtifacts, stale: indexStale },
    live
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  if (process.argv.includes('--emit')) {
    // A deterministic refresh: recorded decisions and the governed envelope are
    // carried forward, and only the recomputed surface changes. Regenerating the
    // index must never quietly discard an EXPLICIT disposition somebody made.
    const indexPath = option('--index', INDEX_PATH);
    let stored = null;
    try {
      stored = readJson(root, indexPath);
    } catch { /* first emit has no prior index */ }
    const explicitDispositions = Object.fromEntries((stored?.artifacts || [])
      .filter((entry) => entry.dispositionSource === 'EXPLICIT')
      .map((entry) => [entry.path, { disposition: entry.disposition, reason: entry.reason, supersededBy: entry.supersededBy }]));
    const index = buildExistingWorkIndex({ root, explicitDispositions });
    const ledgerEventCount = fs.readFileSync(path.resolve(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).length;
    const envelope = {
      document: index.document,
      schemaVersion: 1,
      version: index.version,
      programId: stored?.programId ?? 'WHEEL_GATE_FAST_PATH_CONTROL_PLANE_R1',
      canonical: stored?.canonical ?? 'CANONICAL_INPUT',
      baseHead: option('--base-head', stored?.baseHead ?? null),
      ledgerEventCount,
      recordedAt: option('--recorded-at', stored?.recordedAt ?? new Date().toISOString()),
      statement: stored?.statement ?? 'Disposition of every durable decision-bearing artifact in the governed surface. Answers the inverse of the preexecution reuse check: not whether every cited source resolves, but whether anything was produced that nothing cites. DERIVED_RULE rows are recomputed from bytes on every run; EXPLICIT rows are recorded decisions. An artifact with neither is UNCLASSIFIED and blocks.',
      selfExcludedPath: index.selfExcludedPath,
      selfExclusionReason: stored?.selfExclusionReason ?? 'An index cannot carry its own digest; its freshness is bound by the fast-path control plane instead.',
      ...index
    };
    delete envelope.document;
    process.stdout.write(`${JSON.stringify({ document: index.document, ...envelope }, null, 2)}\n`);
    process.exitCode = index.unclassifiedRelevantArtifacts.length === 0 ? 0 : 2;
  } else {
    const report = checkExistingWorkIndex({ root, indexPath: option('--index', INDEX_PATH) });
    const { live, ...summary } = report;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = report.verdict === 'PASS' ? 0 : 2;
  }
}
