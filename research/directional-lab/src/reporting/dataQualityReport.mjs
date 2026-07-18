/**
 * Text rendering of a data quality report (see data/qualityReport.mjs).
 */

/**
 * @param {Object} report output of buildQualityReport
 * @returns {string}
 */
export function renderQualityReport(report) {
  const r = /** @type {any} */ (report);
  const lines = [
    `=== Data quality — ${r.symbol} ===`,
    `source: ${r.sourcePath} (${r.sourceGitStatus}, ${r.format})`,
    `coverage: ${r.coverage.firstDate} -> ${r.coverage.lastDate} (${r.coverage.bars} bars, ${r.coverage.missingWeekdays} missing weekdays, max gap ${r.coverage.maxConsecutiveMissingWeekdays})`,
    `availability: volume=${r.availability.volume} rawOhlc=${r.availability.rawOhlc} adjustedOhlc=${r.availability.adjustedOhlc} (${r.availability.nativeAdjustmentType ?? 'n/a'}) adjustedClose=${r.availability.adjustedClose} splitsDocumented=${r.availability.splitsDocumented}`,
    `qualityFlags: ${r.qualityFlags.length ? r.qualityFlags.join(', ') : 'none'}`,
    `admissible: ${r.admissible ? 'YES' : `NO (${r.refusalReasons.join('; ')})`}`,
  ];
  if (r.problems.length > 0) {
    lines.push('problems:');
    for (const p of r.problems.slice(0, 20)) lines.push(`  - ${p}`);
    if (r.problems.length > 20) lines.push(`  ... ${r.problems.length - 20} more`);
  }
  if (r.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of r.warnings.slice(0, 20)) lines.push(`  - ${w}`);
    if (r.warnings.length > 20) lines.push(`  ... ${r.warnings.length - 20} more`);
  }
  return lines.join('\n');
}
