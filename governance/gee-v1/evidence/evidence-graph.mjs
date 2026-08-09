import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { asBytes } from '../cas/content-addressed-store.mjs';
import { compareSnapshots } from '../delta/delta-engine.mjs';

export const EVIDENCE_GRAPH_VERSION = 'GEE_V1_EVIDENCE_GRAPH_R4';
export const VALIDATION_BASIS_KIND = 'R4_VALIDATION_BASIS';
export const REUSABLE = 'REUSABLE';
export const INVALIDATED = 'INVALIDATED';

// A producing validation may express its outcome through any of these fields.
// Every field that is present must agree, otherwise the outcome is contradictory.
const VALIDATION_OUTCOME_FIELDS = ['result', 'status', 'verdict', 'outcome'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/**
 * Locale-independent total order over identifiers. localeCompare() resolves
 * against the runtime's default locale, which would make graph identity
 * environment-dependent, so R4 orders by UTF-16 code unit instead.
 */
function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * THE canonical form of an R4 logical evidence identifier, and the only one.
 *
 * canonical-json hashes strings as NFC, so an identifier that is not already
 * NFC hashes as its normalized form while runtime Map lookups use the raw form.
 * That split would let one graphSha256 stand for two different runtime
 * dependency resolutions. Every place R4 stores, compares, looks up, parses,
 * binds or hashes an evidence id routes through this function, so runtime
 * identity and hashed identity are the same identity.
 *
 * Builder APIs canonicalize caller input; validateGraph() requires an already
 * materialized graph to be canonical and fails closed otherwise.
 */
export function canonicalEvidenceId(evidenceId) {
  if (typeof evidenceId !== 'string' || !evidenceId) throw new Error('EVIDENCE_ID_REQUIRED');
  return evidenceId.normalize('NFC');
}

function isCanonicalIdentifier(value) { return value === value.normalize('NFC'); }

function sortedUnique(values) {
  if (!Array.isArray(values)) throw new Error('EVIDENCE_DEPENDENCIES_REQUIRED');
  return [...new Set(values)].sort(compareIdentifiers);
}

function validateProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('EVIDENCE_PROVENANCE_REQUIRED');
  if (typeof provenance.sourcePath !== 'string' || !provenance.sourcePath) throw new Error('EVIDENCE_PROVENANCE_SOURCE_REQUIRED');
  // Source paths belong to R3's vocabulary, so R4 does not rewrite them; it
  // refuses a path whose hashed form would differ from its R3 lookup form.
  if (!isCanonicalIdentifier(provenance.sourcePath)) throw new Error(`NON_CANONICAL_PROVENANCE_SOURCE:${provenance.sourcePath}`);
  return stable(provenance);
}

function canonicalDependency(dependency, owner) {
  if (typeof dependency !== 'string' || !/^((source|evidence):).+/.test(dependency)) throw new Error(`INVALID_EVIDENCE_DEPENDENCY:${owner}`);
  if (dependency.startsWith('evidence:')) return `evidence:${canonicalEvidenceId(evidenceId(dependency))}`;
  if (!isCanonicalIdentifier(sourcePath(dependency))) throw new Error(`NON_CANONICAL_SOURCE_DEPENDENCY:${owner}`);
  return dependency;
}

function validationIdentity(validation) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return validation;
  const { validationState, validationBasisSha256, ...identity } = validation;
  return stable(identity);
}

function reuseIdentityBody(node) {
  return {
    contentAddress: node.contentAddress,
    contentSha256: node.contentSha256,
    evidenceType: node.evidenceType,
    provenance: node.provenance,
    dependencies: node.dependencies,
    producingValidation: validationIdentity(node.producingValidation),
    authorityStatus: node.authorityStatus
  };
}

function reuseIdentity(node) { return sha256Canonical(reuseIdentityBody(node)); }

