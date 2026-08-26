#!/usr/bin/env node
/**
 * GENERATE_DEFERRED_CAPABILITY_INDEX — the lookup projection, and nothing more.
 *
 * WHY A PROJECTION EXISTS AT ALL. The canonical registry is an append-only
 * stream, which is the right shape for immutable history and the wrong shape for
 * the one question readiness actually asks: "what deferred capabilities target
 * GATE26?". Answering that from the stream means folding it on every call. This
 * generator folds it once into a resolved index.
 *
 * WHY THE INDEX IS NOT CANONICAL. `canonical: false`, deliberately and
 * permanently. The index is a convenience, never a trust root. Delete it and the
 * registry is unchanged; hand-edit it and `--check` says so; regenerate it and the
 * bytes come back identical. Every validator answer comes from replaying the
 * NDJSON, never from reading this file. That is what keeps a tampered projection
 * from being able to make a retired capability look open.
 *
 * DETERMINISM IS THE WHOLE CONTRACT. The index carries no timestamp and no
 * environment-dependent value: it is a pure function of the registry bytes and the
 * pinned vocabulary. The generation MOMENT lives in the provenance document
 * instead, so a drift check compares meaning rather than clocks. Every map is
 * built over sorted keys so two runs on two machines produce the same bytes.
 *
 * Local, offline, deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical-json.mjs';
import {
  REGISTRY_PATH, VOCABULARY_PATH, TERMINAL_DISPOSITIONS,
  parseRegistry, readVocabulary, replayRegistry
} from './validate-deferred-capability-registry.mjs';

export const INDEX_DOCUMENT = 'DEFERRED_CAPABILITY_INDEX';
export const INDEX_VERSION = 'V1';
export const INDEX_PATH = 'governance/generated/DEFERRED_CAPABILITY_INDEX_V1.json';
export const PROVENANCE_PATH = 'governance/generated/DEFERRED_CAPABILITY_INDEX_V1_PROVENANCE.json';
export const GENERATOR_PATH = 'governance/tools/generate-deferred-capability-index.mjs';

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function group(entries, keyOf) {
  const map = {};
  for (const entry of entries) {
    for (const key of [keyOf(entry)].flat()) {
      if (key === null || key === undefined) continue;
      (map[key] ??= []).push(entry.deferredCapabilityId);
    }
  }
  return Object.fromEntries(Object.keys(map).sort().map((key) => [key, map[key].slice().sort()]));
}

/**
 * The projection readiness consumes.
 *
 * An entry surfaces for GATExx when it is still OPEN and either names that gate
 * in mustRevisitByGate or names it inside an event-based trigger. A closed
 * disposition never surfaces: it has already been decided, and resurfacing it
 * would train readers to ignore the list.
 */
export function buildIndex({ entries, registrySha256, registryByteLength, eventCount, vocabularyVersion }) {
  const sorted = entries.slice().sort((left, right) => left.deferredCapabilityId.localeCompare(right.deferredCapabilityId, 'en'));
  const open = sorted.filter((entry) => !TERMINAL_DISPOSITIONS.includes(entry.disposition));
  return {
    document: INDEX_DOCUMENT,
    schemaVersion: 1,
    version: INDEX_VERSION,
    canonical: false,
    trustRoot: REGISTRY_PATH,
    trustStatement: 'Derived projection. Canonical truth is a replay of the registry stream; this file is never a trust root and never an authority.',
    generatedFrom: {
      path: REGISTRY_PATH,
      sha256: registrySha256,
      byteLength: registryByteLength,
      eventCount
    },
    reasonVocabularyVersion: vocabularyVersion,
    entryCount: sorted.length,
    openCommitmentCount: open.length,
    byId: Object.fromEntries(sorted.map((entry) => [entry.deferredCapabilityId, entry])),
    bySourceGate: group(sorted, (entry) => entry.sourceGate),
    byStatus: group(sorted, (entry) => entry.status),
    byDisposition: group(sorted, (entry) => entry.disposition),
    byConsumerCandidate: group(sorted, (entry) => entry.consumerCandidates ?? []),
    openCommitmentsByTargetGate: group(open, (entry) => {
      const targets = [];
      if (entry.mustRevisitByGate) targets.push(entry.mustRevisitByGate);
      const trigger = entry.eventBasedRevisitTrigger;
      if (typeof trigger === 'string') for (const match of trigger.matchAll(/GATE[0-9]{2}/g)) targets.push(match[0]);
      return [...new Set(targets)];
    }),
    entries: sorted
  };
}

