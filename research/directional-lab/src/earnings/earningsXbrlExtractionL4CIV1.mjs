/** Deterministic synthetic-friendly XML/iXBRL extraction for the closed metrics. */

import { MarketDataL3Error, assertApiInput } from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_EPS_TAG_PRIORITY,
  EARNINGS_REVENUE_TAG_PRIORITY,
  EARNINGS_STRUCTURED_DOCUMENT_ROLES,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { verifyEarningsMetricExtractionPolicy } from './earningsMetricExtractionPolicyL4CIV1.mjs';
import { buildFinancialPeriodIdentityCore } from './earningsFinancialPeriodL4CIV1.mjs';
import {
  buildEarningsMetricObservationCore,
  fixedPointFromXbrlLexicalV1,
} from './earningsMetricObservationL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifySecFilingSourceDocument } from './earningsSecFilingSourceDocumentL4CIV1.mjs';
import {
  buildXbrlCanonicalUnitFromMeasures,
} from './earningsXbrlUnitL4CIV1.mjs';

function attrs(text) {
  const result = {};
  for (const match of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = match[2] ?? match[3];
  }
  return result;
}

function textContent(value) {
  return value.replace(/<[^>]*>/g, '').trim()
    .replace(/&minus;/g, '-').replace(/&#x2212;/gi, '-')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseContexts(xml) {
  const contexts = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?context\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?context\s*>/gi)) {
    const id = attrs(match[1]).id;
    if (!id) continue;
    const body = match[2];
    const instant = body.match(/<(?:\w+:)?instant\b[^>]*>([^<]+)<\/(?:\w+:)?instant\s*>/i)?.[1]?.trim();
    const start = body.match(/<(?:\w+:)?startDate\b[^>]*>([^<]+)<\/(?:\w+:)?startDate\s*>/i)?.[1]?.trim();
    const end = body.match(/<(?:\w+:)?endDate\b[^>]*>([^<]+)<\/(?:\w+:)?endDate\s*>/i)?.[1]?.trim();
    const identifier = body.match(/<(?:\w+:)?identifier\b[^>]*>([^<]+)<\/(?:\w+:)?identifier\s*>/i)?.[1]?.trim();
    const dimensions = /<(?:\w+:)?(?:segment|scenario)\b[\s\S]*?<(?:\w+:)?(?:explicitMember|typedMember)\b/i
      .test(body);
    contexts.set(id, {
      id, identifier, dimensions,
      periodType: instant ? 'INSTANT' : 'DURATION',
      periodStart: instant ? null : start,
      periodEnd: instant ?? end,
    });
  }
  return contexts;
}

function parseUnits(xml) {
  const units = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?unit\s*>/gi)) {
    const id = attrs(match[1]).id;
    if (!id) continue;
    const body = match[2];
    const numerator = body.match(/<(?:\w+:)?unitNumerator\b[^>]*>([\s\S]*?)<\/(?:\w+:)?unitNumerator\s*>/i)?.[1];
    const denominator = body.match(/<(?:\w+:)?unitDenominator\b[^>]*>([\s\S]*?)<\/(?:\w+:)?unitDenominator\s*>/i)?.[1];
    const measures = (part) => [...(part ?? '').matchAll(
      /<(?:\w+:)?measure\b[^>]*>([^<]+)<\/(?:\w+:)?measure\s*>/gi)]
      .map((item) => item[1].trim());
    units.set(id, numerator || denominator
      ? { numeratorMeasures: measures(numerator), denominatorMeasures: measures(denominator) }
      : { measures: measures(body) });
  }
  return units;
}