function normalizeNode(input, cas) {
  if (!input || typeof input.evidenceId !== 'string' || !input.evidenceId) throw new Error('EVIDENCE_ID_REQUIRED');
  const canonicalId = canonicalEvidenceId(input.evidenceId);
  if (canonicalId.includes('/') || canonicalId.includes('..')) throw new Error('INVALID_EVIDENCE_ID');
  if (input.dependencies !== undefined && !Array.isArray(input.dependencies)) throw new Error('EVIDENCE_DEPENDENCIES_REQUIRED');
  const dependencies = sortedUnique((input.dependencies || []).map((dependency) => canonicalDependency(dependency, canonicalId)));
  const provenance = validateProvenance(input.provenance);
  const content = input.content === undefined ? null : asBytes(input.content);
  const identity = input.contentAddress
    ? { id: input.contentAddress, sha256: input.contentSha256, bytes: input.bytes }
    : cas.put(content);
  if (!identity.id || !/^sha256:[a-f0-9]{64}$/.test(identity.id) || identity.sha256 !== identity.id.slice(7) || !Number.isInteger(identity.bytes) || identity.bytes < 0) throw new Error(`INVALID_EVIDENCE_CONTENT_IDENTITY:${canonicalId}`);
  if (content !== null) {
    const observed = cas.identity(content);
    if (observed.id !== identity.id || observed.bytes !== identity.bytes) throw new Error(`EVIDENCE_CONTENT_IDENTITY_MISMATCH:${canonicalId}`);
  }
  const node = {
    evidenceId: canonicalId,
    contentAddress: identity.id,
    contentSha256: identity.sha256,
    bytes: identity.bytes,
    evidenceType: typeof input.evidenceType === 'string' && input.evidenceType ? input.evidenceType : 'UNCLASSIFIED',
    provenance,
    dependencies,
    producingValidation: input.producingValidation === undefined ? null : stable(input.producingValidation),
    authorityStatus: input.authorityStatus || 'UNKNOWN',
    state: input.state || 'NOT_EVALUATED',
    reason: input.reason || null,
    tombstone: input.tombstone === true
  };
  return { ...node, reuseIdentity: reuseIdentity(node) };
}

function graphBody(graph) {
  return { schemaVersion: graph.schemaVersion, graphKind: graph.graphKind, engine: graph.engine, evaluation: graph.evaluation || null, nodes: graph.nodes };
}

function withDigest(body) { return { ...body, graphSha256: sha256Canonical(graphBody(body)) }; }

function r3DeltaBasis(r3Delta) {
  return {
    engine: r3Delta.engine,
    authorityDeclaration: r3Delta.authorityDeclaration,
    deltas: r3Delta.deltas.map((delta) => ({
      path: delta.path,
      kind: delta.kind,
      previousSha256: delta.previousSha256 || null,
      currentSha256: delta.currentSha256 || null,
      bytes: delta.bytes
    }))
  };
}

function markEvaluated(graph, r3Delta) {
  const deltaBasis = r3DeltaBasis(r3Delta);
  const unsignedEvaluation = {
    evaluationKind: 'R4_EVALUATED_GRAPH',
    evaluator: EVIDENCE_GRAPH_VERSION,
    inputGraphSha256: graph.graphSha256,
    r3DeltaSha256: sha256Canonical(deltaBasis),
    r3DeltaBasis: deltaBasis,
    nodesSha256: sha256Canonical(graph.nodes)
  };
  return withDigest({
    ...graph,
    evaluation: { ...unsignedEvaluation, evaluationSha256: sha256Canonical(unsignedEvaluation) }
  });
}

