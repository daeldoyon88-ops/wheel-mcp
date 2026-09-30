/**
 * PUBLICATION_LINEAGE_SUCCESSOR — an explicit, Owner-authorized statement that,
 * for ONE exact path, ONE exact predecessor publication was consumed by ONE exact
 * successor publication.
 *
 * WHY THIS EXISTS. `current-byte-authorization.mjs` decides a path's applicable
 * publication causally: P2 supersedes P1 for X when P2's declared pre-state for X
 * is exactly P1's certified output. That chain is the only ordering it accepts,
 * and it is the right default. It cannot express a succession whose successor
 * was not pre-state-bound to its predecessor's output, so both remain terminal
 * and the path is PUBLICATION_LINEAGE_AMBIGUOUS forever. The only honest ways out
 * are to rewrite a historical publication (forbidden) or to state the missing
 * edge explicitly under Owner authority. This module is the second.
 *
 * WHAT A VALID EDGE DOES, AND ALL IT DOES. It removes the named predecessor
 * binding — that one publication, for that one path — from the terminal set.
 * Nothing else. In particular it:
 *
 *   - authorizes no bytes: the successor must already be an admissible
 *     publication that certified the exact digest and length, and the current
 *     bytes must still equal the resulting terminal's certified digest;
 *   - creates no publication binding: both sides are matched against bindings the
 *     existing collector already produced under the existing admissibility rules,
 *     so an inadmissible publication cannot be named into existence;
 *   - rewrites no historical artifact and widens no admission;
 *   - reads no clock and applies no ordering rule: the record carries no
 *     timestamp field at all, and the closed schema forbids adding one;
 *   - touches only the path it names: a record is consulted only while deriving
 *     that exact path's terminal.
 *
 * MUTUAL BINDING WITHOUT A HASH CYCLE. The record pins the Owner authority by its
 * raw-byte SHA-256. The authority cannot pin the record's bytes in return (each
 * would have to contain the other's digest), so it restates the identical edge,
 * the edge's canonical digest, and the record's exact id and path. Either
 * document alone is inert.
 *
 * FAIL CLOSED, PATH-WIDE. Every relevant record for the path is judged, and if
 * ANY of them is refused — or two valid edges branch from one predecessor, or the
 * edges together with the existing pre-state chain form a cycle, or the record
 * registry itself cannot be read — NO edge applies to that path. The result is
 * then exactly what it would have been with no records at all. A refusal can
 * never make a path more authorized than it already was.
 *
 * SAME-DIGEST TERMINALS. This module invents no collapse rule. Two successor
 * branches from one predecessor are a conflict even when they certify identical
 * bytes; the existing identical-digest collapse in `resolveApplicable` is the
 * only place such terminals are ever merged, and it runs unchanged afterwards.
 *
 * PURE. Reads documents under `root`; writes nothing; no Git, no network, no clock.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';

export const RECORD_DOCUMENT = 'PUBLICATION_LINEAGE_SUCCESSOR_RECORD';
export const OWNER_AUTHORITY_DOCUMENT = 'PUBLICATION_LINEAGE_SUCCESSOR_OWNER_AUTHORITY';
export const RESOLUTION_DOCUMENT = 'PUBLICATION_LINEAGE_SUCCESSOR_RESOLUTION';
export const SUCCESSOR_ROOT = 'governance/authority/publication-lineage-successor';
export const RECORD_DIR = `${SUCCESSOR_ROOT}/records`;
export const OWNER_AUTHORITY_DIR = `${SUCCESSOR_ROOT}/owner-authorities`;

// Equal by value to current-byte-authorization's BINDING_MAINTENANCE_PUBLICATION.
// Restated rather than imported so this module does not import its own caller; the
// test suite asserts the two stay identical.
export const MAINTENANCE_PUBLICATION_BINDING_CLASS = 'MAINTENANCE_PUBLICATION_COHORT';
const MAINTENANCE_AUTHORITY_DOCUMENT = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY';

export const SUCCESSOR_REFUSAL = Object.freeze({
  REGISTRY_UNREADABLE: 'SUCCESSOR_REGISTRY_UNREADABLE',
  RECORD_MALFORMED: 'SUCCESSOR_RECORD_MALFORMED',
  RECORD_PATH_MISMATCH: 'SUCCESSOR_RECORD_PATH_MISMATCH',
  EDGE_DIGEST_MISMATCH: 'SUCCESSOR_EDGE_DIGEST_MISMATCH',
  OWNER_AUTHORITY_MISSING: 'SUCCESSOR_OWNER_AUTHORITY_MISSING',
  OWNER_AUTHORITY_MALFORMED: 'SUCCESSOR_OWNER_AUTHORITY_MALFORMED',
  OWNER_AUTHORITY_DIGEST_MISMATCH: 'SUCCESSOR_OWNER_AUTHORITY_DIGEST_MISMATCH',
  OWNER_AUTHORITY_REUSED: 'SUCCESSOR_OWNER_AUTHORITY_REUSED',
  CROSS_BINDING_MISMATCH: 'SUCCESSOR_CROSS_BINDING_MISMATCH',
  PUBLICATION_MISSING: 'SUCCESSOR_PUBLICATION_MISSING',
  PUBLICATION_IDENTITY_MISMATCH: 'SUCCESSOR_PUBLICATION_IDENTITY_MISMATCH',
  PUBLICATION_NOT_ADMITTED: 'SUCCESSOR_PUBLICATION_NOT_ADMITTED',
  PATH_ABSENT_FROM_COHORT: 'SUCCESSOR_PATH_ABSENT_FROM_COHORT',
  DIGEST_MISMATCH: 'SUCCESSOR_DIGEST_MISMATCH',
  BYTE_LENGTH_MISMATCH: 'SUCCESSOR_BYTE_LENGTH_MISMATCH',
  CYCLE: 'SUCCESSOR_CYCLE',
  CONFLICTING_SUCCESSORS: 'SUCCESSOR_CONFLICTING_BRANCHES',
  PATH_REFUSED: 'SUCCESSOR_PATH_REFUSED'
});

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RECORD_SCHEMA_PATH = path.resolve(MODULE_DIR, '..', 'schemas', 'publication-lineage-successor-record.schema.json');
export const OWNER_AUTHORITY_SCHEMA_PATH = path.resolve(MODULE_DIR, '..', 'schemas', 'publication-lineage-successor-owner-authority.schema.json');
let schemaCache = null;
function loadSchemas() {
  schemaCache ??= {
    record: JSON.parse(fs.readFileSync(RECORD_SCHEMA_PATH, 'utf8')),
    authority: JSON.parse(fs.readFileSync(OWNER_AUTHORITY_SCHEMA_PATH, 'utf8'))
  };
  return schemaCache;
}

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

/** Raw bytes at a repo-relative path, confined to `root`; null when absent. */
function readIdentity(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, ...relativePath.split('/'));
  if (!file.startsWith(base + path.sep)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
    const bytes = fs.readFileSync(file);
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  } catch { return null; }
}

