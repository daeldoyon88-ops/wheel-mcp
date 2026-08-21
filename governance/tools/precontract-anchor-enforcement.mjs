/**
 * PRECONTRACT ANCHOR ENFORCEMENT — one decision, two consumers.
 *
 * WHAT THIS EXISTS TO CLOSE. A precontract bootstrap consumed its receipt and
 * produced a proof that was valid AT ITS OWN PRE-STATE. Nothing then required
 * that proof to be anchored in the append-only ledger before the Gate's first
 * lifecycle event, and `anchor-precontract-consumption.mjs` — which exists and
 * works — had NO CALLER anywhere in the engine. So a Gate could bootstrap,
 * AUTHORIZE, START and close while its receipt quietly stopped verifying: the
 * pre-state the receipt was proven against had scrolled away underneath it.
 *
 * The result was a repository whose two canonical consumers disagreed:
 *
 *   FINAL_GATE_INTEGRITY   PASS
 *   VERIFY_CONSUMPTION     BLOCKED / CONSUMPTION_RECEIPT_NOT_ANCHORED
 *
 * A final audit that passes while the consumption consumer blocks is not a
 * weaker audit, it is a WRONG one — it certifies a Gate whose bootstrap proof no
 * longer holds.
 *
 * WHY THE DECISION LIVES HERE AND NOWHERE ELSE. The obvious repair — teach the
 * auditor to look for an anchor event — is the one thing that must not be done.
 * Two hand-written implementations of "is this consumption anchored" drift, and
 * the drift reintroduces exactly the contradiction being closed. So this module
 * OWNS NO RULE. It locates the Gate's precontract authority through the
 * primitive that defines that location, asks the canonical consumer
 * `verifyPrecontractConsumption` for the verdict, and reports what it was told.
 * Every enforcement site imports this function, so a consumer cannot contradict
 * the canonical consumer without contradicting itself.
 *
 * APPLICABILITY IS NOT A POLICY EITHER. A Gate is subject to this rule when it
 * HAS a local precontract authority at its canonical path — that document is
 * what declares the Gate was bootstrapped this way. A Gate without one was never
 * bootstrapped from a precontract and is NOT_APPLICABLE, which contributes
 * nothing and blocks nothing. That is what keeps the rule general: no Gate is
 * named anywhere in this file, and no Gate is exempted from it either.
 */
import fs from 'node:fs';
import path from 'node:path';

import { precontractLocalAuthorityPath } from '../gee-v1/core/precontract-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';

export const ANCHOR_ENFORCEMENT_DOCUMENT = 'PRECONTRACT_ANCHOR_ENFORCEMENT';

/** The blocking code every enforcement site reports, so one grep finds them all. */
export const ANCHOR_ENFORCEMENT_BLOCKING_CODE = 'PRECONTRACT_CONSUMPTION_NOT_ANCHORED';

/** What an agent must run to clear the block, stated once rather than remembered. */
export const ANCHOR_REMEDIATION = 'node governance/tools/anchor-precontract-consumption.mjs --root . --authority <GATE_ANCHOR_AUTHORITY> --apply';

function fileExists(root, relativePath) {
  try {
    const resolved = path.resolve(root, ...relativePath.split('/'));
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch { return false; }
}

/**
 * Is this Gate's precontract consumption anchored, and may the lifecycle proceed?
 *
 * @param {object} options
 * @param {string} options.root    repository root
 * @param {string} options.gateId  the Gate under evaluation
 * @returns {{
 *   document: string, gateId: string, applicable: boolean, authorityPath: string|null,
 *   verdict: 'NOT_APPLICABLE'|'ANCHORED'|'BLOCKED', anchored: boolean,
 *   lifecycleProgressionAuthorized: boolean,
 *   findings: Array<{code: string, detail?: any}>, remediation: string|null
 * }}
 */
export function evaluatePrecontractAnchorEnforcement({ root, gateId }) {
  const base = { document: ANCHOR_ENFORCEMENT_DOCUMENT, gateId: gateId ?? null };
  if (typeof gateId !== 'string' || !gateId) {
    return {
      ...base, applicable: false, authorityPath: null, verdict: 'NOT_APPLICABLE',
      anchored: false, lifecycleProgressionAuthorized: true, findings: [], remediation: null
    };
  }

  // The location comes from the primitive that owns the document, never from a
  // literal here: a consumer that spells the path itself is how a consumer comes
  // to disagree with the primitive about where the authority lives.
  const authorityPath = precontractLocalAuthorityPath(gateId);
  if (!fileExists(root, authorityPath)) {
    return {
      ...base, applicable: false, authorityPath: null, verdict: 'NOT_APPLICABLE',
      anchored: false, lifecycleProgressionAuthorized: true, findings: [], remediation: null
    };
  }

  // The canonical consumer decides. Its findings are carried through verbatim —
  // re-deriving, re-wording or filtering them here would be a second opinion, and
  // a second opinion is the defect this module exists to prevent.
  let result;
  try {
    const source = createWheelPrecontractAuthoritySource(path.resolve(root), {
      authorityPath: path.resolve(root, ...authorityPath.split('/'))
    });
    result = source.verifyPrecontractConsumption(gateId);
  } catch (error) {
    return {
      ...base, applicable: true, authorityPath, verdict: 'BLOCKED', anchored: false,
      lifecycleProgressionAuthorized: false,
      findings: [{ code: ANCHOR_ENFORCEMENT_BLOCKING_CODE, detail: `CONSUMER_THREW:${error.message}` }],
      remediation: ANCHOR_REMEDIATION
    };
  }

  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const anchored = findings.length === 0 && result?.consumed === true;
  return {
    ...base,
    applicable: true,
    authorityPath,
    verdict: anchored ? 'ANCHORED' : 'BLOCKED',
    anchored,
    lifecycleProgressionAuthorized: anchored,
    findings: anchored ? [] : [{ code: ANCHOR_ENFORCEMENT_BLOCKING_CODE, detail: findings.map((entry) => entry.code) }],
    remediation: anchored ? null : ANCHOR_REMEDIATION
  };
}
