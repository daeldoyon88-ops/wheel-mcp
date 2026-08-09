import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const R3_VERSION = 'GEE_V1_DELTA_ENGINE_R3';
export const R2_AUTHORITY = 'DERIVED / NON_AUTHORITATIVE';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const canonical = (value) => JSON.stringify(stable(value));

function sourceBytes(root, source) {
  if (!source || typeof source.path !== 'string' || !source.path || path.isAbsolute(source.path) || source.path.includes('..')) throw new Error('INVALID_SOURCE_IDENTITY');
  const absolute = path.join(root, ...source.path.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`MISSING_CRITICAL_SOURCE:${source.path}`);
  return fs.readFileSync(absolute);
}

function digestSource(root, source) {
  const bytes = sourceBytes(root, source);
  const digest = sha256(bytes);
  if (source.sha256 !== undefined && source.sha256 !== digest) throw new Error(`FORGED_PREVIOUS_DIGEST:${source.path}`);
  return { path: source.path, sha256: digest, bytes: bytes.length, provenance: source.provenance || null };
}

function index(rows) { return new Map(rows.map((row) => [row.path, row])); }
function indexFacts(rows) { return new Map(rows.map((row) => [row.id, row])); }

function normalizeFact(fact, sourcePaths) {
  if (!fact || typeof fact.id !== 'string' || !Array.isArray(fact.dependencies) || !fact.provenance) throw new Error('FACT_PROVENANCE_REQUIRED');
  const dependencies = [...new Set(fact.dependencies)].sort();
  if (!dependencies.every((dependency) => sourcePaths.has(dependency))) throw new Error(`MISSING_FACT_DEPENDENCY:${fact.id}`);
  const normalized = { id: fact.id, value: fact.value, dependencies, provenance: fact.provenance };
  return { ...normalized, factSha256: sha256(Buffer.from(canonical(normalized), 'utf8')) };
}

function validateSnapshot(snapshot, label) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.engine !== R3_VERSION || snapshot.authorityDeclaration !== R2_AUTHORITY) throw new Error(`INVALID_${label}_SNAPSHOT_IDENTITY`);
  if (!Array.isArray(snapshot.sources) || !Array.isArray(snapshot.facts) || typeof snapshot.snapshotSha256 !== 'string') throw new Error(`INVALID_${label}_SNAPSHOT_STRUCTURE`);
  const sources = snapshot.sources.map((source) => {
    if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string' || !Number.isInteger(source.bytes) || source.bytes < 0) throw new Error(`INVALID_${label}_SOURCE_STRUCTURE`);
    return source;
  });
  const sourcePaths = new Set(sources.map((source) => source.path));
  const facts = snapshot.facts.map((fact) => normalizeFact(fact, sourcePaths));
  const expected = sha256(Buffer.from(canonical({ sources, facts }), 'utf8'));
  if (snapshot.snapshotSha256 !== expected) throw new Error(`INVALID_${label}_SNAPSHOT_DIGEST`);
  return { sources, facts };
}

export function createSnapshot({ repoRoot, sources, facts = [] } = {}) {
  if (!repoRoot || !Array.isArray(sources)) throw new Error('CRITICAL_INPUTS_REQUIRED');
  const rows = sources.map((source) => digestSource(repoRoot, source)).sort((a, b) => a.path.localeCompare(b.path));
  const sourcePaths = new Set(rows.map((row) => row.path));
  const normalizedFacts = facts.map((fact) => normalizeFact(fact, sourcePaths)).sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: 1, engine: R3_VERSION, authorityDeclaration: R2_AUTHORITY, sources: rows, facts: normalizedFacts, snapshotSha256: sha256(Buffer.from(canonical({ sources: rows, facts: normalizedFacts }), 'utf8')) };
}