/** Parsed JSON object, or undefined for anything that is not one. */
function parseObject(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

/** Canonical digest of an edge; the value both documents must carry as `edgeSha256`. */
export function computeSuccessorEdgeSha256(edge) {
  return sha256Canonical(edge);
}

export function recordPathFor(recordId) { return `${RECORD_DIR}/${recordId}.json`; }
export function ownerAuthorityPathFor(authorityId) { return `${OWNER_AUTHORITY_DIR}/${authorityId}.json`; }

function schemaShape(instance, schema, code) {
  const findings = [];
  const result = validateAgainstJsonSchema(instance, schema);
  for (const error of result.errors) finding(findings, code, `${error.jsonPointer}:${error.reason}`);
  return { valid: findings.length === 0, findings };
}

export function validatePublicationLineageSuccessorRecordShape(record) {
  return schemaShape(record, loadSchemas().record, SUCCESSOR_REFUSAL.RECORD_MALFORMED);
}

export function validatePublicationLineageSuccessorOwnerAuthorityShape(authority) {
  return schemaShape(authority, loadSchemas().authority, SUCCESSOR_REFUSAL.OWNER_AUTHORITY_MALFORMED);
}

/**
 * Re-proves, from the bytes on disk, that one side of an edge is the publication
 * it claims to be and that it certified exactly `side.sha256`/`side.byteLength`
 * for `edgePath`. This is independent of the binding collector; the collector's
 * admissibility is enforced separately by requiring a matching candidate.
 */
function verifyPublicationSide({ root, gateId, edgePath, side, role, findings }) {
  const at = (field) => `${role}.${field}`;

  const authorityIdentity = readIdentity(root, side.authorityPath);
  if (!authorityIdentity) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_MISSING, at('authorityPath'));
  if (authorityIdentity.sha256 !== side.authoritySha256) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('authoritySha256'));
  const authority = parseObject(authorityIdentity.bytes);
  if (authority?.document !== MAINTENANCE_AUTHORITY_DOCUMENT
      || authority.authorityId !== side.authorityId
      || authority.preState?.gateId !== gateId
      || authority.authorizedPathManifestPath !== side.manifestPath
      || authority.authorizedPathManifestSha256 !== side.manifestSha256
      || authority.consumptionRecordPath !== side.consumptionPath) {
    return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('authority'));
  }

  const manifestIdentity = readIdentity(root, side.manifestPath);
  if (!manifestIdentity) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_MISSING, at('manifestPath'));
  if (manifestIdentity.sha256 !== side.manifestSha256) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('manifestSha256'));
  const manifest = parseObject(manifestIdentity.bytes);
  if (!Array.isArray(manifest?.paths)) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('manifest'));
  if (!manifest.paths.some((entry) => entry?.path === edgePath)) return finding(findings, SUCCESSOR_REFUSAL.PATH_ABSENT_FROM_COHORT, at('manifest'));

  const consumptionIdentity = readIdentity(root, side.consumptionPath);
  if (!consumptionIdentity) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_MISSING, at('consumptionPath'));
  if (consumptionIdentity.sha256 !== side.consumptionSha256) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('consumptionSha256'));
  const consumption = parseObject(consumptionIdentity.bytes);
  if (consumption?.authorityId !== side.authorityId || !Array.isArray(consumption.cohort)) {
    return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('consumption'));
  }
  const entries = consumption.cohort.filter((entry) => entry?.path === edgePath);
  if (entries.length === 0) return finding(findings, SUCCESSOR_REFUSAL.PATH_ABSENT_FROM_COHORT, at('consumption'));
  if (entries.length > 1) return finding(findings, SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, at('consumption.cohort'));
  if (entries[0].sha256 !== side.sha256) return finding(findings, SUCCESSOR_REFUSAL.DIGEST_MISMATCH, at('sha256'));
  if (entries[0].byteLength !== side.byteLength) return finding(findings, SUCCESSOR_REFUSAL.BYTE_LENGTH_MISMATCH, at('byteLength'));
}

