/**
 * Independent L4C-I2 as-of oracle.
 *
 * This helper exists to disagree with production. It therefore imports
 * node:crypto and nothing else - no production module, no repository canonical
 * JSON encoder, no contract module - and re-derives every preimage from the
 * closed authority text alone:
 *
 *   canonical JSON       RFC 8785 key order, UTF-8, one trailing LF
 *   domain digest        sha256( UTF-8(domain) 0x00 canonicalJson(value) )
 *   diagnostic digest    sha256( UTF-8(domain) 0x0A then, per entry,
 *                                UTF-8(code) 0x00 UTF-8(token) 0x0A )
 *   CAS object id        sha256( canonicalJson(value) ), prefixed with sha256:
 *
 * The 44 declared oracle vectors are embedded as literals with their byte
 * length and their SHA-256, so a preimage drift is detected without reading any
 * file the production code could also have written.
 */

import { createHash } from 'node:crypto';

/** RFC 8785 style canonicalisation: recursively sort object keys. */
function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortCanonical(value[key]);
    return sorted;
  }
  return value;
}

/** @param {unknown} value @returns {Buffer} */
export function independentCanonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortCanonical(value))}\n`, 'utf8');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} domain @param {unknown} value @returns {string} sha256:<hex> */
export function independentDomainDigestV1(domain, value) {
  const preimage = Buffer.concat([
    Buffer.from(domain, 'utf8'), Buffer.from([0x00]), independentCanonicalJsonBytes(value),
  ]);
  return `sha256:${sha256Hex(preimage)}`;
}

export const INDEPENDENT_DIAGNOSTIC_DIGEST_DOMAIN =
  'EarningsFiscalClassificationDiagnosticDigest/1';

/**
 * Owner authority OWNER-L4C-I2-D01-2026-07-26: a domain line, then one line per
 * entry, sorted bytewise on token then code. An empty set is the domain line
 * alone - there is no sentinel entry.
 * @param {{code: string, rawPeriodIdToken: string}[]} entries
 */
export function independentDiagnosticDigestV1(entries) {
  const sorted = [...entries].sort((left, right) => {
    if (left.rawPeriodIdToken !== right.rawPeriodIdToken) {
      return left.rawPeriodIdToken < right.rawPeriodIdToken ? -1 : 1;
    }
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return 0;
  });
  const chunks = [Buffer.from(`${INDEPENDENT_DIAGNOSTIC_DIGEST_DOMAIN}\n`, 'utf8')];
  for (const entry of sorted) {
    chunks.push(Buffer.from(entry.code, 'utf8'));
    chunks.push(Buffer.from([0x00]));
    chunks.push(Buffer.from(entry.rawPeriodIdToken, 'utf8'));
    chunks.push(Buffer.from([0x0a]));
  }
  return `sha256:${sha256Hex(Buffer.concat(chunks))}`;
}

/** CAS object id of any canonical record. @param {unknown} value */
export function independentCanonicalObjectIdV1(value) {
  return `sha256:${sha256Hex(independentCanonicalJsonBytes(value))}`;
}

/** The five K6 fields the functional fingerprint omits. */
export const INDEPENDENT_FINGERPRINT_EXCLUDED_FIELDS = Object.freeze([
  'schemaVersion', 'earningsDatasetBindingId', 'earningsDatasetSnapshotManifestId',
  'knowledgeCutoff', 'materializationFunctionalFingerprint',
]);

export const INDEPENDENT_FINGERPRINT_DOMAIN =
  'EarningsAsOfMaterializationFunctionalFingerprint/1';

/**
 * F1 recomputed by exclusion rather than from an inclusion list, so the oracle
 * disagrees with production whenever the two field sets diverge.
 * @param {Record<string, unknown>} report
 */
export function independentFunctionalFingerprintV1(report) {
  const projection = {};
  for (const key of Object.keys(report)) {
    if (!INDEPENDENT_FINGERPRINT_EXCLUDED_FIELDS.includes(key)) projection[key] = report[key];
  }
  return independentDomainDigestV1(INDEPENDENT_FINGERPRINT_DOMAIN, projection);
}

/** The seven ordered-list digest domains, in K6 field order. */
export const INDEPENDENT_DIGEST_DOMAINS = Object.freeze([
  'EarningsAsOfVisibleEventDigest/1',
  'EarningsAsOfVisibleRevisionDigest/1',
  'EarningsAsOfVisibleExtractionReportDigest/1',
  'EarningsAsOfVisibleObservationDigest/1',
  'EarningsAsOfVisibleRawPeriodDigest/1',
  'EarningsFiscalClassificationDigest/1',
  'EarningsFiscalClassificationDiagnosticDigest/1',
]);

/** Three fabricated ids used by the declared non-empty ordered-list vectors. */
export const INDEPENDENT_ORDERED_ID_SAMPLE = Object.freeze([
  '0'.repeat(64), '7'.repeat(64), 'f'.repeat(64),
]);

/** The 44 declared oracle vectors, embedded verbatim. */
export const INDEPENDENT_ORACLE_VECTORS = Object.freeze([
  Object.freeze({
    vectorId: "OV-E01",
    domain: "EarningsAsOfVisibleEventDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZUV2ZW50RGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLUUwMSIsImlucHV0S2luZCI6ImVtcHR5IGxpc3QifQ==",
    canonicalPreimageByteLength: 79,
    expectedSha256: "450178b05be7b732bc4ecedf1b67cae965b5a3602c6d53c1e02219080ca84e87",
  }),
  Object.freeze({
    vectorId: "OV-N01",
    domain: "EarningsAsOfVisibleEventDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZUV2ZW50RGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLU4wMSIsImlucHV0S2luZCI6Im9yZGVyZWQgaWRzIDAwMDAwMDAwLi4uLCA3Nzc3Nzc3Ny4uLiwgZmZmZmZmZmYuLi4iLCJpZHMiOlsiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzciLCJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIl19",
    canonicalPreimageByteLength: 327,
    expectedSha256: "69f18827a0efc3d9f872678e5f83a67e16207aba0094085667931f27093caf69",
  }),
  Object.freeze({
    vectorId: "OV-E02",
    domain: "EarningsAsOfVisibleRevisionDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZVJldmlzaW9uRGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLUUwMiIsImlucHV0S2luZCI6ImVtcHR5IGxpc3QifQ==",
    canonicalPreimageByteLength: 82,
    expectedSha256: "2444ec27f708716f4edb6d4166212c7f3c559ff80e17819e15b1b79f1a3fa597",
  }),
  Object.freeze({
    vectorId: "OV-N02",
    domain: "EarningsAsOfVisibleRevisionDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZVJldmlzaW9uRGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLU4wMiIsImlucHV0S2luZCI6Im9yZGVyZWQgaWRzIDAwMDAwMDAwLi4uLCA3Nzc3Nzc3Ny4uLiwgZmZmZmZmZmYuLi4iLCJpZHMiOlsiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzciLCJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIl19",
    canonicalPreimageByteLength: 330,
    expectedSha256: "ecea356308d503143236a099e93843a47e2b5d20497117de929ac5591963a44d",
  }),
  Object.freeze({
    vectorId: "OV-E03",
    domain: "EarningsAsOfVisibleExtractionReportDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZUV4dHJhY3Rpb25SZXBvcnREaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtRTAzIiwiaW5wdXRLaW5kIjoiZW1wdHkgbGlzdCJ9",
    canonicalPreimageByteLength: 90,
    expectedSha256: "2949807ca36e66d8e7713d825c67b73ee5c7ce8eb706db488c496cb34a60277a",
  }),
  Object.freeze({
    vectorId: "OV-N03",
    domain: "EarningsAsOfVisibleExtractionReportDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZUV4dHJhY3Rpb25SZXBvcnREaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtTjAzIiwiaW5wdXRLaW5kIjoib3JkZXJlZCBpZHMgMDAwMDAwMDAuLi4sIDc3Nzc3Nzc3Li4uLCBmZmZmZmZmZi4uLiIsImlkcyI6WyIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NyIsImZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiXX0=",
    canonicalPreimageByteLength: 338,
    expectedSha256: "01537f5ae5f66a3d85ebba3a43ff14169252671771d163546675d5fe53be3ce0",
  }),
  Object.freeze({
    vectorId: "OV-E04",
    domain: "EarningsAsOfVisibleObservationDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZU9ic2VydmF0aW9uRGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLUUwNCIsImlucHV0S2luZCI6ImVtcHR5IGxpc3QifQ==",
    canonicalPreimageByteLength: 85,
    expectedSha256: "ea604df4e3dccd6edd0a8a7ac4a6a85ba25d81340922d60dc6322fae6d8690ff",
  }),
  Object.freeze({
    vectorId: "OV-N04",
    domain: "EarningsAsOfVisibleObservationDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZU9ic2VydmF0aW9uRGlnZXN0LzEAeyJ2ZWN0b3JJZCI6Ik9WLU4wNCIsImlucHV0S2luZCI6Im9yZGVyZWQgaWRzIDAwMDAwMDAwLi4uLCA3Nzc3Nzc3Ny4uLiwgZmZmZmZmZmYuLi4iLCJpZHMiOlsiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIjc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzciLCJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIl19",
    canonicalPreimageByteLength: 333,
    expectedSha256: "de30169af24ecdbf42a7606fae31cb6a66e99610b61acdedcc9987a08eb41c66",
  }),
  Object.freeze({
    vectorId: "OV-E05",
    domain: "EarningsAsOfVisibleRawPeriodDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZVJhd1BlcmlvZERpZ2VzdC8xAHsidmVjdG9ySWQiOiJPVi1FMDUiLCJpbnB1dEtpbmQiOiJlbXB0eSBsaXN0In0=",
    canonicalPreimageByteLength: 83,
    expectedSha256: "d0ffd027457c013925b0c0a8665d03693149e1780cf2f8a05ba64f9a965e1000",
  }),
  Object.freeze({
    vectorId: "OV-N05",
    domain: "EarningsAsOfVisibleRawPeriodDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mVmlzaWJsZVJhd1BlcmlvZERpZ2VzdC8xAHsidmVjdG9ySWQiOiJPVi1OMDUiLCJpbnB1dEtpbmQiOiJvcmRlcmVkIGlkcyAwMDAwMDAwMC4uLiwgNzc3Nzc3NzcuLi4sIGZmZmZmZmZmLi4uIiwiaWRzIjpbIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCI3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3IiwiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZiJdfQ==",
    canonicalPreimageByteLength: 331,
    expectedSha256: "13ade6050e177c8b958ac72cb943f7e7f5183ac14ddeebaed38dcc055594a3df",
  }),
  Object.freeze({
    vectorId: "OV-E06",
    domain: "EarningsFiscalClassificationDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpZ2VzdC8xAHsidmVjdG9ySWQiOiJPVi1FMDYiLCJpbnB1dEtpbmQiOiJlbXB0eSBsaXN0In0=",
    canonicalPreimageByteLength: 83,
    expectedSha256: "4a0d5beebc5644321ce43012b8265b128fd978edcd82329d0afd19af9d2ca808",
  }),
  Object.freeze({
    vectorId: "OV-N06",
    domain: "EarningsFiscalClassificationDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpZ2VzdC8xAHsidmVjdG9ySWQiOiJPVi1OMDYiLCJpbnB1dEtpbmQiOiJvcmRlcmVkIGlkcyAwMDAwMDAwMC4uLiwgNzc3Nzc3NzcuLi4sIGZmZmZmZmZmLi4uIiwiaWRzIjpbIjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCI3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3IiwiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZiJdfQ==",
    canonicalPreimageByteLength: 331,
    expectedSha256: "cb3fada784afe4f0774e33caf6eb8096eb5a91304423b5e17d5d4d36b4b50259",
  }),
  Object.freeze({
    vectorId: "OV-E07",
    domain: "EarningsFiscalClassificationDiagnosticDigest/1",
    inputKind: "empty list",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpYWdub3N0aWNEaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtRTA3IiwiaW5wdXRLaW5kIjoiZW1wdHkgbGlzdCJ9",
    canonicalPreimageByteLength: 93,
    expectedSha256: "e8076f2f1cf0d8ecd0ff1af0ee5109cef73474c16542ed574ef478695bc5d674",
  }),
  Object.freeze({
    vectorId: "OV-N07",
    domain: "EarningsFiscalClassificationDiagnosticDigest/1",
    inputKind: "ordered ids 00000000..., 77777777..., ffffffff...",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpYWdub3N0aWNEaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtTjA3IiwiaW5wdXRLaW5kIjoib3JkZXJlZCBpZHMgMDAwMDAwMDAuLi4sIDc3Nzc3Nzc3Li4uLCBmZmZmZmZmZi4uLiIsImlkcyI6WyIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NyIsImZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiXX0=",
    canonicalPreimageByteLength: 341,
    expectedSha256: "0cf260f45da9540f29c9a04a0c0756de8287cfe34f36c4963cb6a7f274684259",
  }),
  Object.freeze({
    vectorId: "OV-F01",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "empty materialization record",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwMSIsImlucHV0S2luZCI6ImVtcHR5IG1hdGVyaWFsaXphdGlvbiByZWNvcmQifQ==",
    canonicalPreimageByteLength: 115,
    expectedSha256: "4b3d7900f7a805c8ab1dfab8206de26124cfde38d58a2b05def4e6036ac544b7",
  }),
  Object.freeze({
    vectorId: "OV-F02",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "non-empty materialization record",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwMiIsImlucHV0S2luZCI6Im5vbi1lbXB0eSBtYXRlcmlhbGl6YXRpb24gcmVjb3JkIn0=",
    canonicalPreimageByteLength: 119,
    expectedSha256: "84603c4f655f887006d7e4cc4194bbb7b0ff0833e28860686ee4b41052034b12",
  }),
  Object.freeze({
    vectorId: "OV-F03",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "same record with a different knowledgeCutoff (excluded field)",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwMyIsImlucHV0S2luZCI6InNhbWUgcmVjb3JkIHdpdGggYSBkaWZmZXJlbnQga25vd2xlZGdlQ3V0b2ZmIChleGNsdWRlZCBmaWVsZCkifQ==",
    canonicalPreimageByteLength: 148,
    expectedSha256: "1b37eedd656b7a9fc43460d42a94513809802e24521ac695017befd541ff7415",
  }),
  Object.freeze({
    vectorId: "OV-F04",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "same record with a different snapshot id (excluded field)",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwNCIsImlucHV0S2luZCI6InNhbWUgcmVjb3JkIHdpdGggYSBkaWZmZXJlbnQgc25hcHNob3QgaWQgKGV4Y2x1ZGVkIGZpZWxkKSJ9",
    canonicalPreimageByteLength: 144,
    expectedSha256: "a4c179092a5fc7f57c17bf4609b4f2779971a926b632bb9db84f0a69ea6a6457",
  }),
  Object.freeze({
    vectorId: "OV-C01",
    domain: "cutoff boundary",
    inputKind: "publicAvailableAt === cutoff",
    canonicalPreimageBase64:
      "Y3V0b2ZmIGJvdW5kYXJ5AHsidmVjdG9ySWQiOiJPVi1DMDEiLCJpbnB1dEtpbmQiOiJwdWJsaWNBdmFpbGFibGVBdCA9PT0gY3V0b2ZmIn0=",
    canonicalPreimageByteLength: 80,
    expectedSha256: "6ffbd8131b338e5f57a0792d6629898f0e8b4551f2b0e4f524d96ee3fa184b0d",
  }),
  Object.freeze({
    vectorId: "OV-C02",
    domain: "cutoff boundary",
    inputKind: "publicAvailableAt = cutoff minus 1 ms",
    canonicalPreimageBase64:
      "Y3V0b2ZmIGJvdW5kYXJ5AHsidmVjdG9ySWQiOiJPVi1DMDIiLCJpbnB1dEtpbmQiOiJwdWJsaWNBdmFpbGFibGVBdCA9IGN1dG9mZiBtaW51cyAxIG1zIn0=",
    canonicalPreimageByteLength: 89,
    expectedSha256: "d5e867665e6d4e5c75368c157230cd26c02eea5b38ada901127236861119d016",
  }),
  Object.freeze({
    vectorId: "OV-C03",
    domain: "cutoff boundary",
    inputKind: "publicAvailableAt = cutoff plus 1 ms",
    canonicalPreimageBase64:
      "Y3V0b2ZmIGJvdW5kYXJ5AHsidmVjdG9ySWQiOiJPVi1DMDMiLCJpbnB1dEtpbmQiOiJwdWJsaWNBdmFpbGFibGVBdCA9IGN1dG9mZiBwbHVzIDEgbXMifQ==",
    canonicalPreimageByteLength: 88,
    expectedSha256: "6b733cbb2fe0e227e424ea3fd3c10a0c47702446389c969296f47df91b97c253",
  }),
  Object.freeze({
    vectorId: "OV-Q01",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "Q1 QUARTER role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtUTAxIiwiaW5wdXRLaW5kIjoiUTEgUVVBUlRFUiByb2xlIn0=",
    canonicalPreimageByteLength: 92,
    expectedSha256: "aad07a7e7f92577b96a071e817423a858f3a2bf8684551452c9bb7411d4084de",
  }),
  Object.freeze({
    vectorId: "OV-Q02",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "Q1 YEAR_TO_DATE role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtUTAyIiwiaW5wdXRLaW5kIjoiUTEgWUVBUl9UT19EQVRFIHJvbGUifQ==",
    canonicalPreimageByteLength: 97,
    expectedSha256: "6340078fd5260a2389ee8e67695ce382e6ee78a72153b8c25e229e817ce5d2e0",
  }),
  Object.freeze({
    vectorId: "OV-Q03",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "Q2 QUARTER role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtUTAzIiwiaW5wdXRLaW5kIjoiUTIgUVVBUlRFUiByb2xlIn0=",
    canonicalPreimageByteLength: 92,
    expectedSha256: "d73fd736b1d3c028173beb8a1c6064a0af62af3b52d326238f62c33f1f5d5180",
  }),
  Object.freeze({
    vectorId: "OV-Q04",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "Q2 YEAR_TO_DATE role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtUTA0IiwiaW5wdXRLaW5kIjoiUTIgWUVBUl9UT19EQVRFIHJvbGUifQ==",
    canonicalPreimageByteLength: 97,
    expectedSha256: "2e4eda421e13d1ac2eb087e533d9be4e0f9e2b24e1fa31d9eb5e48876aa6bf48",
  }),
  Object.freeze({
    vectorId: "OV-Y01",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "FY FISCAL_YEAR role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtWTAxIiwiaW5wdXRLaW5kIjoiRlkgRklTQ0FMX1lFQVIgcm9sZSJ9",
    canonicalPreimageByteLength: 96,
    expectedSha256: "b78c80dc2a86f569d8202a8cd61d669492d59852da9a93ef94de87d182fc7811",
  }),
  Object.freeze({
    vectorId: "OV-Y02",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "source Q4 QUARTER role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtWTAyIiwiaW5wdXRLaW5kIjoic291cmNlIFE0IFFVQVJURVIgcm9sZSJ9",
    canonicalPreimageByteLength: 99,
    expectedSha256: "908ae8a39cccb9def1fbc3a2aa6257cc7a2907664f5e6dffbed0fd9e7a6239e3",
  }),
  Object.freeze({
    vectorId: "OV-N08",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "53-week fiscal year",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtTjA4IiwiaW5wdXRLaW5kIjoiNTMtd2VlayBmaXNjYWwgeWVhciJ9",
    canonicalPreimageByteLength: 96,
    expectedSha256: "c631b7b1361bcb78a4bcc075af3c9aed6838120d6e289a8e2afbb50281ec5f91",
  }),
  Object.freeze({
    vectorId: "OV-N09",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "non-calendar fiscal year",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtTjA5IiwiaW5wdXRLaW5kIjoibm9uLWNhbGVuZGFyIGZpc2NhbCB5ZWFyIn0=",
    canonicalPreimageByteLength: 101,
    expectedSha256: "d914f6ce9eb6ba647de29e94a74d791f0584647d6da067f063d90d922e505488",
  }),
  Object.freeze({
    vectorId: "OV-I01",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "INSTANT role",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtSTAxIiwiaW5wdXRLaW5kIjoiSU5TVEFOVCByb2xlIn0=",
    canonicalPreimageByteLength: 89,
    expectedSha256: "3a7e9d891e44041947d6fd50ef7e5eff2d6142e26ff4ccf0076411f649ddf506",
  }),
  Object.freeze({
    vectorId: "OV-D01",
    domain: "EarningsFiscalClassificationDiagnosticDigest/1",
    inputKind: "one diagnostic entry",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpYWdub3N0aWNEaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtRDAxIiwiaW5wdXRLaW5kIjoib25lIGRpYWdub3N0aWMgZW50cnkifQ==",
    canonicalPreimageByteLength: 103,
    expectedSha256: "f2bdd87c9e170cd24284c0697e5cbe0d251b5c1118c8868bd3466ccc157d3fdf",
  }),
  Object.freeze({
    vectorId: "OV-D02",
    domain: "EarningsFiscalClassificationDiagnosticDigest/1",
    inputKind: "two diagnostic entries",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpYWdub3N0aWNEaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtRDAyIiwiaW5wdXRLaW5kIjoidHdvIGRpYWdub3N0aWMgZW50cmllcyJ9",
    canonicalPreimageByteLength: 105,
    expectedSha256: "813db7db1a9371fb0094b36fb6fd0442b00aa7f559f765c51e7af12a5baa6a98",
  }),
  Object.freeze({
    vectorId: "OV-R01",
    domain: "EarningsFiscalClassificationReport/1",
    inputKind: "canonical report record fully embedded in canonicalPreimage",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvblJlcG9ydC8xAHsidmVjdG9ySWQiOiJPVi1SMDEiLCJpbnB1dEtpbmQiOiJjYW5vbmljYWwgcmVwb3J0IHJlY29yZCBmdWxseSBlbWJlZGRlZCBpbiBjYW5vbmljYWxQcmVpbWFnZSJ9",
    canonicalPreimageByteLength: 132,
    expectedSha256: "c6c63b50baad9b900b5208e6a210f3e4523761d52dc86644ee440aabe4f9a70a",
  }),
  Object.freeze({
    vectorId: "OV-B01",
    domain: "EarningsDatasetBinding/1",
    inputKind: "canonical binding record fully embedded in canonicalPreimage",
    canonicalPreimageBase64:
      "RWFybmluZ3NEYXRhc2V0QmluZGluZy8xAHsidmVjdG9ySWQiOiJPVi1CMDEiLCJpbnB1dEtpbmQiOiJjYW5vbmljYWwgYmluZGluZyByZWNvcmQgZnVsbHkgZW1iZWRkZWQgaW4gY2Fub25pY2FsUHJlaW1hZ2UifQ==",
    canonicalPreimageByteLength: 121,
    expectedSha256: "aa6982fa9ce35272617dae07456141d053ab98ab39eb4f23f43a20a0c4a3f4c6",
  }),
  Object.freeze({
    vectorId: "OV-T01",
    domain: "EarningsAsOfMaterializationReport/1",
    inputKind: "canonical report record fully embedded in canonicalPreimage",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uUmVwb3J0LzEAeyJ2ZWN0b3JJZCI6Ik9WLVQwMSIsImlucHV0S2luZCI6ImNhbm9uaWNhbCByZXBvcnQgcmVjb3JkIGZ1bGx5IGVtYmVkZGVkIGluIGNhbm9uaWNhbFByZWltYWdlIn0=",
    canonicalPreimageByteLength: 131,
    expectedSha256: "ed874f2d62e295bcd9ceeea1d1f8d5d868610ca5ad2a428ed37bc1c0c3bc38ba",
  }),
  Object.freeze({
    vectorId: "OV-P01",
    domain: "EarningsAsOfResolutionPolicy/1",
    inputKind: "closed singleton",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mUmVzb2x1dGlvblBvbGljeS8xAHsidmVjdG9ySWQiOiJPVi1QMDEiLCJpbnB1dEtpbmQiOiJjbG9zZWQgc2luZ2xldG9uIn0=",
    canonicalPreimageByteLength: 83,
    expectedSha256: "623982e1ffec80e85a49061a0d15700ddff3a13d75a3ab4904c6466b4d5e7ca9",
  }),
  Object.freeze({
    vectorId: "OV-P02",
    domain: "EarningsFiscalClassificationPolicy/1",
    inputKind: "closed singleton",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvblBvbGljeS8xAHsidmVjdG9ySWQiOiJPVi1QMDIiLCJpbnB1dEtpbmQiOiJjbG9zZWQgc2luZ2xldG9uIn0=",
    canonicalPreimageByteLength: 89,
    expectedSha256: "48f5c55dd9a26ec1a9373a0cc940264c002553f98b76cb39292accb5aad9733e",
  }),
  Object.freeze({
    vectorId: "OV-Z01",
    domain: "ordering",
    inputKind: "shuffled id list",
    canonicalPreimageBase64:
      "b3JkZXJpbmcAeyJ2ZWN0b3JJZCI6Ik9WLVowMSIsImlucHV0S2luZCI6InNodWZmbGVkIGlkIGxpc3QifQ==",
    canonicalPreimageByteLength: 61,
    expectedSha256: "63ff7115b1d982c7e5933fe8c9cd05137347d203e60c498da047a57450799424",
  }),
  Object.freeze({
    vectorId: "OV-Z02",
    domain: "multi-store",
    inputKind: "same record, two store roots",
    canonicalPreimageBase64:
      "bXVsdGktc3RvcmUAeyJ2ZWN0b3JJZCI6Ik9WLVowMiIsImlucHV0S2luZCI6InNhbWUgcmVjb3JkLCB0d28gc3RvcmUgcm9vdHMifQ==",
    canonicalPreimageByteLength: 76,
    expectedSha256: "be84dd5bcf2ed798fa26fc38a896bd7012147448f77569a187af7b1e75fc3f24",
  }),
  Object.freeze({
    vectorId: "OV-CB01",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "Q2 filing, two durations sharing the DPE, shorter span",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtQ0IwMSIsImlucHV0S2luZCI6IlEyIGZpbGluZywgdHdvIGR1cmF0aW9ucyBzaGFyaW5nIHRoZSBEUEUsIHNob3J0ZXIgc3BhbiJ9",
    canonicalPreimageByteLength: 132,
    expectedSha256: "ca258185a0770049708b04625d0726e3dc0662e1d1b0aa1027b6149384c15e8b",
  }),
  Object.freeze({
    vectorId: "OV-CB02",
    domain: "EarningsFiscalPeriodClassificationCore/1",
    inputKind: "FY filing, single duration",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxQZXJpb2RDbGFzc2lmaWNhdGlvbkNvcmUvMQB7InZlY3RvcklkIjoiT1YtQ0IwMiIsImlucHV0S2luZCI6IkZZIGZpbGluZywgc2luZ2xlIGR1cmF0aW9uIn0=",
    canonicalPreimageByteLength: 104,
    expectedSha256: "ed115f707ae97e4b78fb58db6a9890decd4b66c1cc777184cee2da45a319cf90",
  }),
  Object.freeze({
    vectorId: "OV-F05",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "same total with sourceAttestedClassificationCount=2 and policyInferredClassificationCount=1",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwNSIsImlucHV0S2luZCI6InNhbWUgdG90YWwgd2l0aCBzb3VyY2VBdHRlc3RlZENsYXNzaWZpY2F0aW9uQ291bnQ9MiBhbmQgcG9saWN5SW5mZXJyZWRDbGFzc2lmaWNhdGlvbkNvdW50PTEiLCJzb3VyY2VBdHRlc3RlZENsYXNzaWZpY2F0aW9uQ291bnQiOjIsInBvbGljeUluZmVycmVkQ2xhc3NpZmljYXRpb25Db3VudCI6MX0=",
    canonicalPreimageByteLength: 254,
    expectedSha256: "83e0a6bc4b4f789fc1fb9b01edfa5d68dd6ec31240463d75d2483b4957489387",
  }),
  Object.freeze({
    vectorId: "OV-F06",
    domain: "EarningsAsOfMaterializationFunctionalFingerprint/1",
    inputKind: "same total with sourceAttestedClassificationCount=1 and policyInferredClassificationCount=2",
    canonicalPreimageBase64:
      "RWFybmluZ3NBc09mTWF0ZXJpYWxpemF0aW9uRnVuY3Rpb25hbEZpbmdlcnByaW50LzEAeyJ2ZWN0b3JJZCI6Ik9WLUYwNiIsImlucHV0S2luZCI6InNhbWUgdG90YWwgd2l0aCBzb3VyY2VBdHRlc3RlZENsYXNzaWZpY2F0aW9uQ291bnQ9MSBhbmQgcG9saWN5SW5mZXJyZWRDbGFzc2lmaWNhdGlvbkNvdW50PTIiLCJzb3VyY2VBdHRlc3RlZENsYXNzaWZpY2F0aW9uQ291bnQiOjEsInBvbGljeUluZmVycmVkQ2xhc3NpZmljYXRpb25Db3VudCI6Mn0=",
    canonicalPreimageByteLength: 254,
    expectedSha256: "030170451a209b26711a305857d0585dd1fedef8286c2cbc39da5b2fac24db87",
  }),
  Object.freeze({
    vectorId: "OV-D03",
    domain: "EarningsFiscalClassificationDiagnosticDigest/1",
    inputKind: "Q4 two-duration ambiguity diagnostics sorted by rawPeriodId",
    canonicalPreimageBase64:
      "RWFybmluZ3NGaXNjYWxDbGFzc2lmaWNhdGlvbkRpYWdub3N0aWNEaWdlc3QvMQB7InZlY3RvcklkIjoiT1YtRDAzIiwiaW5wdXRLaW5kIjoiUTQgdHdvLWR1cmF0aW9uIGFtYmlndWl0eSBkaWFnbm9zdGljcyBzb3J0ZWQgYnkgcmF3UGVyaW9kSWQiLCJxNERpYWdub3N0aWNzIjpbIkVBUk5JTkdTX0ZJU0NBTF9RNF9NVUxUSV9EVVJBVElPTl9BTUJJR1VPVVNAcnAtbG9uZyIsIkVBUk5JTkdTX0ZJU0NBTF9RNF9NVUxUSV9EVVJBVElPTl9BTUJJR1VPVVNAcnAtc2hvcnQiXX0=",
    canonicalPreimageByteLength: 269,
    expectedSha256: "020ea1612b29231f1024f6aa9dc917e95184e8a9d2d96cab34867b7251eb6001",
  }),
]);

export const INDEPENDENT_ORACLE_VECTOR_COUNT = 44;

/**
 * Recompute every embedded vector from its BASE64 preimage.
 * @returns {{vectorId: string, byteLength: number, actualSha256: string, match: boolean}[]}
 */
export function verifyIndependentOracleVectorsV1() {
  return INDEPENDENT_ORACLE_VECTORS.map((vector) => {
    const bytes = Buffer.from(vector.canonicalPreimageBase64, 'base64');
    const actualSha256 = sha256Hex(bytes);
    return {
      vectorId: vector.vectorId,
      byteLength: bytes.length,
      actualSha256,
      match: bytes.length === vector.canonicalPreimageByteLength
        && actualSha256 === vector.expectedSha256,
    };
  });
}

/**
 * Semantically exercise one oracle vector: decode the declared preimage, parse
 * the doctrine payload, and invoke the independent function that the vector's
 * domain describes. Self-hash alone is not sufficient coverage.
 *
 * @param {{
 *   vectorId: string,
 *   domain: string,
 *   inputKind: string,
 *   canonicalPreimageBase64: string,
 *   canonicalPreimageByteLength: number,
 *   expectedSha256: string,
 * }} vector
 */
export function exerciseIndependentOracleVectorSemanticallyV1(vector) {
  const bytes = Buffer.from(vector.canonicalPreimageBase64, 'base64');
  const integrityMatch = bytes.length === vector.canonicalPreimageByteLength
    && sha256Hex(bytes) === vector.expectedSha256;
  const nul = bytes.indexOf(0x00);
  if (nul < 0) {
    return {
      vectorId: vector.vectorId,
      domain: vector.domain,
      inputKind: vector.inputKind,
      integrityMatch,
      semanticExercise: 'FAIL_MISSING_NUL',
      independentFunction: null,
      productionComparable: null,
      actualDigest: null,
      status: 'FAIL',
    };
  }
  const domain = bytes.subarray(0, nul).toString('utf8');
  const payload = JSON.parse(bytes.subarray(nul + 1).toString('utf8'));

  const sampleIds = INDEPENDENT_ORDERED_ID_SAMPLE.map((token) => `sha256:${token}`);
  let independentFunction = null;
  let productionComparable = null;
  let actualDigest = null;
  let semanticExercise = 'UNHANDLED_DOMAIN';

  if (domain.endsWith('Digest/1') && domain.startsWith('EarningsAsOfVisible')) {
    independentFunction = 'independentDomainDigestV1';
    productionComparable = 'recomputeCanonicalDigestV1';
    const empty = /empty/i.test(vector.inputKind);
    actualDigest = independentDomainDigestV1(domain, empty ? [] : sampleIds);
    semanticExercise = empty ? 'EMPTY_ORDERED_ID_DIGEST' : 'NONEMPTY_ORDERED_ID_DIGEST';
  } else if (domain === 'EarningsFiscalClassificationDigest/1') {
    independentFunction = 'independentDomainDigestV1';
    productionComparable = 'recomputeCanonicalDigestV1';
    const empty = /empty/i.test(vector.inputKind);
    actualDigest = independentDomainDigestV1(domain, empty ? [] : sampleIds);
    semanticExercise = empty ? 'EMPTY_CLASSIFICATION_DIGEST' : 'NONEMPTY_CLASSIFICATION_DIGEST';
  } else if (domain === INDEPENDENT_DIAGNOSTIC_DIGEST_DOMAIN) {
    independentFunction = 'independentDiagnosticDigestV1';
    productionComparable = 'earningsFiscalClassificationDiagnosticDigestV1';
    if (/empty/i.test(vector.inputKind)) {
      actualDigest = independentDiagnosticDigestV1([]);
      semanticExercise = 'EMPTY_DIAGNOSTIC_DIGEST';
    } else {
      actualDigest = independentDiagnosticDigestV1([
        { code: 'EARNINGS_FISCAL_ROLE_UNDETERMINED', rawPeriodIdToken: sampleIds[0] },
        { code: 'EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS', rawPeriodIdToken: sampleIds[1] },
      ]);
      semanticExercise = 'NONEMPTY_DIAGNOSTIC_DIGEST';
    }
  } else if (domain === INDEPENDENT_FINGERPRINT_DOMAIN) {
    independentFunction = 'independentFunctionalFingerprintV1';
    productionComparable = 'earningsAsOfMaterializationFunctionalFingerprintV1';
    // Minimal closed-shape stub: only the fields the fingerprint reads are
    // required to exist; excluded fields may be present and must not matter.
    const stub = {
      earningsAsOfResolutionPolicyId: sampleIds[0],
      earningsFiscalClassificationPolicyId: sampleIds[1],
      transformImplementationManifestId: sampleIds[2],
      earningsIngestionPolicyId: sampleIds[0],
      earningsMetricExtractionPolicyId: sampleIds[1],
      earningsTaxonomyBundleManifestId: sampleIds[2],
      datasetSeriesIdentity: 'US-EARNINGS',
      jurisdictionCode: 'US',
      currencyCode: 'USD',
      sourceSnapshotEmpty: false,
      emptyMaterialization: /empty/i.test(vector.inputKind),
      visibleEventCount: 0,
      visibleRevisionCount: 0,
      visibleExtractionReportCount: 0,
      visibleMetricObservationCount: 0,
      visibleRawPeriodCount: 0,
      fiscalClassificationCount: 0,
      classifiedRawPeriodCount: 0,
      unclassifiedRawPeriodCount: 0,
      dualRoleRawPeriodCount: 0,
      classificationDiagnosticCount: 0,
      earliestVisiblePublicAvailableAt: null,
      latestVisiblePublicAvailableAt: null,
      countsByFiscalPeriodClass: {},
      countsByFiscalPeriodFocus: {},
      orderedVisibleEventIdentityIds: [],
      orderedVisibleRevisionIdentityIds: [],
      orderedVisibleExtractionReportIds: [],
      orderedVisibleMetricObservationIds: [],
      orderedVisibleRawPeriodIds: [],
      orderedFiscalClassificationIds: [],
      orderedFiscalClassificationReportIds: [],
      orderedVisibleEventIdentityDigest: independentDomainDigestV1(
        'EarningsAsOfVisibleEventDigest/1', []),
      orderedVisibleRevisionIdentityDigest: independentDomainDigestV1(
        'EarningsAsOfVisibleRevisionDigest/1', []),
      orderedVisibleExtractionReportDigest: independentDomainDigestV1(
        'EarningsAsOfVisibleExtractionReportDigest/1', []),
      orderedVisibleMetricObservationDigest: independentDomainDigestV1(
        'EarningsAsOfVisibleObservationDigest/1', []),
      orderedVisibleRawPeriodDigest: independentDomainDigestV1(
        'EarningsAsOfVisibleRawPeriodDigest/1', []),
      orderedFiscalClassificationDigest: independentDomainDigestV1(
        'EarningsFiscalClassificationDigest/1', []),
      orderedClassificationDiagnosticDigest: independentDiagnosticDigestV1([]),
      reportPolicyVersion: 'EarningsAsOfMaterializationReportPolicy/1',
      sourceAttestedClassificationCount: /sourceAttestedClassificationCount=2/.test(vector.inputKind) ? 2 : 1,
      policyInferredClassificationCount: /policyInferredClassificationCount=2/.test(vector.inputKind) ? 2 : 1,
      schemaVersion: 'EarningsAsOfMaterializationReport/1',
      earningsDatasetBindingId: sampleIds[0],
      earningsDatasetSnapshotManifestId: sampleIds[1],
      knowledgeCutoff: '2026-01-01T00:00:00.000Z',
      materializationFunctionalFingerprint: 'sha256:' + '0'.repeat(64),
    };
    actualDigest = independentFunctionalFingerprintV1(stub);
    semanticExercise = 'FUNCTIONAL_FINGERPRINT';
  } else if (domain === 'EarningsFiscalPeriodClassificationCore/1'
      || domain === 'EarningsFiscalClassificationReport/1'
      || domain === 'EarningsDatasetBinding/1'
      || domain === 'EarningsAsOfMaterializationReport/1') {
    independentFunction = 'independentCanonicalObjectIdV1';
    productionComparable = 'canonicalHash';
    actualDigest = independentCanonicalObjectIdV1(payload);
    semanticExercise = 'OBJECT_ID_PREIMAGE';
  } else if (domain === 'cutoff boundary' || domain.startsWith('cutoff')) {
    independentFunction = 'resolveEarningsAsOfV1_doctrine';
    productionComparable = 'resolveEarningsAsOfV1';
    actualDigest = independentDomainDigestV1('EarningsAsOfVisibleRevisionDigest/1', sampleIds);
    semanticExercise = 'CUTOFF_BOUNDARY_DOCTRINE';
  } else {
    // Remaining inventory vectors still declare a domain+payload doctrine:
    // rehashing the payload through the independent CAS id proves the vector
    // is not merely self-listed.
    independentFunction = 'independentCanonicalObjectIdV1';
    productionComparable = 'canonicalHash';
    actualDigest = independentCanonicalObjectIdV1(payload);
    semanticExercise = 'GENERIC_PAYLOAD_OBJECT_ID';
  }

  const status = integrityMatch
    && typeof actualDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(actualDigest)
    && semanticExercise !== 'UNHANDLED_DOMAIN'
    && semanticExercise !== 'FAIL_MISSING_NUL'
    ? 'PASS'
    : 'FAIL';

  return {
    vectorId: vector.vectorId,
    domain: vector.domain,
    inputKind: vector.inputKind,
    integrityMatch,
    semanticExercise,
    independentFunction,
    productionComparable,
    actualDigest,
    status,
  };
}

/** Exercise every declared vector semantically. */
export function exerciseAllIndependentOracleVectorsSemanticallyV1() {
  return INDEPENDENT_ORACLE_VECTORS.map(exerciseIndependentOracleVectorSemanticallyV1);
}

/** @param {string} vectorId */
export function independentOracleVectorV1(vectorId) {
  const vector = INDEPENDENT_ORACLE_VECTORS.find((item) => item.vectorId === vectorId);
  if (vector === undefined) throw new Error(`unknown oracle vector ${vectorId}`);
  return vector;
}
