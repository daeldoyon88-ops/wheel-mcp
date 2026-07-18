/**
 * Purge & embargo for overlapping-horizon research (label leakage control).
 *
 *  - purge: training observations whose civil date falls within `purgeDays`
 *    BEFORE the test start are removed (their forward-looking labels would
 *    overlap the test window);
 *  - embargo: training observations within `embargoDays` AFTER the test end
 *    are removed (test-window information bleeds into them).
 */

import { toEpochDay } from './civilDate.mjs';

/**
 * @param {{trainDates: string[], testStart: string, testEnd: string, purgeDays?: number, embargoDays?: number}} input
 * @returns {{kept: string[], purged: string[], embargoed: string[]}}
 */
export function applyPurgeEmbargo(input) {
  const { trainDates, testStart, testEnd } = input;
  const purgeDays = input.purgeDays ?? 0;
  const embargoDays = input.embargoDays ?? 0;
  if (purgeDays < 0 || embargoDays < 0) throw new Error('purgeDays/embargoDays must be >= 0');
  const startDay = toEpochDay(testStart);
  const endDay = toEpochDay(testEnd);
  if (endDay < startDay) throw new Error(`testEnd ${testEnd} precedes testStart ${testStart}`);

  const kept = [];
  const purged = [];
  const embargoed = [];
  for (const date of trainDates) {
    const day = toEpochDay(date);
    if (day >= startDay && day <= endDay) {
      // A training date inside the test window is always removed (counted as purged).
      purged.push(date);
    } else if (day < startDay && startDay - day <= purgeDays) {
      purged.push(date);
    } else if (day > endDay && day - endDay <= embargoDays) {
      embargoed.push(date);
    } else {
      kept.push(date);
    }
  }
  return { kept, purged, embargoed };
}