/**
 * Validates one successor record and its Owner authority in isolation — shape,
 * location, edge digest, the mutual binding, and both publications' identities
 * and certified bytes. Does not judge admissibility, branching or cycles; those
 * need the path's candidate set and are decided by the resolver.
 */
export function evaluatePublicationLineageSuccessorRecord({ root, gateId, recordPath, record }) {
  const findings = [];
  const shape = validatePublicationLineageSuccessorRecordShape(record);
  if (!shape.valid) return { valid: false, findings: shape.findings };
  if (record.gateId !== gateId) finding(findings, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH, 'record.gateId');
  if (recordPath !== recordPathFor(record.recordId)) finding(findings, SUCCESSOR_REFUSAL.RECORD_PATH_MISMATCH, recordPath);
  if (computeSuccessorEdgeSha256(record.edge) !== record.edgeSha256) finding(findings, SUCCESSOR_REFUSAL.EDGE_DIGEST_MISMATCH, 'record.edgeSha256');
  if (record.ownerAuthorityPath !== ownerAuthorityPathFor(record.ownerAuthorityId)) finding(findings, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH, 'record.ownerAuthorityPath');
  if (findings.length > 0) return { valid: false, findings };

  const authorityIdentity = readIdentity(root, record.ownerAuthorityPath);
  if (!authorityIdentity) return { valid: false, findings: [{ code: SUCCESSOR_REFUSAL.OWNER_AUTHORITY_MISSING, detail: record.ownerAuthorityPath }] };
  if (authorityIdentity.sha256 !== record.ownerAuthoritySha256) {
    return { valid: false, findings: [{ code: SUCCESSOR_REFUSAL.OWNER_AUTHORITY_DIGEST_MISMATCH, detail: record.ownerAuthorityPath }] };
  }
  const authority = parseObject(authorityIdentity.bytes);
  const authorityShape = validatePublicationLineageSuccessorOwnerAuthorityShape(authority);
  if (!authorityShape.valid) return { valid: false, findings: authorityShape.findings };

  // The authority's half of the mutual binding: same identity, same record, same
  // gate, and the identical edge — by restated digest AND by recomputation.
  for (const [field, ok] of [
    ['authority.authorityId', authority.authorityId === record.ownerAuthorityId],
    ['authority.recordId', authority.recordId === record.recordId],
    ['authority.recordPath', authority.recordPath === recordPath],
    ['authority.gateId', authority.gateId === record.gateId],
    ['authority.edgeSha256', authority.edgeSha256 === record.edgeSha256],
    ['authority.edge', computeSuccessorEdgeSha256(authority.edge) === record.edgeSha256]
  ]) if (!ok) finding(findings, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH, field);
  if (findings.length > 0) return { valid: false, findings };

  const { predecessor, successor } = record.edge;
  if (predecessor.authorityPath === successor.authorityPath
      || predecessor.manifestPath === successor.manifestPath
      || predecessor.consumptionPath === successor.consumptionPath) {
    return { valid: false, findings: [{ code: SUCCESSOR_REFUSAL.CYCLE, detail: 'predecessor and successor are one publication' }] };
  }

  verifyPublicationSide({ root, gateId, edgePath: record.edge.path, side: predecessor, role: 'predecessor', findings });
  verifyPublicationSide({ root, gateId, edgePath: record.edge.path, side: successor, role: 'successor', findings });
  return { valid: findings.length === 0, findings };
}