function parseFacts(xml) {
  const facts = [];
  // Ordinary namespace-qualified XBRL facts. Elements without contextRef are
  // infrastructure (contexts, units, schemas), not facts.
  for (const match of xml.matchAll(
    /<([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const attributes = attrs(match[2]);
    if (!attributes.contextRef || match[1].startsWith('ix:')) continue;
    facts.push({ name: match[1], attributes, value: textContent(match[3]) });
  }
  // Inline XBRL numeric facts.
  for (const match of xml.matchAll(
    /<(?:ix:)?nonFraction\b([^>]*)>([\s\S]*?)<\/(?:ix:)?nonFraction\s*>/gi)) {
    const attributes = attrs(match[1]);
    if (attributes.name) facts.push({
      name: attributes.name, attributes, value: textContent(match[2]),
    });
  }
  for (const match of xml.matchAll(
    /<(?:ix:)?nonNumeric\b([^>]*)>([\s\S]*?)<\/(?:ix:)?nonNumeric\s*>/gi)) {
    const attributes = attrs(match[1]);
    if (attributes.name) facts.push({
      name: attributes.name, attributes, value: textContent(match[2]),
    });
  }
  return facts;
}

function documentPeriodEnd(facts) {
  const candidates = facts.filter((fact) => fact.name === 'dei:DocumentPeriodEndDate');
  const values = [...new Set(candidates.map((fact) => fact.value))];
  if (values.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
    throw new MarketDataL3Error('EARNINGS_DOCUMENT_PERIOD_END_DATE_INVALID',
      'exactly one valid dei:DocumentPeriodEndDate is required');
  }
  return values[0];
}

function normalizeFactLexical(fact) {
  if (/^(?:true|1)$/i.test(fact.attributes['xsi:nil'] ?? '')) {
    throw new MarketDataL3Error('EARNINGS_FACT_NIL_REJECTED', 'nil facts are forbidden');
  }
  let value = fact.value.replace(/,/g, '');
  if (fact.attributes.sign === '-') value = value.startsWith('-') ? value : `-${value}`;
  const scale = Number(fact.attributes.scale ?? '0');
  if (!Number.isSafeInteger(scale)) {
    throw new MarketDataL3Error('EARNINGS_FIXED_POINT_INVALID', 'iXBRL scale is invalid');
  }
  if (scale > 0) value = `${value}${'0'.repeat(scale)}`;
  if (scale < 0) {
    const negative = value.startsWith('-');
    let digits = negative ? value.slice(1) : value;
    const places = -scale;
    digits = digits.padStart(places + 1, '0');
    value = `${negative ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
  }
  return value;
}

function selectSupportedFacts(facts, contexts, periodEnd) {
  const supported = new Set([...EARNINGS_EPS_TAG_PRIORITY, ...EARNINGS_REVENUE_TAG_PRIORITY,
    'dei:DocumentPeriodEndDate']);
  for (const fact of facts) {
    if (fact.name === 'us-gaap:EarningsPerShareBasic'
        || fact.name === 'us-gaap:EarningsPerShareBasicAndDiluted'
          && !EARNINGS_EPS_TAG_PRIORITY.includes(fact.name)) {
      throw new MarketDataL3Error('EARNINGS_EPS_TAG_REJECTED',
        `unsupported EPS tag ${fact.name}`);
    }
    if ((fact.name.startsWith('us-gaap:') || fact.name.startsWith('dei:'))
        && !supported.has(fact.name) && fact.attributes.contextRef) {
      // Other standard facts are simply outside the two-metric scope.
      continue;
    }
    if (!fact.name.startsWith('us-gaap:') && !fact.name.startsWith('dei:')) {
      throw new MarketDataL3Error('EARNINGS_EXTENSION_TAG_REJECTED',
        `extension tag ${fact.name} is forbidden`);
    }
  }
  const current = facts.filter((fact) => {
    const context = contexts.get(fact.attributes.contextRef);
    return context && context.periodEnd === periodEnd;
  });
  const selected = [];
  for (const [metricCode, priority] of [
    ['EPS_DILUTED', EARNINGS_EPS_TAG_PRIORITY],
    ['REVENUE_CONSOLIDATED', EARNINGS_REVENUE_TAG_PRIORITY],
  ]) {
    const availableTag = priority.find((tag) => current.some((fact) => fact.name === tag));
    if (!availableTag) continue;
    for (const fact of current.filter((candidate) => candidate.name === availableTag)) {
      selected.push({ metricCode, fact });
    }
  }
  return selected;
}

/**
 * Extract the two closed metrics from every structured document in filing
 * order. Comparative contexts are ignored unless periodEnd exactly equals
 * DocumentPeriodEndDate. No fiscal-period classification is attempted.
 */
export function extractEarningsXbrlV1(input) {
  const api = assertApiInput(input, [
    'sourceFilingDocumentId', 'earningsRevisionIdentityId',
    'earningsMetricExtractionPolicyId',
  ]);
  verifyEarningsMetricExtractionPolicy({
    store: api.store,
    earningsMetricExtractionPolicyId: api.earningsMetricExtractionPolicyId,
  });
  verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: api.earningsRevisionIdentityId,
  });
  const filing = verifySecFilingSourceDocument({
    store: api.store, sourceFilingDocumentId: api.sourceFilingDocumentId,
  });
  const structured = filing.documents.filter((document) =>
    EARNINGS_STRUCTURED_DOCUMENT_ROLES.includes(document.secDocumentBytesCore.documentRole));
  if (structured.length === 0) {
    throw new MarketDataL3Error('EARNINGS_STRUCTURED_DOCUMENT_ABSENT',
      'filing has no structured document');
  }
  const candidates = [];
  for (const document of structured) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
    const contexts = parseContexts(xml);
    const units = parseUnits(xml);
    const facts = parseFacts(xml);
    const dpe = documentPeriodEnd(facts);
    for (const selected of selectSupportedFacts(facts, contexts, dpe)) {
      const context = contexts.get(selected.fact.attributes.contextRef);
      if (context.dimensions) {
        throw new MarketDataL3Error('EARNINGS_CONTEXT_DIMENSION_REJECTED',
          'segment/scenario dimensions are forbidden');
      }
      const unit = units.get(selected.fact.attributes.unitRef);
      if (!unit) throw new MarketDataL3Error('EARNINGS_UNIT_REJECTED',
        'fact unitRef does not resolve');
      candidates.push({ ...selected, context, unit,
        lexical: normalizeFactLexical(selected.fact) });
    }
  }
  // Identical duplicate facts collapse; contradictory duplicates fail closed.
  const unique = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.metricCode, candidate.context.periodType,
      candidate.context.periodStart, candidate.context.periodEnd, candidate.unit]);
    const existing = unique.get(key);
    if (existing && existing.lexical !== candidate.lexical) {
      throw new MarketDataL3Error('EARNINGS_DUPLICATE_FACT_POLICY_VIOLATION',
        'conflicting duplicate facts are forbidden');
    }
    if (!existing) unique.set(key, candidate);
  }
  const observationIds = [];
  for (const candidate of unique.values()) {
    const period = buildFinancialPeriodIdentityCore({
      store: api.store, periodType: candidate.context.periodType,
      periodStart: candidate.context.periodStart, periodEnd: candidate.context.periodEnd,
    });
    const unit = buildXbrlCanonicalUnitFromMeasures({ store: api.store, unit: candidate.unit });
    const fixed = fixedPointFromXbrlLexicalV1(candidate.lexical,
      candidate.metricCode === 'EPS_DILUTED' ? 6 : 2);
    const observation = buildEarningsMetricObservationCore({
      store: api.store,
      earningsRevisionIdentityId: api.earningsRevisionIdentityId,
      financialPeriodIdentityId: period.financialPeriodIdentityId,
      xbrlCanonicalUnitId: unit.xbrlCanonicalUnitId,
      metricCode: candidate.metricCode,
      atoms: fixed.atoms,
      scale: fixed.scale,
      shareBasis: candidate.metricCode === 'EPS_DILUTED' ? 'DILUTED' : null,
      accountingBasis: candidate.metricCode === 'EPS_DILUTED' ? 'GAAP' : null,
    });
    observationIds.push(observation.earningsMetricObservationId);
  }
  observationIds.sort();
  return {
    orderedObservationIds: observationIds,
    diagnostics: observationIds.length === 0 ? ['EARNINGS_NO_SUPPORTED_METRIC'] : [],
  };
}

export const extractEarningsMetricsFromXbrlV1 = extractEarningsXbrlV1;
