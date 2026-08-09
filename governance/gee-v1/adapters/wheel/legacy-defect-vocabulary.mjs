/**
 * Wheel adapter — legacy defect vocabulary.
 * RC-5 support: the TOTAL legacy-to-canonical map lives here, in the adapter,
 * never as a complement in the core. Any Wheel defect status not explicitly
 * listed is UNMAPPED, and translateWheelLegacyDefectsDocument refuses to
 * produce a document for it — the caller must treat the whole document as
 * UNKNOWN. An unmapped legacy value is a governance event requiring a
 * deliberate decision to extend this map, never a silent default.
 */

import { CANONICAL_DEFECT_STATUSES } from '../../core/defect-status.mjs';

export const WHEEL_LEGACY_DEFECT_VOCABULARY = Object.freeze({
  OPEN: 'OPEN',
  IN_REPAIR: 'IN_REPAIR',
  BLOCKED: 'BLOCKED',
  REOPENED: 'REOPENED',
  CLOSED: 'CLOSED',
  WITHDRAWN: 'WITHDRAWN',
  SUPERSEDED: 'SUPERSEDED'
});

export function mapWheelLegacyDefectStatus(rawStatus) {
  if (typeof rawStatus !== 'string') return null;
  const mapped = WHEEL_LEGACY_DEFECT_VOCABULARY[rawStatus];
  return CANONICAL_DEFECT_STATUSES.includes(mapped) ? mapped : null;
}

/**
 * @returns the document with every status translated to its canonical value,
 * or null if the document is malformed or contains ANY unmapped status —
 * never a partial translation.
 */
export function translateWheelLegacyDefectsDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.defects)) return null;
  const translated = [];
  for (const defect of raw.defects) {
    if (!defect || typeof defect !== 'object' || Array.isArray(defect)) return null;
    const mapped = mapWheelLegacyDefectStatus(defect.status);
    if (!mapped) return null;
    translated.push({ ...defect, status: mapped });
  }
  return { ...raw, defects: translated };
}