/** The one collected candidate that IS this publication side, or a reason there is none. */
function matchCandidate(candidates, side) {
  const matches = [];
  candidates.forEach((candidate, index) => {
    if (candidate?.bindingClass === MAINTENANCE_PUBLICATION_BINDING_CLASS
        && candidate.authorityPath === side.authorityPath
        && candidate.authorityId === side.authorityId
        && candidate.manifestPath === side.manifestPath
        && candidate.manifestSha256 === side.manifestSha256
        && candidate.consumptionPath === side.consumptionPath
        && candidate.candidateSha256 === side.sha256
        && candidate.candidateByteLength === side.byteLength) matches.push(index);
  });
  return matches.length === 1 ? { index: matches[0] } : { index: -1 };
}

/** True when the directed graph over candidate indices contains any cycle. */
function hasCycle(nodeCount, adjacency) {
  const state = new Array(nodeCount).fill(0); // 0 unvisited, 1 on stack, 2 done
  const visit = (node) => {
    state[node] = 1;
    for (const next of adjacency[node]) {
      if (state[next] === 1) return true;
      if (state[next] === 0 && visit(next)) return true;
    }
    state[node] = 2;
    return false;
  };
  for (let node = 0; node < nodeCount; node += 1) if (state[node] === 0 && visit(node)) return true;
  return false;
}

/**
 * Which of `candidates` (the collected bindings for exactly `relativePath`) are
 * consumed by a valid successor edge. Returns binding objects from `candidates`
 * itself, so the caller can exclude them by identity and never by digest.
 *
 * `attributed` is false when no record names this gate and path; the caller then
 * behaves exactly as if this module did not exist.
 */
