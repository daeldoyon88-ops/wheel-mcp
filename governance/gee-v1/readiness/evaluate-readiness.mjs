import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { validateStrategicContract } from '../contracts/validate-strategic-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';
import { validateActivationAnchor } from '../contracts/validate-activation-anchor.mjs';
import { isReadinessContext } from './build-readiness-context.mjs';

function check(checks, errors, id, ok, critical, message) {
  checks.push({
    id,
    status: ok ? 'PASS' : 'FAIL',
    critical,
    message
  });
  if (!ok && critical) errors.push(`${id}: ${message}`);
}

/**
 * Definition-of-Ready evaluator.
 * Does NOT execute the work unit — only verifies it is sufficiently defined.
 * Verdict is strictly READY or BLOCKED.
 * Fail-closed: UNKNOWN / ABSENT critical evidence never becomes PASS.
 */
/**
 * Strict path: input is a branded ReadinessContext produced ONLY by
 * ../readiness/build-readiness-context.mjs. Every critical proof is already a
 * four-state PROVEN|FAILED|UNKNOWN|NOT_APPLICABLE derived from canonical
 * state — there is no optional parameter here for a caller to forget.
 * RC-4 / ACT-09 / ACT-12: UNKNOWN always FAILs a critical check; only a
 * builder-asserted NOT_APPLICABLE ever produces SKIP.
 */
function evaluateReadinessFromContext(context) {
  const checks = [];
  const errors = [];
  const warnings = [];

  const { strategicContract, executionContract, executionSeal, prerequisiteStatuses, requireSeal, proofs, workUnitId } = context;

  const strategicResult = strategicContract
    ? validateStrategicContract(strategicContract)
    : { valid: false, findings: [{ detectorId: 'MISSING_STRATEGIC_CONTRACT', message: 'strategic contract absent' }] };
  check(checks, errors, 'STRATEGIC_CONTRACT', strategicResult.valid, true,
    strategicResult.valid ? 'strategic contract valid' : 'strategic contract invalid or missing');
  check(checks, errors, 'OBJECTIVE',
    Boolean(strategicContract) && typeof strategicContract.objective === 'string' && strategicContract.objective.trim().length > 0,
    true, strategicContract ? 'objective present' : 'objective absent');

  const executionResult = executionContract
    ? validateExecutionContract(executionContract)
    : { valid: false, findings: [{ detectorId: 'MISSING_EXECUTION_CONTRACT', message: 'execution contract absent' }] };
  check(checks, errors, 'EXECUTION_CONTRACT', executionResult.valid, true,
    executionResult.valid ? 'execution contract valid' : 'execution contract invalid or missing');

  if (executionContract) {
    check(checks, errors, 'CLOSURE_CONDITIONS',
      Array.isArray(executionContract.closureConditions) && executionContract.closureConditions.length > 0, true, 'closure conditions declared');
    check(checks, errors, 'INVARIANTS',
      Array.isArray(executionContract.invariants) && executionContract.invariants.length > 0, true, 'invariants declared');
    check(checks, errors, 'REQUIRED_ARTIFACTS',
      Array.isArray(executionContract.requiredArtifacts) && executionContract.requiredArtifacts.length > 0, true, 'required artifacts declared');
    check(checks, errors, 'POSITIVE_TESTS',
      Array.isArray(executionContract.requiredTests) && executionContract.requiredTests.length > 0, true, 'positive tests declared');
    check(checks, errors, 'NEGATIVE_TESTS',
      Array.isArray(executionContract.requiredNegativeTests) && executionContract.requiredNegativeTests.length > 0, true, 'negative tests declared');
    check(checks, errors, 'HOSTILE_OR_COUNTER_TESTS',
      Array.isArray(executionContract.requiredHostileOrCounterTests) && executionContract.requiredHostileOrCounterTests.length > 0, true, 'hostile/counter-tests declared');
    check(checks, errors, 'EVIDENCE_REQUIREMENTS',
      Array.isArray(executionContract.evidenceRequirements) && executionContract.evidenceRequirements.length > 0, true, 'evidence requirements declared');
    check(checks, errors, 'AUTHORIZED_VERDICTS',
      Array.isArray(executionContract.authorizedVerdicts) && executionContract.authorizedVerdicts.length > 0, true, 'authorized verdicts declared');

    const prereqs = Array.isArray(executionContract.prerequisites) ? executionContract.prerequisites : [];
    let prereqOk = true;
    for (const prereq of prereqs) {
      if (!prereq.critical) continue;
      if ((prerequisiteStatuses || {})[prereq.id] !== 'SATISFIED') {
        prereqOk = false;
        errors.push(`PREREQUISITE:${prereq.id}: not SATISFIED`);
      }
    }
    check(checks, errors, 'CRITICAL_PREREQUISITES', prereqOk, true,
      prereqOk ? 'critical prerequisites satisfied' : 'one or more critical prerequisites unsatisfied');
  } else {
    check(checks, errors, 'CLOSURE_CONDITIONS', false, true, 'closure conditions absent');
    check(checks, errors, 'CRITICAL_PREREQUISITES', false, true, 'cannot evaluate prerequisites without execution contract');
  }

  if (requireSeal) {
    if (!executionSeal) {
      check(checks, errors, 'EXECUTION_SEAL', false, true, 'execution contract seal missing');
    } else if (executionContract) {
      const mutation = detectSealedMutation(executionContract, executionSeal, {});
      check(checks, errors, 'EXECUTION_SEAL', mutation.status === 'INTACT', true,
        mutation.status === 'INTACT' ? 'sealed execution contract intact' : `seal status=${mutation.status}`);
    }
  } else {
    checks.push({ id: 'EXECUTION_SEAL', status: 'SKIP', critical: false, message: 'seal not required for this work unit' });
  }

  for (const [id, mapCritical] of [['ACTIVATION_ANCHOR', true], ['AUTHORITY_STATE', true], ['OPEN_DEFECTS', true], ['PREFLIGHT', true]]) {
    const p = proofs[id];
    if (p.state === 'NOT_APPLICABLE') {
      checks.push({ id, status: 'SKIP', critical: false, message: p.reason || `${id} not applicable` });
    } else if (p.state === 'PROVEN') {
      check(checks, errors, id, true, mapCritical, p.reason || `${id} proven`);
    } else {
      // FAILED or UNKNOWN both fail-closed: UNKNOWN is never treated as PASS.
      check(checks, errors, id, false, mapCritical, p.reason || `${id} ${p.state.toLowerCase()}`);
    }
  }

  const blocked = checks.some((c) => c.critical && c.status === 'FAIL');
  return {
    schemaVersion: 1,
    workUnitId,
    verdict: blocked ? 'BLOCKED' : 'READY',
    // FINAL-10/13: the ONLY path that can produce an authoritative modern verdict is the strict,
    // branded ReadinessContext path (buildReadinessContext -> evaluateReadinessFromContext). This
    // marker is what lets a caller tell the two calling conventions apart from the result alone.
    authoritative: true,
    contextKind: 'STRICT',
    checks,
    errors,
    warnings
  };
}