export function generateDeferredCapabilityIndex({ root, now = new Date() }) {
  const registryFile = path.resolve(root, ...REGISTRY_PATH.split('/'));
  const registryBytes = fs.readFileSync(registryFile);
  const vocabulary = readVocabulary(root);
  const events = parseRegistry(registryBytes.toString('utf8'));
  const replay = replayRegistry({ events, vocabulary, root });

  const index = buildIndex({
    entries: replay.entries,
    registrySha256: sha256Bytes(registryBytes),
    registryByteLength: registryBytes.length,
    eventCount: replay.eventCount,
    vocabularyVersion: vocabulary.version
  });
  const indexBytes = Buffer.from(serialize(index), 'utf8');

  const generatorFile = path.resolve(root, ...GENERATOR_PATH.split('/'));
  const provenance = {
    canonical: false,
    generatedBy: GENERATOR_PATH,
    generatedFrom: [
      { path: REGISTRY_PATH, sha256: sha256Bytes(registryBytes), byteLength: registryBytes.length },
      { path: VOCABULARY_PATH, sha256: vocabulary.sha256 },
      { path: GENERATOR_PATH, sha256: fs.existsSync(generatorFile) ? sha256Bytes(fs.readFileSync(generatorFile)) : null }
    ],
    generatedAt: now.toISOString(),
    sourceDigest: sha256Bytes(registryBytes)
  };
  return { index, indexBytes, provenance, provenanceBytes: Buffer.from(serialize(provenance), 'utf8'), replay };
}

/**
 * Drift check.
 *
 * Compares the REGENERATED index bytes with what is on disk, and confirms the
 * provenance still pins the registry actually present. `generatedAt` is excluded
 * on purpose: a differing clock is not drift, and treating it as drift would make
 * the check cry wolf until nobody ran it.
 */
export function checkDeferredCapabilityIndex({ root, now = new Date() }) {
  const findings = [];
  const { indexBytes, provenance } = generateDeferredCapabilityIndex({ root, now });
  const indexFile = path.resolve(root, ...INDEX_PATH.split('/'));
  const provenanceFile = path.resolve(root, ...PROVENANCE_PATH.split('/'));

  if (!fs.existsSync(indexFile)) {
    findings.push({ code: 'GENERATED_INDEX_ABSENT', detail: INDEX_PATH });
  } else if (sha256Bytes(fs.readFileSync(indexFile)) !== sha256Bytes(indexBytes)) {
    findings.push({ code: 'GENERATED_INDEX_DRIFT', detail: INDEX_PATH });
  }

  if (!fs.existsSync(provenanceFile)) {
    findings.push({ code: 'GENERATED_PROVENANCE_ABSENT', detail: PROVENANCE_PATH });
  } else {
    const onDisk = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
    if (onDisk.canonical !== false) findings.push({ code: 'GENERATED_PROVENANCE_CANONICAL_INVALID' });
    if (onDisk.sourceDigest !== provenance.sourceDigest) {
      findings.push({ code: 'GENERATED_PROVENANCE_SOURCE_DIGEST_DRIFT', detail: provenance.sourceDigest });
    }
  }
  return { document: 'DEFERRED_CAPABILITY_INDEX_DRIFT_CHECK', verdict: findings.length === 0 ? 'CONSISTENT' : 'DRIFTED', findings };
}

export function writeDeferredCapabilityIndex({ root, now = new Date() }) {
  const { indexBytes, provenanceBytes } = generateDeferredCapabilityIndex({ root, now });
  const indexFile = path.resolve(root, ...INDEX_PATH.split('/'));
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, indexBytes);
  fs.writeFileSync(path.resolve(root, ...PROVENANCE_PATH.split('/')), provenanceBytes);
  return { indexPath: INDEX_PATH, provenancePath: PROVENANCE_PATH, indexSha256: sha256Bytes(indexBytes) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
  };
  const root = path.resolve(option('--root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  if (process.argv.includes('--check')) {
    const report = checkDeferredCapabilityIndex({ root });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.verdict === 'CONSISTENT' ? 0 : 2;
  } else {
    const report = writeDeferredCapabilityIndex({ root });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}
