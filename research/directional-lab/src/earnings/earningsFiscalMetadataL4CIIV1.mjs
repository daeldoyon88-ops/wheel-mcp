/**
 * L4C-I2 DEI fiscal metadata reader over pinned SEC document bytes.
 *
 * This module is deliberately disjoint from earningsXbrlExtractionL4CIV1: it
 * must never import it, because editing that module would change its
 * transformSourceTextSha256 and therefore every shipped L4C-I1 golden id. The
 * duplication of a small amount of lexical scanning is the price of keeping
 * L4C-I1 byte-stable.
 *
 * The reader is pure: it takes bytes that are already pinned in the CAS and
 * returns declared fiscal metadata plus diagnostics. Missing, ambiguous or
 * invalid metadata is diagnosed and omitted, never thrown and never guessed.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_FISCAL_PERIOD_FOCUS_VALUES,
  EARNINGS_FISCAL_YEAR_FOCUS_PATTERN,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsSecDocumentBytes } from './earningsSecDocumentBytesL4CIV1.mjs';

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The four DEI tags this reader is allowed to consult, in canonical order. */
const DEI_TAGS = Object.freeze([
  'dei:DocumentPeriodEndDate',
  'dei:DocumentFiscalPeriodFocus',
  'dei:DocumentFiscalYearFocus',
  'dei:DocumentType',
]);

/** Field name each tag lands in, and the source-fact token it attests. */
const DEI_FIELD_BY_TAG = Object.freeze({
  'dei:DocumentPeriodEndDate': { field: 'documentPeriodEndDate', factTag: 'DocumentPeriodEndDate' },
  'dei:DocumentFiscalPeriodFocus': { field: 'documentFiscalPeriodFocus', factTag: 'DocumentFiscalPeriodFocus' },
  'dei:DocumentFiscalYearFocus': { field: 'documentFiscalYearFocus', factTag: 'DocumentFiscalYearFocus' },
  'dei:DocumentType': { field: 'documentType', factTag: null },
});