export function createEvidenceGraph({ cas, nodes } = {}) {
  if (!cas || typeof cas.put !== 'function' || typeof cas.get !== 'function' || typeof cas.identity !== 'function') throw new Error('CAS_REQUIRED');
  if (!Array.isArray(nodes)) throw new Error('EVIDENCE_NODES_REQUIRED');
  const normalized = nodes.map((node) => normalizeNode(node, cas)).sort((a, b) => compareIdentifiers(a.evidenceId, b.evidenceId));
  // Duplicates are detected after canonicalization, so NFC-equivalent ids
  // cannot coexist as two runtime evidence identities.
  if (new Set(normalized.map((node) => node.evidenceId)).size !== normalized.length) throw new Error('DUPLICATE_EVIDENCE_ID');
  return withDigest({ schemaVersion: 1, graphKind: 'EVIDENCE_GRAPH', engine: EVIDENCE_GRAPH_VERSION, evaluation: null, nodes: normalized });
}

function assertGraphIdentity(graph, label) {
  if (!graph || graph.schemaVersion !== 1 || graph.graphKind !== 'EVIDENCE_GRAPH' || graph.engine !== EVIDENCE_GRAPH_VERSION || !Array.isArray(graph.nodes)) throw new Error(`INVALID_${label}_GRAPH_IDENTITY`);
  if (graph.graphSha256 !== sha256Canonical(graphBody(graph))) throw new Error(`INVALID_${label}_GRAPH_DIGEST`);
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.evidenceId !== 'string' || !node.evidenceId) throw new Error(`INVALID_${label}_NODE_IDENTITY`);
    // A materialized graph must already be canonical. Without this, a
    // Unicode-equivalent but non-canonical id would hash to the same
    // graphSha256 while resolving to a different runtime parent, so one digest
    // would stand for two different semantics. Canonicalizing here instead
    // would silently rewrite a caller's supplied graph, so this fails closed.
    if (!isCanonicalIdentifier(node.evidenceId)) throw new Error(`NON_CANONICAL_EVIDENCE_ID:${label}:${node.evidenceId}`);
    // Duplicates are checked on canonical ids, so two ids that collapse to one
    // canonical id can never both survive validation.
    if (ids.has(node.evidenceId)) throw new Error(`DUPLICATE_${label}_EVIDENCE_ID:${node.evidenceId}`);
    ids.add(node.evidenceId);
    if (!Array.isArray(node.dependencies)) throw new Error(`INVALID_${label}_NODE_IDENTITY`);
    for (const dependency of node.dependencies) {
      if (typeof dependency !== 'string' || !/^((source|evidence):).+/.test(dependency)) throw new Error(`INVALID_${label}_EVIDENCE_DEPENDENCY:${node.evidenceId}`);
      if (dependency.startsWith('evidence:')) {
        if (!isCanonicalIdentifier(evidenceId(dependency))) throw new Error(`NON_CANONICAL_EVIDENCE_DEPENDENCY:${label}:${dependency}`);
      } else if (!isCanonicalIdentifier(sourcePath(dependency))) {
        throw new Error(`NON_CANONICAL_SOURCE_DEPENDENCY:${label}:${dependency}`);
      }
    }
    if (typeof node.provenance?.sourcePath !== 'string' || !node.provenance.sourcePath) throw new Error(`INVALID_${label}_PROVENANCE:${node.evidenceId}`);
    if (!isCanonicalIdentifier(node.provenance.sourcePath)) throw new Error(`NON_CANONICAL_PROVENANCE_SOURCE:${label}:${node.provenance.sourcePath}`);
    if (node.contentAddress !== `sha256:${node.contentSha256}` || node.reuseIdentity !== reuseIdentity(node)) throw new Error(`INVALID_${label}_CONTENT_IDENTITY:${node.evidenceId}`);
    if (node.bytes < 0 || !Number.isInteger(node.bytes)) throw new Error(`INVALID_${label}_CONTENT_SIZE:${node.evidenceId}`);
  }
  return graph.nodes;
}

function validateGraph(graph, cas, label) {
  const nodes = assertGraphIdentity(graph, label);
  for (const node of nodes) {
    const bytes = cas.get(node.contentAddress);
    if (bytes.length !== node.bytes) throw new Error(`CAS_CONTENT_SIZE_MISMATCH:${node.evidenceId}`);
  }
  return nodes;
}

