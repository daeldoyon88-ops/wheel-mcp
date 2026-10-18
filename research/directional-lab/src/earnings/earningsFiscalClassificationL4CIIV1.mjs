/**
 * L4C-I2 fiscal period classification for one earnings revision.
 *
 * Every fiscal fact is read from the DEI metadata of the revision's own pinned
 * bytes. No fiscal calendar is consulted, no period length is inferred from a
 * day count, no comparative period is admitted, and no raw period is ever
 * mutated. When a role cannot be proven from the source, the classifier
 * diagnoses and omits rather than guessing.
 *
 * Role assignment (policy DECLARED_FOCUS_WITH_RELATIONAL_SPAN_ORDER_V1):
 *   Q1  1 duration  -> QUARTER/Q1 (SOURCE_ATTESTED, DECLARED_FOCUS)
 *                      + YEAR_TO_DATE/Q1 (POLICY_INFERRED, Q1_DUAL_ROLE)
 *   Q1  2 durations -> EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS, emit nothing
 *   Q2/Q3 2 durations -> shorter QUARTER, longer YEAR_TO_DATE,
 *                        both POLICY_INFERRED / RELATIONAL_SPAN_ORDER
 *   Q2/Q3 1 duration  -> EARNINGS_FISCAL_ROLE_UNDETERMINED, emit nothing
 *   Q4  1 duration  -> QUARTER/Q4 (SOURCE_ATTESTED, DECLARED_FOCUS)
 *   Q4  >1 duration -> EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS per raw
 *                      period, emit nothing, status PARTIAL
 *   FY  1 duration  -> FISCAL_YEAR/FY (SOURCE_ATTESTED, DECLARED_FOCUS)
 *   FY  2 durations -> longer FISCAL_YEAR/FY (POLICY_INFERRED,
 *                      RELATIONAL_SPAN_ORDER); shorter unclassified with
 *                      EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
  EARNINGS_STRUCTURED_DOCUMENT_ROLES,
  normalizeFinancialPeriodIdentityCoreV1,
  normalizeSecFilingSourceDocumentCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import {
  EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
  allowedFocusValuesForFormType,
  earningsFiscalClassificationDiagnosticDigestV1,
  normalizeEarningsFiscalClassificationReportV1,
  normalizeEarningsFiscalPeriodClassificationCoreV1,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsFiscalClassificationPolicy } from './earningsFiscalClassificationPolicyL4CIIV1.mjs';
import { readEarningsFiscalMetadataFromPinnedBytesV1 } from './earningsFiscalMetadataL4CIIV1.mjs';

/**
 * Verify one stored EarningsFiscalPeriodClassificationCore/1.
 * @param {{store: unknown, earningsFiscalPeriodClassificationId: string}} input
 */