export function resolvePublicationLineageSuccessorConsumption({ root, gateId, path: relativePath, candidates }) {
  const none = { consumed: new Set(), attributed: false, report: null };
  const dir = path.resolve(root, ...RECORD_DIR.split('/'));
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) return none;
    names = fs.readdirSync(dir).sort();
  } catch { return none; }

  // Read the whole registry once. A file that cannot be scoped to a gate and path
  // leaves the registry UNREADABLE: it could be a conflicting branch for any path.
  let registryReadable = true;
  const ownerUse = new Map();
  const relevant = [];
  for (const name of names) {
    const recordPath = `${RECORD_DIR}/${name}`;
    const identity = name.endsWith('.json') ? readIdentity(root, recordPath) : null;
    const record = identity ? parseObject(identity.bytes) : undefined;
    if (!record || typeof record.gateId !== 'string' || typeof record.edge?.path !== 'string') { registryReadable = false; continue; }
    if (typeof record.ownerAuthorityPath === 'string') ownerUse.set(record.ownerAuthorityPath, (ownerUse.get(record.ownerAuthorityPath) ?? 0) + 1);
    if (record.gateId === gateId && record.edge.path === relativePath) relevant.push({ recordPath, record });
  }
  if (relevant.length === 0) return none;

  const applied = [];
  const refused = [];
  const edges = new Map(); // `${pred}>${succ}` -> { pred, succ }
  for (const { recordPath, record } of relevant) {
    const evaluation = evaluatePublicationLineageSuccessorRecord({ root, gateId, recordPath, record });
    if (!evaluation.valid) { refused.push({ recordPath, findings: evaluation.findings }); continue; }
    if (ownerUse.get(record.ownerAuthorityPath) !== 1) {
      refused.push({ recordPath, findings: [{ code: SUCCESSOR_REFUSAL.OWNER_AUTHORITY_REUSED, detail: record.ownerAuthorityPath }] });
      continue;
    }
    const pred = matchCandidate(candidates, record.edge.predecessor);
    const succ = matchCandidate(candidates, record.edge.successor);
    if (pred.index < 0 || succ.index < 0) {
      refused.push({ recordPath, findings: [{ code: SUCCESSOR_REFUSAL.PUBLICATION_NOT_ADMITTED, detail: pred.index < 0 ? 'predecessor' : 'successor' }] });
      continue;
    }
    edges.set(`${pred.index}>${succ.index}`, { pred: pred.index, succ: succ.index });
    applied.push({ recordPath, recordId: record.recordId, ownerAuthorityPath: record.ownerAuthorityPath, predecessorAuthorityPath: record.edge.predecessor.authorityPath, successorAuthorityPath: record.edge.successor.authorityPath });
  }

  const pathFindings = [];
  if (!registryReadable) finding(pathFindings, SUCCESSOR_REFUSAL.REGISTRY_UNREADABLE, RECORD_DIR);
  if (refused.length > 0) finding(pathFindings, SUCCESSOR_REFUSAL.PATH_REFUSED, `${refused.length} refused record(s) for this path`);

  const successorsOf = new Map();
  for (const { pred, succ } of edges.values()) {
    if (!successorsOf.has(pred)) successorsOf.set(pred, new Set());
    successorsOf.get(pred).add(succ);
  }
  if ([...successorsOf.values()].some((set) => set.size > 1)) finding(pathFindings, SUCCESSOR_REFUSAL.CONFLICTING_SUCCESSORS, relativePath);

  // The cycle check runs over the COMBINED graph: explicit edges plus the existing
  // pre-state chain among published (non-bootstrap) candidates. An explicit edge
  // that closes a loop with the causal chain would leave no terminal at all.
  const adjacency = candidates.map(() => []);
  const published = candidates.map((candidate) => candidate?.bootstrapOnly !== true);
  candidates.forEach((from, i) => {
    candidates.forEach((to, j) => {
      if (i !== j && published[i] && published[j] && typeof to?.prestateSha256 === 'string' && to.prestateSha256 === from?.candidateSha256) adjacency[i].push(j);
    });
  });
  for (const { pred, succ } of edges.values()) adjacency[pred].push(succ);
  if (edges.size > 0 && hasCycle(candidates.length, adjacency)) finding(pathFindings, SUCCESSOR_REFUSAL.CYCLE, relativePath);

  const accepted = pathFindings.length === 0 && edges.size > 0;
  const consumed = new Set(accepted ? [...edges.values()].map(({ pred }) => candidates[pred]) : []);
  return {
    consumed,
    attributed: true,
    report: {
      document: RESOLUTION_DOCUMENT,
      path: relativePath,
      accepted,
      applied: accepted ? applied : [],
      refused,
      findings: pathFindings
    }
  };
}