function sourcePath(dependency) { return dependency.slice('source:'.length); }
function evidenceId(dependency) { return dependency.slice('evidence:'.length); }
function sourceDependencyPaths(node) { return node.dependencies.filter((dependency) => dependency.startsWith('source:')).map(sourcePath); }
function parentEvidenceIds(node) { return node.dependencies.filter((dependency) => dependency.startsWith('evidence:')).map(evidenceId); }

function deltaByPath(r3Delta) {
  if (!r3Delta || !Array.isArray(r3Delta.deltas)) throw new Error('R3_DELTA_REQUIRED');
  return new Map(r3Delta.deltas.map((delta) => [delta.path, delta]));
}

function resolveR3Delta(input) {
  if (!input || !input.previousSnapshot || !input.currentSnapshot) throw new Error('R3_SNAPSHOTS_REQUIRED');
  try {
    return compareSnapshots({ previous: input.previousSnapshot, current: input.currentSnapshot });
  } catch (error) {
    throw new Error(`INVALID_R3_INPUT:${error.message}`);
  }
}

/**
 * Deterministic interpretation of a producing validation result.
 * Absent outcome fails closed as MISSING; contradictory outcomes fail closed as FAIL.
 */
export function interpretValidation(validation) {
  if (validation === null || validation === undefined) return 'MISSING';
  if (typeof validation !== 'object' || Array.isArray(validation)) return 'FAIL';
  const signals = VALIDATION_OUTCOME_FIELDS.filter((field) => Object.hasOwn(validation, field)).map((field) => validation[field]);
  if (signals.length === 0) return 'MISSING';
  return signals.every((signal) => signal === 'PASS') ? 'PASS' : 'FAIL';
}

function currentSourceSha256(deltas, path) {
  const delta = deltas.get(path);
  return delta && typeof delta.currentSha256 === 'string' ? delta.currentSha256 : null;
}

/**
 * The validation basis answers exactly one question: against which CURRENT
 * identities was this evidence validated? It binds the evidence's own reuse
 * identity, the current identity of every declared source dependency, the
 * current identity of the provenance source, and the current identity of every
 * evidence parent. It deliberately carries current identities and never delta
 * kinds, so an unchanged replay recomputes to the identical basis while any
 * real change breaks the binding.
 */
function validationBasisBody(node, parentIdentityOf, deltas) {
  return {
    basisKind: VALIDATION_BASIS_KIND,
    evidenceId: node.evidenceId,
    evidenceIdentity: node.reuseIdentity,
    sources: sourceDependencyPaths(node).map((path) => ({ path, currentSha256: currentSourceSha256(deltas, path) })),
    provenanceSource: { path: node.provenance.sourcePath, currentSha256: currentSourceSha256(deltas, node.provenance.sourcePath) },
    parents: parentEvidenceIds(node).map((id) => ({ evidenceId: id, evidenceIdentity: parentIdentityOf(id) }))
  };
}

function validationBasisSha256(node, parentIdentityOf, deltas) {
  return sha256Canonical(validationBasisBody(node, parentIdentityOf, deltas));
}

function staleBasisReason(node, deltas) {
  for (const path of sourceDependencyPaths(node)) {
    const kind = deltas.get(path).kind;
    if (kind !== 'UNCHANGED') return `DIRECT_SOURCE_${kind}`;
  }
  const provenanceKind = deltas.get(node.provenance.sourcePath).kind;
  if (provenanceKind !== 'UNCHANGED') return `PROVENANCE_SOURCE_${provenanceKind}`;
  if (parentEvidenceIds(node).length) return 'PARENT_EVIDENCE_IDENTITY_CHANGED';
  return 'VALIDATION_BASIS_STALE';
}

