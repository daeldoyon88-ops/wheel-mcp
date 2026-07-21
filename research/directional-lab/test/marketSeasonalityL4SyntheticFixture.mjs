import { addDays } from '../src/time/civilDate.mjs';

const ID = (digit) => `sha256:${digit.repeat(64)}`;

export function makeSeasonalityCausalFixture(options = {}) {
  const firstYear = options.firstYear ?? 2010;
  const lastYear = options.lastYear ?? 2026;
  const sessionsPerYear = options.sessionsPerYear ?? 62;
  const calendarSessions = [];
  const calendarCoverage = [];
  const sourceRows = [];
  let identityCounter = 1;
  for (let year = firstYear; year <= lastYear; year += 1) {
    const start = `${year}-01-02`;
    calendarCoverage.push({
      coverageFromDate: `${year}-01-01`,
      coverageToDateExclusive: `${year}-04-15`,
    });
    for (let offset = 0; offset < sessionsPerYear; offset += 1) {
      const sessionDate = addDays(start, offset);
      calendarSessions.push({
        sessionDate,
        sessionKind: offset === 20 ? 'HALF_DAY_SESSION' : 'REGULAR_SESSION',
      });
      const close = 10_000n + BigInt((year - firstYear) * 100 + offset);
      sourceRows.push({
        instrumentIdentityId: ID('a'),
        barIdentityId: `sha256:${identityCounter.toString(16).padStart(64, '0')}`,
        sessionDate,
        frequency: 'DAILY_REGULAR_SESSION',
        currency: 'USD',
        openAtoms: close.toString(),
        highAtoms: (close + 25n).toString(),
        lowAtoms: (close - 20n).toString(),
        closeAtoms: close.toString(),
        priceScale: 2,
        volumeAtoms: '1000',
        volumeScale: 0,
        priceBasis: 'RAW',
        resolvedObservationId: `sha256:${(identityCounter + 100_000).toString(16).padStart(64, '0')}`,
        resolvedCorrectionTipId: `sha256:${(identityCounter + 200_000).toString(16).padStart(64, '0')}`,
      });
      identityCounter += 1;
    }
  }
  calendarSessions.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  sourceRows.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate)
    || left.barIdentityId.localeCompare(right.barIdentityId));
  return {
    sourceRows,
    calendarSessions,
    calendarCoverage,
    sourceBundleId: ID('c'),
    computationPolicyId: ID('d'),
    sourceBundle: {
      subjectBindingId: ID('b'),
      instrumentIdentityId: ID('a'),
      priceBasis: 'RAW',
      corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    },
  };
}
