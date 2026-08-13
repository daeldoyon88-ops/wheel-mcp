#!/usr/bin/env node
/**
 * Executable verifier for the legacy 57/58 state bindings (H5).
 *
 * Reads real bytes for every claim: the ledger prefix, the event, the cited
 * authority, and the sealed revision. A binding survives only where it agrees
 * with all of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  evaluateLegacyStateBinding,
  validateLegacyStateBindingsDocument
} from '../gee-v1/core/legacy-state-binding.mjs';
import { reconstructLedgerPrefixBytes } from './validate-status-ledger.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const bindingsPath = path.resolve(option('--bindings', path.join(root, 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json')));
const ledgerPath = path.resolve(option('--ledger', path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson')));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readBytes = (relative) => {
  const abs = path.resolve(root, ...String(relative).split('/'));
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs) : null;
};

const findings = [];
const results = [];
let document = null;
let events = [];
try {
  document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8').replace(/^﻿/, ''));
  events = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
} catch (error) {
  findings.push({ code: 'INPUT_UNREADABLE', detail: error?.message || String(error) });
}

if (document) {
  const shape = validateLegacyStateBindingsDocument(document);
  findings.push(...shape.findings);
  let predecessorSealSha256 = null;
  for (const binding of document.bindings || []) {
    const event = events.find((candidate) => candidate.ordinal === binding.eventOrdinal) ?? null;
    const authorityBytes = readBytes(binding.originalAuthorityPath);
    const sealBytes = readBytes(binding.stateRevisionSealPath);
    let sealJson = null;
    try { sealJson = sealBytes ? JSON.parse(sealBytes.toString('utf8')) : null; } catch { sealJson = null; }
    let ledgerPrefixSha256 = null;
    try { ledgerPrefixSha256 = sha256(reconstructLedgerPrefixBytes(ledgerPath, binding.eventOrdinal)); } catch { ledgerPrefixSha256 = null; }

    const evaluation = evaluateLegacyStateBinding({
      binding,
      legacyEraMaxOrdinal: document.legacyEraMaxOrdinal,
      evidence: {
        event,
        ledgerPrefixSha256,
        authoritySha256: authorityBytes ? sha256(authorityBytes) : null,
        seal: sealBytes ? { sha256: sha256(sealBytes), byteLength: sealBytes.length, json: sealJson } : null,
        predecessorSealSha256
      }
    });
    findings.push(...evaluation.findings);
    results.push({
      eventOrdinal: binding.eventOrdinal, eventId: binding.eventId,
      stateRevision: binding.stateRevision, decision: evaluation.decision,
      grantsPermission: false
    });
    predecessorSealSha256 = binding.stateRevisionSealSha256;
  }
}

const valid = findings.length === 0;
process.stdout.write(JSON.stringify({
  document: 'LEGACY_STATE_BINDING_VALIDATION',
  valid,
  legacyEraMaxOrdinal: document?.legacyEraMaxOrdinal ?? null,
  bindings: results,
  grantsNoPermission: true,
  findings
}, null, 2) + '\n');
process.exitCode = valid ? 0 : 2;