function reuseObstacle(node, byId, deltas, memo, visiting) {
  if (node.authorityStatus !== 'GROUNDED') return 'PROVENANCE_NOT_GROUNDED';

  // Declared source dependencies must exist in the R3 comparison.
  for (const path of sourceDependencyPaths(node)) {
    const delta = deltas.get(path);
    if (!delta) return 'DEPENDENCY_UNTRACKED';
    if (delta.kind === 'REMOVED') return 'DIRECT_SOURCE_REMOVED';
  }

  // The provenance source is an implicit dependency of the evidence itself.
  const provenanceDelta = deltas.get(node.provenance.sourcePath);
  if (!provenanceDelta) return 'PROVENANCE_SOURCE_UNTRACKED';
  if (provenanceDelta.kind === 'REMOVED') return 'PROVENANCE_SOURCE_REMOVED';
  if (typeof node.provenance.sourceSha256 === 'string' && node.provenance.sourceSha256 !== provenanceDelta.currentSha256) return 'PROVENANCE_SOURCE_HASH_MISMATCH';

  for (const id of parentEvidenceIds(node)) {
    const parent = byId.get(id);
    if (!parent) return 'MISSING_REQUIRED_EVIDENCE';
    if (evaluateNode(parent, byId, deltas, memo, visiting).state !== REUSABLE) return 'PARENT_EVIDENCE_INVALIDATED';
  }

  // The producing validation is supplied by the producing process. R4 never
  // invents it; it only checks the outcome and its binding to the current basis.
  const outcome = interpretValidation(node.producingValidation);
  if (outcome === 'MISSING') return 'PRODUCING_VALIDATION_MISSING';
  if (outcome === 'FAIL') return 'PRODUCING_VALIDATION_NOT_PASS';
  if (node.producingValidation.validationState !== 'CURRENT') return 'VALIDATION_NOT_BOUND_TO_BASIS';
  const parentIdentityOf = (id) => byId.get(id)?.reuseIdentity ?? null;
  if (node.producingValidation.validationBasisSha256 !== validationBasisSha256(node, parentIdentityOf, deltas)) return staleBasisReason(node, deltas);
  return null;
}

function evaluateNode(node, byId, deltas, memo, visiting) {
  if (memo.has(node.evidenceId)) return memo.get(node.evidenceId);
  if (visiting.has(node.evidenceId)) return { state: INVALIDATED, reason: 'DEPENDENCY_CYCLE' };
  visiting.add(node.evidenceId);
  const reason = reuseObstacle(node, byId, deltas, memo, visiting);
  visiting.delete(node.evidenceId);
  const result = { state: reason ? INVALIDATED : REUSABLE, reason: reason || 'ALL_REUSE_CONDITIONS_PROVEN' };
  memo.set(node.evidenceId, result);
  return result;
}