/**
 * Definition-of-Ready evaluator.
 * Does NOT execute the work unit — only verifies it is sufficiently defined.
 * Verdict is strictly READY or BLOCKED.
 * Fail-closed: UNKNOWN / ABSENT critical evidence never becomes PASS.
 *
 * Two calling conventions:
 *  - a branded ReadinessContext from build-readiness-context.mjs (strict path,
 *    used by the real CLI for real work units — no optional evidence flags);
 *  - a plain options object (legacy path, preserved for direct unit testing
 *    of the check bodies below with synthetic fixtures).
 */
export function evaluateReadiness(input = {}) {
  if (isReadinessContext(input)) {
    return evaluateReadinessFromContext(input);
  }
  const {
    workUnitId = 'UNKNOWN',
    strategicContract = null,
    executionContract = null,
    executionSeal = null,
    prerequisiteStatuses = {},
    authorityState = null,
    requireSeal = true,
    defectsOpenCount,
    defectsOpenKnowledge,
    activationState = null,
    activationAnchor = null,
    requireActivationAnchor = false
  } = input;

  // preflightOk must be EXPLICITLY provided; absence is UNKNOWN, not TRUE.
  const preflightProvided = Object.prototype.hasOwnProperty.call(input, 'preflightOk');
  const preflightOk = preflightProvided ? input.preflightOk : undefined;

  const checks = [];
  const errors = [];
  const warnings = [];

  const strategicResult = strategicContract
    ? validateStrategicContract(strategicContract)
    : { valid: false, findings: [{ detectorId: 'MISSING_STRATEGIC_CONTRACT', message: 'strategic contract absent' }] };
  check(checks, errors, 'STRATEGIC_CONTRACT', strategicResult.valid, true,
    strategicResult.valid ? 'strategic contract valid' : 'strategic contract invalid or missing');

  if (strategicContract) {
    check(checks, errors, 'OBJECTIVE', typeof strategicContract.objective === 'string' && strategicContract.objective.trim().length > 0, true,
      'objective present');
  } else {
    check(checks, errors, 'OBJECTIVE', false, true, 'objective absent');
  }

  const executionResult = executionContract
    ? validateExecutionContract(executionContract)
    : { valid: false, findings: [{ detectorId: 'MISSING_EXECUTION_CONTRACT', message: 'execution contract absent' }] };
  check(checks, errors, 'EXECUTION_CONTRACT', executionResult.valid, true,
    executionResult.valid ? 'execution contract valid' : 'execution contract invalid or missing');

  if (executionContract) {
    check(checks, errors, 'CLOSURE_CONDITIONS',
      Array.isArray(executionContract.closureConditions) && executionContract.closureConditions.length > 0,
      true, 'closure conditions declared');
    check(checks, errors, 'INVARIANTS',
      Array.isArray(executionContract.invariants) && executionContract.invariants.length > 0,
      true, 'invariants declared');
    check(checks, errors, 'REQUIRED_ARTIFACTS',
      Array.isArray(executionContract.requiredArtifacts) && executionContract.requiredArtifacts.length > 0,
      true, 'required artifacts declared');
    check(checks, errors, 'POSITIVE_TESTS',
      Array.isArray(executionContract.requiredTests) && executionContract.requiredTests.length > 0,
      true, 'positive tests declared');
    check(checks, errors, 'NEGATIVE_TESTS',
      Array.isArray(executionContract.requiredNegativeTests) && executionContract.requiredNegativeTests.length > 0,
      true, 'negative tests declared');
    check(checks, errors, 'HOSTILE_OR_COUNTER_TESTS',
      Array.isArray(executionContract.requiredHostileOrCounterTests) && executionContract.requiredHostileOrCounterTests.length > 0,
      true, 'hostile/counter-tests declared');
    check(checks, errors, 'EVIDENCE_REQUIREMENTS',
      Array.isArray(executionContract.evidenceRequirements) && executionContract.evidenceRequirements.length > 0,
      true, 'evidence requirements declared');
    check(checks, errors, 'AUTHORIZED_VERDICTS',
      Array.isArray(executionContract.authorizedVerdicts) && executionContract.authorizedVerdicts.length > 0,
      true, 'authorized verdicts declared');

    const prereqs = Array.isArray(executionContract.prerequisites) ? executionContract.prerequisites : [];
    let prereqOk = true;
    for (const prereq of prereqs) {
      if (!prereq.critical) continue;
      const status = prerequisiteStatuses[prereq.id];
      if (status !== 'SATISFIED') {
        prereqOk = false;
        errors.push(`PREREQUISITE:${prereq.id}: not SATISFIED`);
      }
    }
    check(checks, errors, 'CRITICAL_PREREQUISITES', prereqOk, true,
      prereqOk ? 'critical prerequisites satisfied' : 'one or more critical prerequisites unsatisfied');
  } else {
    check(checks, errors, 'CLOSURE_CONDITIONS', false, true, 'closure conditions absent');
    check(checks, errors, 'CRITICAL_PREREQUISITES', false, true, 'cannot evaluate prerequisites without execution contract');
  }

  if (requireSeal) {
    if (!executionSeal) {
      check(checks, errors, 'EXECUTION_SEAL', false, true, 'execution contract seal missing');
    } else if (executionContract) {
      const mutation = detectSealedMutation(executionContract, executionSeal, {
        activationState,
        activationAnchor,
        requireActivationAnchor
      });
      check(checks, errors, 'EXECUTION_SEAL', mutation.status === 'INTACT', true,
        mutation.status === 'INTACT' ? 'sealed execution contract intact' : `seal status=${mutation.status}`);
    }
  } else {
    checks.push({ id: 'EXECUTION_SEAL', status: 'SKIP', critical: false, message: 'seal not required by caller' });
  }

  // ACTIVATION_ANCHOR: mandatory when activated / requireActivationAnchor; otherwise NOT_APPLICABLE (no false sealed-activated).
  const anchor = validateActivationAnchor({
    contract: executionContract,
    seal: executionSeal,
    activationAnchor,
    activationState,
    requireActivationAnchor
  });
  if (anchor.status === 'NOT_APPLICABLE') {
    checks.push({
      id: 'ACTIVATION_ANCHOR',
      status: 'SKIP',
      critical: false,
      message: 'work unit not activated — freeze anchor not applicable'
    });
  } else {
    check(
      checks,
      errors,
      'ACTIVATION_ANCHOR',
      anchor.status === 'INTACT',
      true,
      anchor.status === 'INTACT'
        ? 'immutable activation anchor intact'
        : `activation anchor status=${anchor.status}`
    );
  }

  // AUTHORITY_STATE: must be explicitly demonstrated as consistent === true.
  // Absent / null / unknown never becomes PASS.
  if (!authorityState || typeof authorityState !== 'object' || Array.isArray(authorityState)) {
    check(checks, errors, 'AUTHORITY_STATE', false, true, 'authorityState absent or unknown');
  } else if (authorityState.consistent !== true) {
    check(checks, errors, 'AUTHORITY_STATE', false, true,
      authorityState.reason || 'authority/state not explicitly consistent');
  } else {
    check(checks, errors, 'AUTHORITY_STATE', true, true, 'authority/state explicitly consistent');
  }

  // PREFLIGHT: TRUE / FALSE / UNKNOWN — UNKNOWN never becomes TRUE.
  if (!preflightProvided) {
    check(checks, errors, 'PREFLIGHT', false, true, 'preflight absent or unknown');
  } else if (preflightOk === true) {
    check(checks, errors, 'PREFLIGHT', true, true, 'preflight conditions ok');
  } else {
    check(checks, errors, 'PREFLIGHT', false, true,
      preflightOk === false ? 'preflight failed' : 'preflight not explicitly true');
  }

  // OPEN_DEFECTS: ALWAYS evaluated. Absent input => UNKNOWN => FAIL (never omitted).
  {
    const knowledgeProvided = Object.prototype.hasOwnProperty.call(input, 'defectsOpenKnowledge');
    const countProvided = Object.prototype.hasOwnProperty.call(input, 'defectsOpenCount');
    let knowledge;
    if (knowledgeProvided) {
      knowledge = defectsOpenKnowledge || 'UNKNOWN';
    } else if (countProvided) {
      knowledge = (defectsOpenCount === null || defectsOpenCount === undefined)
        ? 'UNKNOWN'
        : (defectsOpenCount === 0 ? 'KNOWN_ZERO' : 'KNOWN_NONZERO');
    } else {
      knowledge = 'UNKNOWN';
    }

    const absent = !knowledgeProvided && !countProvided;
    if (absent || knowledge === 'UNKNOWN') {
      check(checks, errors, 'OPEN_DEFECTS', false, true, 'open defects state UNKNOWN — absence is not zero');
    } else if (knowledge === 'KNOWN_NONZERO' || (typeof defectsOpenCount === 'number' && defectsOpenCount > 0)) {
      check(checks, errors, 'OPEN_DEFECTS', false, true,
        `open defects present: ${typeof defectsOpenCount === 'number' ? defectsOpenCount : 'nonzero'}`);
    } else if (knowledge === 'KNOWN_ZERO' || defectsOpenCount === 0) {
      check(checks, errors, 'OPEN_DEFECTS', true, true, 'open defects known zero');
    } else {
      check(checks, errors, 'OPEN_DEFECTS', false, true, 'open defects state UNKNOWN — absence is not zero');
    }
  }

  const blocked = checks.some((c) => c.critical && c.status === 'FAIL');
  return {
    schemaVersion: 1,
    workUnitId,
    // FINAL-10/13: this legacy plain-object calling convention exists only for direct unit testing
    // of the check bodies with synthetic fixtures (see module doc above). Its verdict is NEVER
    // authoritative for a real work unit — authoritative:false makes that explicit in the result
    // itself, so no caller can mistake this for the strict-context modern verdict, no matter what
    // `verdict` says.
    verdict: blocked ? 'BLOCKED' : 'READY',
    authoritative: false,
    contextKind: 'LEGACY_NON_AUTHORITATIVE',
    checks,
    errors,
    warnings
  };
}
