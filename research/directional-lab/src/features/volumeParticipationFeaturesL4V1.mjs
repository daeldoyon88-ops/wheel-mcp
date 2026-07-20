/**
 * L4A-B1 — volume baselines, relative volume, deterministic volume
 * percentile, OBV, accumulation/distribution, Chaikin money flow, money flow
 * index and closed price-volume confirmation/divergence booleans.
 *
 * Closed conventions:
 * - the 20/50 volume baselines average the previous sessions only, the
 *   current session is always excluded;
 * - relativeVolume is computed from the exact window sum (volume × period /
 *   windowSum) with a single HALF_EVEN rounding at the internal scale;
 * - the volume percentile uses the deterministic median rank
 *   (2·countLess + countEqual) / (2·N) against the 60 previous sessions;
 * - OBV starts at exactly zero on the first snapshot row and is therefore
 *   relative to the snapshot start; volumes are consumed from the second
 *   row onward and a null volume poisons all later OBV values;
 * - on a flat bar (high = low) the money flow multiplier and money flow
 *   volume are both exactly zero for this family (closed policy convention,
 *   distinct from the L4A-A closeLocationValue which stays unavailable);
 * - the A/D line accumulates from zero before the snapshot start;
 * - MFI classifies typical-price transitions (equality feeds neither flow)
 *   over 14 admissible transitions; its first available index is 14
 *   (the fifteenth row), and closed limit cases are 50 / 100 / 0.
 */

import {
  FEATURE_CALCULATION_SCALE,
  availableFixedCell,
  divideRoundHalfEven,
  fixedFromScaledAtoms,
  powerOfTen,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';

const OBV_DELTA_PERIODS = Object.freeze([5, 20, 60]);
const PERCENTILE_WINDOW = 60;
const CMF_PERIOD = 20;
const MFI_PERIOD = 14;

/** @param {bigint|null} atoms */
function fixedCellFromAtoms(atoms) {
  if (atoms === null) return unavailableCell('MISSING_INPUT');
  return availableFixedCell(fixedFromScaledAtoms(atoms));
}

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<{value: any, availability: string}>} return20Cells L4A-A return20 cells
 */