export function evaluateEvidenceGraph({ graph, previousGraph = null, r3Delta, cas } = {}) {
  if (!cas) throw new Error('CAS_REQUIRED');
  const nodes = validateGraph(graph, cas, 'CURRENT');
  const previousNodes = previousGraph ? validateGraph(previousGraph, cas, 'PREVIOUS') : [];
  const verifiedR3Delta = resolveR3Delta(r3Delta);
  const deltas = deltaByPath(verifiedR3Delta);
  const byId = new Map(nodes.map((node) => [node.evidenceId, node]));
  const memo = new Map();
  const evaluated = nodes.map((node) => {
    const result = evaluateNode(node, byId, deltas, memo, new Set());
    return { ...node, state: result.state, reusable: result.state === REUSABLE, invalidated: result.state === INVALIDATED, reason: result.reason, tombstone: false };
  });
  const tombstones = previousNodes.filter((node) => !byId.has(node.evidenceId)).map((node) => ({
    evidenceId: node.evidenceId,
    contentAddress: node.contentAddress,
    contentSha256: node.contentSha256,
    bytes: node.bytes,
    evidenceType: node.evidenceType,
    provenance: node.provenance,
    dependencies: node.dependencies,
    producingValidation: node.producingValidation,
    authorityStatus: node.authorityStatus,
    state: INVALIDATED,
    reusable: false,
    invalidated: true,
    reason: 'EVIDENCE_REMOVED',
    tombstone: true,
    reuseIdentity: node.reuseIdentity
  }));
  const outputNodes = [...evaluated, ...tombstones].sort((a, b) => compareIdentifiers(a.evidenceId, b.evidenceId));
  const bytesOf = (list) => list.reduce((sum, node) => sum + node.bytes, 0);
  // Removed evidence is invalidated and tombstoned, but there is no current
  // evidence left to validate, so it is not revalidation work and must not sit
  // in the denominator of the avoided-revalidation ratio.
  const current = outputNodes.filter((node) => !node.tombstone);
  const removed = outputNodes.filter((node) => node.tombstone);
  const reusable = current.filter((node) => node.state === REUSABLE);
  const revalidate = current.filter((node) => node.state === INVALIDATED);
  const invalidated = outputNodes.filter((node) => node.state === INVALIDATED);
  // The digest of the exact evaluated node set, bound before evaluation
  // metadata is attached. Deterministic provenance only; it grants no trust.
  const inputGraph = withDigest({ schemaVersion: 1, graphKind: 'EVIDENCE_GRAPH', engine: EVIDENCE_GRAPH_VERSION, evaluation: null, nodes: outputNodes });
  return {
    graph: markEvaluated(inputGraph, verifiedR3Delta),
    reusableNodes: reusable,
    invalidatedNodes: invalidated,
    metrics: {
      TOTAL_EVIDENCE_NODES: outputNodes.length,
      CURRENT_EVIDENCE_NODES: current.length,
      REUSABLE_NODES: reusable.length,
      INVALIDATED_NODES: invalidated.length,
      REVALIDATION_REQUIRED_NODES: revalidate.length,
      REMOVED_EVIDENCE_NODES: removed.length,
      AVOIDED_REVALIDATION_NODES: reusable.length,
      AVOIDED_REVALIDATION_RATIO: current.length ? reusable.length / current.length : 0,
      TOTAL_EVIDENCE_BYTES: bytesOf(outputNodes),
      CURRENT_EVIDENCE_BYTES: bytesOf(current),
      REUSED_EVIDENCE_BYTES: bytesOf(reusable),
      REVALIDATE_EVIDENCE_BYTES: bytesOf(revalidate),
      REMOVED_EVIDENCE_BYTES: bytesOf(removed),
      AVOIDED_EVIDENCE_BYTES: bytesOf(reusable),
      TOKEN_MEASUREMENT: 'NOT_AVAILABLE'
    }
  };
}

/**
 * Binds a genuine, externally produced validation outcome to the current
 * validation basis of one normalized evidence node. The outcome is required:
 * this function can never manufacture a PASS on behalf of a producing
 * validator. A contradictory or explicitly failing outcome is bound unchanged
 * so that evaluation still fails closed on it.
 */
