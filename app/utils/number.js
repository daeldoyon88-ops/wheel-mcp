export function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

export function roundMoney(value) {
  if (value == null || Number.isNaN(value)) return 0;
  return Number(value.toFixed(2));
}

export function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