export function verifyEarningsFiscalPeriodClassificationCore(input) {
  const api = assertApiInput(input, ['earningsFiscalPeriodClassificationId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertCasId(api.earningsFiscalPeriodClassificationId, 'earningsFiscalPeriodClassificationId');
  let core;
  try {
    core = normalizeEarningsFiscalPeriodClassificationCoreV1(readTypedReference(api.store,
      api.earningsFiscalPeriodClassificationId,
      EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
      'earnings fiscal period classification'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
      && (cause.code === 'EARNINGS_FISCAL_CLASSIFICATION_INVALID'
        || cause.code === 'EARNINGS_FISCAL_SOURCE_FACT_TAGS_INVALID'
        || cause.code === 'EARNINGS_FISCAL_YEAR_FOCUS_INVALID')) {
      throw cause;
    }
    throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_MISSING',
      'earnings fiscal period classification is missing or corrupt', { cause });
  }
  return {
    earningsFiscalPeriodClassificationId: api.earningsFiscalPeriodClassificationId,
    earningsFiscalPeriodClassification: core,
  };
}

/** Span in whole days between two civil dates, used only to order two spans. */
function spanDays(periodStart, periodEnd) {
  const start = Date.UTC(...periodStart.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const end = Date.UTC(...periodEnd.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round((end - start) / 86400000);
}

/**
 * Order two eligible durations by span, longest last. Ties are broken on the
 * pinned raw period id so the result never depends on insertion order.
 */
function bySpanThenId(left, right) {
  if (left.spanDays !== right.spanDays) return left.spanDays - right.spanDays;
  if (left.financialPeriodIdentityId < right.financialPeriodIdentityId) return -1;
  if (left.financialPeriodIdentityId > right.financialPeriodIdentityId) return 1;
  return 0;
}

function readRawPeriod(store, financialPeriodIdentityId) {
  const raw = normalizeFinancialPeriodIdentityCoreV1(readTypedReference(store,
    financialPeriodIdentityId, FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    'financial period identity'));
  return { financialPeriodIdentityId, ...raw };
}

/**
 * Classify every eligible raw period of one revision and emit K3 cores plus the
 * K4 report.
 *
 * @param {{
 *   store: unknown,
 *   earningsRevisionIdentityId: string,
 *   sourceFilingDocumentId: string,
 *   orderedRawPeriodIds: string[],
 *   earningsFiscalClassificationPolicyId: string,
 *   transformImplementationManifestId: string
 * }} input
 */
export function classifyEarningsFiscalPeriodsForRevisionV1(input) {
  const api = assertApiInput(input, [
    'earningsRevisionIdentityId', 'sourceFilingDocumentId', 'orderedRawPeriodIds',
    'earningsFiscalClassificationPolicyId', 'transformImplementationManifestId',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertCasId(api.earningsRevisionIdentityId, 'earningsRevisionIdentityId');
  assertCasId(api.sourceFilingDocumentId, 'sourceFilingDocumentId');
  assertCasId(api.transformImplementationManifestId, 'transformImplementationManifestId');
  if (!Array.isArray(api.orderedRawPeriodIds)) {
    throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_INVALID',
      'orderedRawPeriodIds must be an array');
  }
  api.orderedRawPeriodIds.forEach((id, index) => assertCasId(id, `orderedRawPeriodIds[${index}]`));

  // The policy must be the pinned closed singleton before it may govern.
  verifyEarningsFiscalClassificationPolicy({
    store: api.store,
    earningsFiscalClassificationPolicyId: api.earningsFiscalClassificationPolicyId,
  });

  const filing = normalizeSecFilingSourceDocumentCoreV1(readTypedReference(api.store,
    api.sourceFilingDocumentId, SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
    'SEC filing source document'));

  /** @type {{code: string, rawPeriodIdToken: string}[]} */
  const diagnostics = [];
  const addDiagnostic = (code, rawPeriodIdToken) => {
    if (!diagnostics.some((d) => d.code === code && d.rawPeriodIdToken === rawPeriodIdToken)) {
      diagnostics.push({ code, rawPeriodIdToken });
    }
  };

  // --- DEI metadata across every structured document of the filing ----------
  const structured = filing.orderedDocuments
    .filter((doc) => EARNINGS_STRUCTURED_DOCUMENT_ROLES.includes(doc.documentRole));
  const readings = structured.map((doc) => readEarningsFiscalMetadataFromPinnedBytesV1({
    store: api.store, secDocumentBytesId: doc.secDocumentBytesId,
  }));
  for (const reading of readings) {
    for (const diagnostic of reading.diagnostics) {
      addDiagnostic(diagnostic.code, reading.secDocumentBytesId);
    }
  }

  const distinct = (key) => [...new Set(readings.map((r) => r[key]).filter((v) => v !== null))];
  const periodEnds = distinct('documentPeriodEndDate');
  const focuses = distinct('documentFiscalPeriodFocus');
  const yearFocuses = distinct('documentFiscalYearFocus');

  // multiDocumentPeriodEndPolicy = REQUIRE_IDENTICAL.
  let divergent = false;
  if (periodEnds.length > 1 || focuses.length > 1) {
    divergent = true;
    addDiagnostic('EARNINGS_FISCAL_METADATA_DIVERGENT', api.sourceFilingDocumentId);
  }

  const documentPeriodEndDate = periodEnds.length === 1 ? periodEnds[0] : null;
  const declaredFiscalPeriodFocus = focuses.length === 1 ? focuses[0] : null;
  const declaredFiscalYearFocus = yearFocuses.length === 1 ? yearFocuses[0] : null;
  const attestingReading = readings.find((r) => r.documentFiscalPeriodFocus === declaredFiscalPeriodFocus
    && r.documentPeriodEndDate === documentPeriodEndDate) ?? readings[0] ?? null;

  // --- eligible raw periods: exact DocumentPeriodEndDate match only ---------
  const rawPeriods = api.orderedRawPeriodIds.map((id) => readRawPeriod(api.store, id));
  const eligible = documentPeriodEndDate === null
    ? [] : rawPeriods.filter((p) => p.periodEnd === documentPeriodEndDate);
  const eligibleDurations = eligible
    .filter((p) => p.periodType === 'DURATION')
    .map((p) => ({ ...p, spanDays: spanDays(p.periodStart, p.periodEnd) }))
    .sort(bySpanThenId);
  const eligibleInstants = eligible
    .filter((p) => p.periodType === 'INSTANT')
    .sort((l, r) => (l.financialPeriodIdentityId < r.financialPeriodIdentityId ? -1 : 1));

  // --- form / focus compatibility -------------------------------------------
  let formFocusCompatible = true;
  if (declaredFiscalPeriodFocus !== null) {
    const allowed = allowedFocusValuesForFormType(filing.formType);
    if (allowed === null || !allowed.includes(declaredFiscalPeriodFocus)) {
      formFocusCompatible = false;
      addDiagnostic('EARNINGS_FISCAL_FOCUS_FORM_INCOMPATIBLE', api.sourceFilingDocumentId);
    }
  }

  /** @type {{rawPeriod: object, fiscalPeriodClass: string, basis: string, method: string}[]} */
  const assignments = [];
  const classifiedRawPeriodIds = new Set();
  let dualRoleRawPeriodCount = 0;

  const blocked = divergent || !formFocusCompatible
    || declaredFiscalPeriodFocus === null || documentPeriodEndDate === null;

  if (!blocked) {
    // Instants carry no role question: their class is their period type.
    for (const instant of eligibleInstants) {
      assignments.push({
        rawPeriod: instant, fiscalPeriodClass: 'INSTANT',
        basis: 'SOURCE_ATTESTED', method: 'DECLARED_FOCUS',
      });
    }
    const durations = eligibleDurations;
    const focus = declaredFiscalPeriodFocus;
    if (focus === 'Q1') {
      if (durations.length === 1) {
        assignments.push({
          rawPeriod: durations[0], fiscalPeriodClass: 'QUARTER',
          basis: 'SOURCE_ATTESTED', method: 'DECLARED_FOCUS',
        });
        assignments.push({
          rawPeriod: durations[0], fiscalPeriodClass: 'YEAR_TO_DATE',
          basis: 'POLICY_INFERRED', method: 'Q1_DUAL_ROLE',
        });
        dualRoleRawPeriodCount = 1;
      } else if (durations.length > 1) {
        for (const duration of durations) {
          addDiagnostic('EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS',
            duration.financialPeriodIdentityId);
        }
      }
    } else if (focus === 'Q2' || focus === 'Q3') {
      if (durations.length === 2) {
        assignments.push({
          rawPeriod: durations[0], fiscalPeriodClass: 'QUARTER',
          basis: 'POLICY_INFERRED', method: 'RELATIONAL_SPAN_ORDER',
        });
        assignments.push({
          rawPeriod: durations[1], fiscalPeriodClass: 'YEAR_TO_DATE',
          basis: 'POLICY_INFERRED', method: 'RELATIONAL_SPAN_ORDER',
        });
      } else {
        for (const duration of durations) {
          addDiagnostic('EARNINGS_FISCAL_ROLE_UNDETERMINED', duration.financialPeriodIdentityId);
        }
      }
    } else if (focus === 'Q4') {
      if (durations.length === 1) {
        assignments.push({
          rawPeriod: durations[0], fiscalPeriodClass: 'QUARTER',
          basis: 'SOURCE_ATTESTED', method: 'DECLARED_FOCUS',
        });
      } else if (durations.length > 1) {
        // No source fact separates a terminal quarter from a stub or a YTD span.
        for (const duration of durations) {
          addDiagnostic('EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS',
            duration.financialPeriodIdentityId);
        }
      }
    } else if (focus === 'FY') {
      if (durations.length === 1) {
        assignments.push({
          rawPeriod: durations[0], fiscalPeriodClass: 'FISCAL_YEAR',
          basis: 'SOURCE_ATTESTED', method: 'DECLARED_FOCUS',
        });
      } else if (durations.length === 2) {
        assignments.push({
          rawPeriod: durations[1], fiscalPeriodClass: 'FISCAL_YEAR',
          basis: 'POLICY_INFERRED', method: 'RELATIONAL_SPAN_ORDER',
        });
        // The shorter span is not provably the terminal quarter.
        addDiagnostic('EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE',
          durations[0].financialPeriodIdentityId);
      } else if (durations.length > 2) {
        for (const duration of durations) {
          addDiagnostic('EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS',
            duration.financialPeriodIdentityId);
        }
      }
    }
  }

  // --- emit K3 cores --------------------------------------------------------
  const orderedFiscalPeriodClassificationIds = [];
  const emitted = [];
  for (const assignment of assignments) {
    const core = normalizeEarningsFiscalPeriodClassificationCoreV1({
      schemaVersion: EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
      earningsRevisionIdentityId: api.earningsRevisionIdentityId,
      financialPeriodIdentityId: assignment.rawPeriod.financialPeriodIdentityId,
      fiscalPeriodClass: assignment.fiscalPeriodClass,
      fiscalPeriodFocus: declaredFiscalPeriodFocus,
      fiscalYearFocus: declaredFiscalYearFocus,
      documentPeriodEndDate,
      sourceFormType: filing.formType,
      fiscalMetadataSourceDocumentBytesId: attestingReading.secDocumentBytesId,
      classificationBasis: assignment.basis,
      classificationMethod: assignment.method,
      orderedSourceFactTags: attestingReading.orderedSourceFactTags,
    });
    const stored = putCanonicalL3(api.store,
      EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION, core);
    orderedFiscalPeriodClassificationIds.push(stored.objectId);
    classifiedRawPeriodIds.add(assignment.rawPeriod.financialPeriodIdentityId);
    emitted.push({ id: stored.objectId, value: stored.value, basis: assignment.basis });
  }
  orderedFiscalPeriodClassificationIds.sort();
  for (let index = 1; index < orderedFiscalPeriodClassificationIds.length; index += 1) {
    if (orderedFiscalPeriodClassificationIds[index - 1]
      === orderedFiscalPeriodClassificationIds[index]) {
      throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_DUPLICATE',
        'two classifications share (revision, rawPeriod, class)');
    }
  }

  // --- K4 report ------------------------------------------------------------
  const classifiedRawPeriodCount = classifiedRawPeriodIds.size;
  const unclassifiedRawPeriodCount = eligible.length - classifiedRawPeriodCount;

  // K4.documentPeriodEndDate is a required civil date attested identically by
  // every structured document. When the filing does not attest one - absent,
  // ambiguous or divergent DEI metadata - there is no date to report and none
  // may be fabricated, so the revision yields diagnostics and no report at all.
  // Its raw periods stay unclassified for the caller.
  if (documentPeriodEndDate === null) {
    return {
      earningsFiscalClassificationReportId: null,
      earningsFiscalClassificationReport: null,
      orderedFiscalPeriodClassificationIds: [],
      dualRoleRawPeriodCount: 0,
      diagnostics,
      status: 'PARTIAL',
    };
  }

  const report = normalizeEarningsFiscalClassificationReportV1({
    schemaVersion: EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
    earningsRevisionIdentityId: api.earningsRevisionIdentityId,
    earningsFiscalClassificationPolicyId: api.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: api.transformImplementationManifestId,
    sourceFilingDocumentId: api.sourceFilingDocumentId,
    documentPeriodEndDate,
    declaredFiscalPeriodFocus,
    declaredFiscalYearFocus,
    orderedFiscalPeriodClassificationIds,
    classifiedRawPeriodCount,
    unclassifiedRawPeriodCount,
    diagnosticCount: diagnostics.length,
    orderedDiagnosticDigest: earningsFiscalClassificationDiagnosticDigestV1(diagnostics),
    sourceAttestedClassificationCount: emitted.filter((e) => e.basis === 'SOURCE_ATTESTED').length,
    policyInferredClassificationCount: emitted.filter((e) => e.basis === 'POLICY_INFERRED').length,
  });
  const storedReport = putCanonicalL3(api.store,
    EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION, report);

  return {
    earningsFiscalClassificationReportId: storedReport.objectId,
    earningsFiscalClassificationReport: storedReport.value,
    orderedFiscalPeriodClassificationIds,
    dualRoleRawPeriodCount,
    diagnostics,
    status: diagnostics.length === 0 ? 'COMPLETE' : 'PARTIAL',
  };
}