export function createFreshValidation({ node, graph = null, r3Delta, validationResult } = {}) {
  if (!node || typeof node !== 'object' || typeof node.evidenceId !== 'string' || typeof node.reuseIdentity !== 'string') throw new Error('NORMALIZED_EVIDENCE_NODE_REQUIRED');
  // This takes an already normalized node, so its id must already be canonical.
  if (!isCanonicalIdentifier(node.evidenceId)) throw new Error(`NON_CANONICAL_EVIDENCE_ID:${node.evidenceId}`);
  if (!validationResult || typeof validationResult !== 'object' || Array.isArray(validationResult)) throw new Error('PRODUCING_VALIDATION_RESULT_REQUIRED');
  if (interpretValidation(validationResult) === 'MISSING') throw new Error('PRODUCING_VALIDATION_OUTCOME_REQUIRED');
  const deltas = deltaByPath(resolveR3Delta(r3Delta));
  const identity = validationIdentity(validationResult);
  const validated = { ...node, producingValidation: identity };
  const projected = { ...validated, reuseIdentity: reuseIdentity(validated) };
  const parents = parentEvidenceIds(projected);
  if (parents.length && !graph) throw new Error(`EVIDENCE_PARENT_GRAPH_REQUIRED:${projected.evidenceId}`);
  const byId = graph ? new Map(assertGraphIdentity(graph, 'PARENT').map((item) => [item.evidenceId, item])) : new Map();
  const parentIdentityOf = (id) => byId.get(id)?.reuseIdentity ?? null;
  return { ...identity, validationState: 'CURRENT', validationBasisSha256: validationBasisSha256(projected, parentIdentityOf, deltas) };
}

/**
 * Binds supplied validation outcomes across a node set in dependency order, so
 * that a child is always bound to the final identity of its evidence parents.
 * Nodes absent from validationResults keep whatever validation they already
 * carry, which is how a stale child survives a parent revalidation.
 *
 * This is a builder API, so it accepts caller logical ids in any Unicode
 * representation and canonicalizes them: both the node ids and the
 * validationResults keys route through canonicalEvidenceId(). A decomposed key
 * therefore binds the canonical node rather than silently binding nothing.
 */
export function bindFreshValidations({ cas, nodes, r3Delta, validationResults = {} } = {}) {
  if (!cas) throw new Error('CAS_REQUIRED');
  if (!Array.isArray(nodes)) throw new Error('EVIDENCE_NODES_REQUIRED');
  if (!validationResults || typeof validationResults !== 'object' || Array.isArray(validationResults)) throw new Error('PRODUCING_VALIDATION_RESULT_REQUIRED');
  const working = nodes.map((node) => ({ ...node }));
  const byId = new Map();
  for (const node of working) {
    const id = canonicalEvidenceId(node?.evidenceId);
    if (byId.has(id)) throw new Error(`DUPLICATE_EVIDENCE_ID:${id}`);
    byId.set(id, node);
  }
  // Canonicalizing keys can map two distinct caller keys onto one logical
  // evidence id. Building a Map directly would let insertion order silently
  // decide which outcome wins, so a collision is ambiguous caller input and is
  // rejected rather than resolved. This holds even when the outcomes agree:
  // the caller still supplied two identities for one logical node.
  const results = new Map();
  for (const [suppliedId, result] of Object.entries(validationResults)) {
    const id = canonicalEvidenceId(suppliedId);
    if (results.has(id)) throw new Error(`DUPLICATE_VALIDATION_RESULT_EVIDENCE_ID:${id}`);
    results.set(id, result);
  }
  const bound = new Set();
  const visiting = new Set();
  const bind = (id) => {
    if (bound.has(id) || !byId.has(id)) return;
    if (visiting.has(id)) throw new Error(`EVIDENCE_DEPENDENCY_CYCLE:${id}`);
    visiting.add(id);
    const raw = byId.get(id);
    const parents = (raw.dependencies || [])
      .filter((dependency) => typeof dependency === 'string' && dependency.startsWith('evidence:'))
      .map((dependency) => canonicalEvidenceId(evidenceId(dependency)));
    for (const parent of parents) bind(parent);
    visiting.delete(id);
    bound.add(id);
    if (!results.has(id)) return;
    const graph = parents.length ? createEvidenceGraph({ cas, nodes: working }) : null;
    const normalized = graph ? graph.nodes.find((item) => item.evidenceId === id) : normalizeNode(raw, cas);
    raw.producingValidation = createFreshValidation({ node: normalized, graph, r3Delta, validationResult: results.get(id) });
  };
  for (const id of byId.keys()) bind(id);
  return working;
}

export { validateGraph };
