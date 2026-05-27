/**
 * Normalise toute valeur d'expiration connue vers "YYYY-MM-DD".
 * Accepte compact YYYYMMDD, ISO (avec ou sans heure), Date, number.
 */
export function normalizeExpirationKey(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeExpirationKey(String(Math.trunc(value)));
  }

  const s = String(value).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return null;
}

/** Champs d'expiration pertinents sur une carte dashboard / enrichie. */
export function collectCandidateExpirationKeys(item) {
  if (!item || typeof item !== "object") return [];
  const fields = [
    item.targetExpiration,
    item.selectedExpiration,
    item.expiration,
    item.expirationDate,
    item.contractExpiration,
    item.expiry,
    item.raw?.expiration,
    item.ibkrDirect?.expiration,
    item.yahoo?.targetExpiration,
    item.yahoo?.expiration,
    item.safeStrike?.expiration,
    item.aggressiveStrike?.expiration,
  ];
  return [...new Set(fields.map(normalizeExpirationKey).filter(Boolean))];
}

/**
 * Filtre d'affichage : la carte correspond si au moins une expiration embarquée
 * normalisée égale la sélection (évite les faux rejets sur champs imbriqués périmés).
 */
export function candidateRowMatchesSelectedExpiration(item, selectedExp) {
  const sel = normalizeExpirationKey(selectedExp);
  if (!sel) return true;

  const keys = collectCandidateExpirationKeys(item);
  if (keys.length === 0) return true;

  return keys.some((key) => key === sel);
}
