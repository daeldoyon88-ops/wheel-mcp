/**
 * Wheel adapter — external authority policy for governance/tools/validate-status-ledger.mjs.
 *
 * RC-3 de-Wheelification: the core ledger validator no longer hardcodes a single
 * GATE12-shaped document check for COMPLETE_CONFIRMED. This policy supplies:
 *
 *  - extraExternalAuthorities: additional EXTERNAL_REINSPECTION_REPORT declarations,
 *    separate from the frozen, untouched GENESIS_IMPORT_SOURCE_MAP.json. Each entry still
 *    requires its live bytes to hash-match the declared sha256 — this policy only names
 *    candidates, it never forgives a hash mismatch.
 *
 *  - assertExternalReinspectionVerdict: replaces the single hardcoded
 *    `document === 'GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT'` check with a
 *    per-authorityId rule, so a real, independently-produced verdict document for a
 *    DIFFERENT work unit (a different report shape entirely) can also satisfy the
 *    COMPLETE_CONFIRMED requirement — bound explicitly to the gateId it was produced for,
 *    never inferred.
 *
 * The GATE13 entry below cites governance/authority/snapshots/
 * GATE13_INDEPENDENT_AUDIT_R1_14_INDEPENDENT_VERDICT.json, a byte-identical, in-repo,
 * content-addressed copy of the independent audit's own verdict record
 * (14_INDEPENDENT_VERDICT.json under the audit's out-of-repo TEMP run root). Its sha256
 * (91b397...) is the SAME value STATE_SEAL R0002 already pins as
 * payload.independentVerdictSha256 — this policy does not introduce new evidence, it makes
 * evidence the seal already cites usable by the ledger's transition-authority resolver.
 */

const STANDARD_EXTERNAL_REINSPECTION_REPORT = 'STANDARD_EXTERNAL_REINSPECTION_REPORT';

const EXTERNAL_REINSPECTION_DECLARATIONS = Object.freeze([
    {
      authorityId: 'WHEEL-GATE13-INDEPENDENT-VERDICT-20260808-093157',
      classification: 'EXTERNAL_REINSPECTION_REPORT',
      path: 'governance/authority/snapshots/GATE13_INDEPENDENT_AUDIT_R1_14_INDEPENDENT_VERDICT.json',
      sha256: '91b397803b51d72dbe57c7ba804336bf3a3b6ac7a477909217d8ef79351ee352'
    },
    {
      authorityId: 'GATE14_INDEPENDENT_EXTERNAL_CONFIRMATION_FINAL_R1_EXTERNAL_REINSPECTION_REPORT',
      classification: 'EXTERNAL_REINSPECTION_REPORT',
      path: 'governance/sources/GATE14_INDEPENDENT_EXTERNAL_CONFIRMATION_FINAL_R1_EXTERNAL_REINSPECTION_REPORT.json',
      sha256: '3ad09d730d319641b685a95ec385f510edf6e4b4ad8df40bdd31460faf88a4ee',
      gateId: 'GATE14',
      programId: 'GATE14_INDEPENDENT_EXTERNAL_CONFIRMATION_FINAL_R1',
      reportShape: STANDARD_EXTERNAL_REINSPECTION_REPORT
    },
    {
      authorityId: 'GATE15_M3_INDEPENDENT_EXTERNAL_CONFIRMATION_R1_EXTERNAL_REINSPECTION_REPORT',
      classification: 'EXTERNAL_REINSPECTION_REPORT',
      path: 'governance/sources/GATE15_M3_INDEPENDENT_EXTERNAL_CONFIRMATION_R1_EXTERNAL_REINSPECTION_REPORT.json',
      sha256: '2d94b9ca982ed9d3752e84b38ecfbb9ae5eb5c6267969acbaff2fa838b329c9f',
      gateId: 'GATE15',
      programId: 'GATE15_M3_INDEPENDENT_REINSPECTION_EXTERNAL_CONFIRMATION',
      reportShape: STANDARD_EXTERNAL_REINSPECTION_REPORT
    }
  ]);

export const WHEEL_EXTERNAL_AUTHORITY_POLICY = Object.freeze({
  extraExternalAuthorities: EXTERNAL_REINSPECTION_DECLARATIONS,
  assertExternalReinspectionVerdict({ event, report, authorityId }) {
    // Legacy shape, preserved exactly: GATE12's own genesis-imported reinspection report.
    if (authorityId === 'SRC-R1-EXTERNAL-PASS') {
      return report?.VERDICT === 'PASS' && report?.document === 'GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT';
    }
    // GATE13's real independent verdict — a differently-shaped, genuinely independent
    // document — bound explicitly to GATE13 and never inferred from event.gateId alone.
    if (authorityId === 'WHEEL-GATE13-INDEPENDENT-VERDICT-20260808-093157') {
      return event?.gateId === 'GATE13' && report?.INDEPENDENT_AUDIT === 'PASS' && report?.PHASE_B_AUTHORIZED === true;
    }
    const declaration = EXTERNAL_REINSPECTION_DECLARATIONS.find((candidate) => candidate.authorityId === authorityId);
    if (declaration?.reportShape === STANDARD_EXTERNAL_REINSPECTION_REPORT) {
      return event?.gateId === declaration.gateId
        && report?.document === 'EXTERNAL_REINSPECTION_REPORT'
        && report?.gateId === declaration.gateId
        && report?.verdict === 'PASS'
        && report?.independentSession === true
        && report?.programId === declaration.programId;
    }
    return false;
  }
});