export function computeVolumeParticipationFeatures(bars, return20Cells) {
  const unit = powerOfTen(FEATURE_CALCULATION_SCALE);
  const count = bars.length;
  const volumeAtoms = bars.map((bar) => (bar.volume === null ? null : bar.volume.atoms));

  const prefixVolume = [0n];
  const lastNullVolume = [-1];
  for (let index = 0; index < count; index += 1) {
    prefixVolume.push(prefixVolume[index] + (volumeAtoms[index] ?? 0n));
    lastNullVolume.push(volumeAtoms[index] === null ? index : lastNullVolume[index]);
  }
  const volumeWindowClean = (start, end) => lastNullVolume[end + 1] < start;
  const volumeWindowSum = (start, end) => prefixVolume[end + 1] - prefixVolume[start];

  const meanCells = new Map();
  const meanWindowSums = new Map();
  for (const period of [20, 50]) {
    const cells = [];
    const sums = [];
    for (let index = 0; index < count; index += 1) {
      if (index < period) {
        cells.push(unavailableCell('INSUFFICIENT_HISTORY'));
        sums.push(null);
        continue;
      }
      if (!volumeWindowClean(index - period, index - 1)) {
        cells.push(unavailableCell('MISSING_INPUT'));
        sums.push(null);
        continue;
      }
      const sum = volumeWindowSum(index - period, index - 1);
      sums.push(sum);
      cells.push(availableFixedCell(fixedFromScaledAtoms(divideRoundHalfEven(sum, BigInt(period)))));
    }
    meanCells.set(period, cells);
    meanWindowSums.set(period, sums);
  }

  const relativeInternal = new Map();
  for (const period of [20, 50]) {
    const cells = [];
    for (let index = 0; index < count; index += 1) {
      const sum = meanWindowSums.get(period)[index];
      if (sum === null) {
        cells.push({ atoms: null, availability: meanCells.get(period)[index].availability });
        continue;
      }
      if (volumeAtoms[index] === null) {
        cells.push({ atoms: null, availability: 'MISSING_INPUT' });
        continue;
      }
      if (sum === 0n) {
        cells.push({ atoms: null, availability: 'DIVISION_BY_ZERO' });
        continue;
      }
      cells.push({
        atoms: divideRoundHalfEven(volumeAtoms[index] * BigInt(period) * unit, sum),
        availability: 'AVAILABLE',
      });
    }
    relativeInternal.set(period, cells);
  }

  const percentileCells = [];
  for (let index = 0; index < count; index += 1) {
    if (index < PERCENTILE_WINDOW) {
      percentileCells.push(unavailableCell('INSUFFICIENT_HISTORY'));
      continue;
    }
    if (volumeAtoms[index] === null || !volumeWindowClean(index - PERCENTILE_WINDOW, index - 1)) {
      percentileCells.push(unavailableCell('MISSING_INPUT'));
      continue;
    }
    let countLess = 0n;
    let countEqual = 0n;
    for (let cursor = index - PERCENTILE_WINDOW; cursor < index; cursor += 1) {
      if (volumeAtoms[cursor] < volumeAtoms[index]) countLess += 1n;
      else if (volumeAtoms[cursor] === volumeAtoms[index]) countEqual += 1n;
    }
    const numerator = (2n * countLess + countEqual) * unit;
    percentileCells.push(availableFixedCell(fixedFromScaledAtoms(
      divideRoundHalfEven(numerator, 2n * BigInt(PERCENTILE_WINDOW)),
    )));
  }

  const obvAtoms = [];
  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      obvAtoms.push(0n);
      continue;
    }
    const previous = obvAtoms[index - 1];
    if (previous === null || volumeAtoms[index] === null) {
      obvAtoms.push(null);
      continue;
    }
    const current = bars[index].close.atoms;
    const before = bars[index - 1].close.atoms;
    if (current > before) obvAtoms.push(previous + volumeAtoms[index]);
    else if (current < before) obvAtoms.push(previous - volumeAtoms[index]);
    else obvAtoms.push(previous);
  }
  const deltaFor = (series, index, period) => {
    if (index < period) return { atoms: null, availability: 'INSUFFICIENT_HISTORY' };
    if (series[index] === null || series[index - period] === null) {
      return { atoms: null, availability: 'MISSING_INPUT' };
    }
    return { atoms: series[index] - series[index - period], availability: 'AVAILABLE' };
  };

  const rangeAtoms = bars.map((bar) => bar.high.atoms - bar.low.atoms);
  const mfmAtoms = bars.map((bar, index) => (
    rangeAtoms[index] === 0n
      ? 0n
      : divideRoundHalfEven(
        (2n * bar.close.atoms - bar.high.atoms - bar.low.atoms) * unit,
        rangeAtoms[index],
      )
  ));
  const mfvAtoms = bars.map((bar, index) => {
    if (rangeAtoms[index] === 0n) return 0n;
    if (volumeAtoms[index] === null) return null;
    return divideRoundHalfEven(mfmAtoms[index] * volumeAtoms[index], unit);
  });
  const adAtoms = [];
  for (let index = 0; index < count; index += 1) {
    const previous = index === 0 ? 0n : adAtoms[index - 1];
    if (previous === null || mfvAtoms[index] === null) adAtoms.push(null);
    else adAtoms.push(previous + mfvAtoms[index]);
  }
  const prefixMfv = [0n];
  const lastNullMfv = [-1];
  for (let index = 0; index < count; index += 1) {
    prefixMfv.push(prefixMfv[index] + (mfvAtoms[index] ?? 0n));
    lastNullMfv.push(mfvAtoms[index] === null ? index : lastNullMfv[index]);
  }

  const cmfCells = [];
  for (let index = 0; index < count; index += 1) {
    if (index + 1 < CMF_PERIOD) {
      cmfCells.push(unavailableCell('INSUFFICIENT_HISTORY'));
      continue;
    }
    const start = index - CMF_PERIOD + 1;
    if (!volumeWindowClean(start, index) || lastNullMfv[index + 1] >= start) {
      cmfCells.push(unavailableCell('MISSING_INPUT'));
      continue;
    }
    const sumVolume = volumeWindowSum(start, index);
    if (sumVolume === 0n) {
      cmfCells.push(unavailableCell('ZERO_TOTAL_VOLUME'));
      continue;
    }
    const sumMfv = prefixMfv[index + 1] - prefixMfv[start];
    cmfCells.push(availableFixedCell(fixedFromScaledAtoms(
      divideRoundHalfEven(sumMfv * unit, sumVolume),
    )));
  }

  const typicalAtoms = bars.map((bar) => divideRoundHalfEven(
    bar.high.atoms + bar.low.atoms + bar.close.atoms, 3n,
  ));
  const rawMoneyFlowAtoms = bars.map((bar, index) => (
    volumeAtoms[index] === null
      ? null
      : divideRoundHalfEven(typicalAtoms[index] * volumeAtoms[index], unit)
  ));
  const mfiCells = [];
  for (let index = 0; index < count; index += 1) {
    if (index < MFI_PERIOD) {
      mfiCells.push(unavailableCell('INSUFFICIENT_HISTORY'));
      continue;
    }
    let positive = 0n;
    let negative = 0n;
    let missing = false;
    for (let cursor = index - MFI_PERIOD + 1; cursor <= index; cursor += 1) {
      if (rawMoneyFlowAtoms[cursor] === null) {
        missing = true;
        break;
      }
      if (typicalAtoms[cursor] > typicalAtoms[cursor - 1]) positive += rawMoneyFlowAtoms[cursor];
      else if (typicalAtoms[cursor] < typicalAtoms[cursor - 1]) negative += rawMoneyFlowAtoms[cursor];
    }
    if (missing) {
      mfiCells.push(unavailableCell('MISSING_INPUT'));
      continue;
    }
    let atoms;
    if (positive === 0n && negative === 0n) atoms = 50n * unit;
    else if (negative === 0n) atoms = 100n * unit;
    else if (positive === 0n) atoms = 0n;
    else atoms = divideRoundHalfEven(positive * 100n * unit, positive + negative);
    mfiCells.push(availableFixedCell(fixedFromScaledAtoms(atoms)));
  }

  const rows = bars.map((bar, index) => {
    const obvDeltas = {};
    for (const period of OBV_DELTA_PERIODS) {
      const delta = deltaFor(obvAtoms, index, period);
      obvDeltas[period] = delta.atoms === null
        ? { cell: unavailableCell(delta.availability), internal: delta }
        : { cell: availableFixedCell(fixedFromScaledAtoms(delta.atoms)), internal: delta };
    }
    const adDelta = deltaFor(adAtoms, index, 20);

    const return20 = return20Cells[index];
    const obvDelta20 = obvDeltas[20].internal;
    let comparison;
    if (return20.availability !== 'AVAILABLE') comparison = { reason: return20.availability };
    else if (obvDelta20.availability !== 'AVAILABLE') comparison = { reason: obvDelta20.availability };
    else {
      const priceUp = return20.value.atoms > 0n;
      const priceDown = return20.value.atoms < 0n;
      const flowUp = obvDelta20.atoms > 0n;
      const flowDown = obvDelta20.atoms < 0n;
      comparison = {
        bullishConfirmation: priceUp && flowUp,
        bearishConfirmation: priceDown && flowDown,
        bullishDivergence: priceDown && flowUp,
        bearishDivergence: priceUp && flowDown,
      };
    }
    const comparisonCell = (name) => (
      comparison.reason
        ? unavailableCell(comparison.reason)
        : { value: comparison[name], availability: 'AVAILABLE' }
    );

    return {
      volumeMean20Previous: meanCells.get(20)[index],
      volumeMean50Previous: meanCells.get(50)[index],
      relativeVolume20: relativeInternal.get(20)[index].atoms === null
        ? unavailableCell(relativeInternal.get(20)[index].availability)
        : availableFixedCell(fixedFromScaledAtoms(relativeInternal.get(20)[index].atoms)),
      relativeVolume50: relativeInternal.get(50)[index].atoms === null
        ? unavailableCell(relativeInternal.get(50)[index].availability)
        : availableFixedCell(fixedFromScaledAtoms(relativeInternal.get(50)[index].atoms)),
      volumePercentile60Previous: percentileCells[index],
      obv: index === 0
        ? availableFixedCell(fixedFromScaledAtoms(0n))
        : fixedCellFromAtoms(obvAtoms[index]),
      obvDelta5: obvDeltas[5].cell,
      obvDelta20: obvDeltas[20].cell,
      obvDelta60: obvDeltas[60].cell,
      moneyFlowMultiplier: availableFixedCell(fixedFromScaledAtoms(mfmAtoms[index])),
      moneyFlowVolume: fixedCellFromAtoms(mfvAtoms[index]),
      accumulationDistributionLine: fixedCellFromAtoms(adAtoms[index]),
      adLineDelta20: adDelta.atoms === null
        ? unavailableCell(adDelta.availability)
        : availableFixedCell(fixedFromScaledAtoms(adDelta.atoms)),
      chaikinMoneyFlow20: cmfCells[index],
      moneyFlowIndex14: mfiCells[index],
      priceVolumeBullishConfirmation20: comparisonCell('bullishConfirmation'),
      priceVolumeBearishConfirmation20: comparisonCell('bearishConfirmation'),
      bullishPriceVolumeDivergence20: comparisonCell('bullishDivergence'),
      bearishPriceVolumeDivergence20: comparisonCell('bearishDivergence'),
    };
  });

  return {
    rows,
    relativeVolume20Internal: relativeInternal.get(20),
  };
}
