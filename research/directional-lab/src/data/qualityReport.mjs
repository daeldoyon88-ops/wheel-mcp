/**
 * Assemble a human-oriented data quality report from a manifest + validation.
 * Pure function: no I/O.
 */

/**
 * @param {{manifest: Object, validation: {problems: string[], warnings: string[], stats: Object}}} input
 * @returns {Object}
 */
export function buildQualityReport(input) {
  const { manifest, validation } = input;
  const m = /** @type {any} */ (manifest);
  const admissible = validation.problems.length === 0 && m.barCount > 0;
  const refusalReasons = [];
  if (m.barCount === 0) refusalReasons.push('no bars');
  for (const p of validation.problems) refusalReasons.push(p);
  return {
    symbol: m.symbol,
    sourcePath: m.sourcePath,
    sourceGitStatus: m.sourceGitStatus,
    format: m.sourceFormat,
    coverage: {
      firstDate: m.firstDate,
      lastDate: m.lastDate,
      bars: m.barCount,
      missingWeekdays: m.gapStats.missingWeekdays,
      maxConsecutiveMissingWeekdays: m.gapStats.maxConsecutiveMissingWeekdays,
    },
    availability: {
      volume: m.volumeAvailable,
      rawOhlc: m.rawOhlcAvailable,
      adjustedOhlc: m.adjustedOhlcAvailable,
      adjustedClose: m.adjustedCloseAvailable,
      nativeAdjustmentType: m.nativeAdjustmentType,
      splitsDocumented: m.splitsDocumented,
    },
    qualityFlags: m.qualityFlags,
    problems: validation.problems,
    warnings: validation.warnings,
    admissible,
    refusalReasons,
  };
}