export function compareSnapshots({ previous, current, criticalPaths = [] } = {}) {
  if (!previous || !current) throw new Error('UNTRUSTED_CONTEXT_AUTHORITY');
  const previousValidated = validateSnapshot(previous, 'PREVIOUS');
  const currentValidated = validateSnapshot(current, 'CURRENT');
  const before = index(previousValidated.sources); const after = index(currentValidated.sources);
  const all = [...new Set([...before.keys(), ...after.keys()])].sort();
  const deltas = all.map((sourcePath) => {
    const oldRow = before.get(sourcePath); const newRow = after.get(sourcePath);
    let kind = 'UNCHANGED';
    if (!oldRow) kind = 'ADDED'; else if (!newRow) kind = 'REMOVED'; else if (oldRow.sha256 !== newRow.sha256 || oldRow.bytes !== newRow.bytes) kind = 'CHANGED';
    const row = newRow || oldRow;
    if (criticalPaths.includes(sourcePath) && !newRow) throw new Error(`MISSING_CRITICAL_SOURCE:${sourcePath}`);
    return { path: sourcePath, kind, previousSha256: oldRow?.sha256 || null, currentSha256: newRow?.sha256 || null, bytes: row.bytes, provenance: row.provenance };
  });
  const changed = new Set(deltas.filter((delta) => delta.kind !== 'UNCHANGED').map((delta) => delta.path));
  const previousFacts = indexFacts(previousValidated.facts); const currentFacts = indexFacts(currentValidated.facts);
  const invalidated = [];
  const factIds = [...new Set([...previousFacts.keys(), ...currentFacts.keys()])].sort();
  for (const factId of factIds) {
    const oldFact = previousFacts.get(factId); const newFact = currentFacts.get(factId);
    const dependenciesChanged = (oldFact?.dependencies || newFact?.dependencies || []).some((dependency) => changed.has(dependency));
    const contentChanged = Boolean(oldFact && newFact && oldFact.factSha256 !== newFact.factSha256);
    if (dependenciesChanged || contentChanged || (oldFact && !newFact && dependenciesChanged)) {
      invalidated.push({ id: factId, dependencies: oldFact?.dependencies || newFact?.dependencies || [], provenance: oldFact?.provenance || newFact?.provenance, reason: !newFact ? 'PRIOR_FACT_DEPENDENCY_INVALIDATED' : contentChanged ? 'FACT_CONTENT_CHANGED' : 'FACT_DEPENDENCY_INVALIDATED', previousFactSha256: oldFact?.factSha256 || null, currentFactSha256: newFact?.factSha256 || null });
    }
  }
  const reusable = currentValidated.facts.filter((fact) => {
    const previousFact = previousFacts.get(fact.id);
    return previousFact && previousFact.factSha256 === fact.factSha256 && fact.dependencies.every((dependency) => !changed.has(dependency));
  }).map((fact) => ({ ...fact, reuse: 'REUSABLE' })).sort((a, b) => a.id.localeCompare(b.id));
  const total = deltas.reduce((sum, delta) => sum + (delta.kind === 'REMOVED' ? delta.bytes : delta.currentSha256 ? delta.bytes : 0), 0);
  const changedBytes = deltas.filter((delta) => delta.kind !== 'UNCHANGED').reduce((sum, delta) => sum + delta.bytes, 0);
  const reprocessPaths = new Set([...changed, ...invalidated.flatMap((fact) => fact.dependencies)]);
  const reprocessBytes = [...reprocessPaths].reduce((sum, dependency) => sum + (after.get(dependency)?.bytes || before.get(dependency)?.bytes || 0), 0);
  return { engine: R3_VERSION, authorityDeclaration: R2_AUTHORITY, deltas, reusableFacts: reusable, invalidatedFacts: invalidated, metrics: { TOTAL_RELEVANT_BYTES: total, UNCHANGED_BYTES: deltas.filter((d) => d.kind === 'UNCHANGED').reduce((s, d) => s + d.bytes, 0), CHANGED_BYTES: changedBytes, REPROCESS_BYTES: reprocessBytes, AVOIDED_REPROCESS_BYTES: Math.max(0, total - reprocessBytes), AVOIDED_REPROCESS_RATIO: total ? Math.max(0, total - reprocessBytes) / total : 0, TOKEN_MEASUREMENT: 'NOT_AVAILABLE' } };
}