function decodeXmlText(value) {
  return value.replace(/<[^>]*>/g, '').trim()
    .replace(/&#x2212;/gi, '-').replace(/&minus;/g, '-')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributesOf(text) {
  const result = {};
  for (const match of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = match[2] ?? match[3];
  }
  return result;
}

/**
 * Collect every declared value of the four DEI tags, in both ordinary XBRL and
 * inline XBRL form. Order of appearance is irrelevant: only the distinct value
 * set per tag matters, so a document that repeats a tag consistently is not
 * ambiguous.
 * @param {string} xml
 * @returns {Map<string, string[]>} tag -> distinct declared values
 */
function collectDeclaredDeiValues(xml) {
  const collected = new Map(DEI_TAGS.map((tag) => [tag, []]));
  const push = (tag, rawValue) => {
    if (!collected.has(tag)) return;
    const value = decodeXmlText(rawValue);
    if (value.length > 0) collected.get(tag).push(value);
  };
  for (const match of xml.matchAll(
    /<(dei:[A-Za-z_][\w.-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    push(match[1], match[3]);
  }
  for (const match of xml.matchAll(
    /<(?:ix:)?nonNumeric\b([^>]*)>([\s\S]*?)<\/(?:ix:)?nonNumeric\s*>/gi)) {
    const name = attributesOf(match[1]).name;
    if (name) push(name, match[2]);
  }
  const distinct = new Map();
  for (const [tag, values] of collected) distinct.set(tag, [...new Set(values)]);
  return distinct;
}

/**
 * Read declared fiscal metadata out of one pinned SEC document.
 *
 * @param {{store: unknown, secDocumentBytesId: string}} input
 * @returns {{
 *   secDocumentBytesId: string,
 *   documentPeriodEndDate: string|null,
 *   documentFiscalPeriodFocus: string|null,
 *   documentFiscalYearFocus: string|null,
 *   documentType: string|null,
 *   orderedSourceFactTags: string[],
 *   diagnostics: {code: string, tag: string|null}[],
 *   complete: boolean
 * }}
 */
export function readEarningsFiscalMetadataFromPinnedBytesV1(input) {
  const api = assertApiInput(input, ['secDocumentBytesId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  if (typeof api.secDocumentBytesId !== 'string' || api.secDocumentBytesId.length === 0) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISSING',
      'secDocumentBytesId must be an explicit pinned CAS id');
  }
  // Reading the bytes back through the L4C-I1 verifier keeps the digest promise
  // intact: a corrupt or missing document fails closed before any parsing.
  const verified = verifyEarningsSecDocumentBytes({
    store: api.store, secDocumentBytesId: api.secDocumentBytesId,
  });
  // Strict UTF-8, exactly as the L4C-I1 extractor decodes its own pinned bytes:
  // an invalid sequence is a corrupt document, never a silent U+FFFD.
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(verified.bytes);
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISMATCH',
      'pinned document bytes are not valid UTF-8', { cause });
  }
  const declared = collectDeclaredDeiValues(xml);

  const diagnostics = [];
  const values = {};
  for (const tag of DEI_TAGS) {
    const candidates = declared.get(tag) ?? [];
    if (candidates.length > 1) {
      diagnostics.push({ code: 'EARNINGS_FISCAL_METADATA_AMBIGUOUS', tag });
      values[DEI_FIELD_BY_TAG[tag].field] = null;
      continue;
    }
    values[DEI_FIELD_BY_TAG[tag].field] = candidates.length === 1 ? candidates[0] : null;
  }

  // A missing focus is the one absence that blocks classification outright.
  if (values.documentFiscalPeriodFocus === null
    && !diagnostics.some((d) => d.tag === 'dei:DocumentFiscalPeriodFocus')) {
    diagnostics.push({
      code: 'EARNINGS_FISCAL_METADATA_ABSENT', tag: 'dei:DocumentFiscalPeriodFocus',
    });
  }
  if (values.documentFiscalPeriodFocus !== null
    && !EARNINGS_FISCAL_PERIOD_FOCUS_VALUES.includes(values.documentFiscalPeriodFocus)) {
    diagnostics.push({
      code: 'EARNINGS_FISCAL_FOCUS_INVALID', tag: 'dei:DocumentFiscalPeriodFocus',
    });
    values.documentFiscalPeriodFocus = null;
  }
  if (values.documentFiscalYearFocus !== null
    && !EARNINGS_FISCAL_YEAR_FOCUS_PATTERN.test(values.documentFiscalYearFocus)) {
    diagnostics.push({
      code: 'EARNINGS_FISCAL_YEAR_FOCUS_INVALID', tag: 'dei:DocumentFiscalYearFocus',
    });
    values.documentFiscalYearFocus = null;
  }
  if (values.documentPeriodEndDate !== null
    && !CIVIL_DATE_PATTERN.test(values.documentPeriodEndDate)) {
    diagnostics.push({
      code: 'EARNINGS_FISCAL_METADATA_ABSENT', tag: 'dei:DocumentPeriodEndDate',
    });
    values.documentPeriodEndDate = null;
  }

  // orderedSourceFactTags replays which source facts were actually read, in the
  // canonical order. A relational role is never a source fact and never lands
  // here - it lives exclusively in classificationMethod.
  const orderedSourceFactTags = DEI_TAGS
    .map((tag) => DEI_FIELD_BY_TAG[tag])
    .filter((entry) => entry.factTag !== null && values[entry.field] !== null)
    .map((entry) => entry.factTag);

  return {
    secDocumentBytesId: api.secDocumentBytesId,
    documentPeriodEndDate: values.documentPeriodEndDate,
    documentFiscalPeriodFocus: values.documentFiscalPeriodFocus,
    documentFiscalYearFocus: values.documentFiscalYearFocus,
    documentType: values.documentType,
    orderedSourceFactTags,
    diagnostics,
    complete: values.documentPeriodEndDate !== null
      && values.documentFiscalPeriodFocus !== null
      && diagnostics.length === 0,
  };
}
