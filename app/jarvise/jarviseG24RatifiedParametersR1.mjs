export const G24_FOUNDATION_R1 = Object.freeze({
  parameterSetLabel: 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET',
  classifierVersionLabel: 'WHEEL_JARVISE_G24_CORE_V1_CLASSIFIER',
  calendarWindowBindingId: 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023',
  calendarRegistryManifestId: 'sha256:37c793ae00853944a2e3c4330a3aa2e7444f7ad72f2b7df857bcb4186c298232',
  calendarNamespaceVersion: 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/1',
  sessionCount: 21,
});

export const G24_PARAMETER_DECLARATIONS_R1 = Object.freeze([
  ['primaryMarketRegime', 'trendMemberKey', 'F1_SIMPLE_RETURN@W21'],
  ['primaryMarketRegime', 'trendShortMemberKey', 'F1_SIMPLE_RETURN@W5'],
  ['primaryMarketRegime', 'drawdownMemberKey', 'F3_MAX_DRAWDOWN@W21'],
  ['primaryMarketRegime', 'liquidityMemberKey', 'F4_RELATIVE_VOLUME@W21'],
  ['volatilityState', 'volatilityMemberKey', 'F2_REALIZED_VOLATILITY@W21'],
  ['inflationState', 'seriesCode', 'cpiYoY'],
  ['ratesState', 'seriesCode', 'US.TREAS.DGS10'],
  ['yieldCurveShape', 'producerFeatureCode', 'curveShape'],
  ['yieldCurveDirection', 'producerFeatureCode', 'curveDirection'],
  ['primaryMarketRegime', 'bullReturnMin', 0.05],
  ['primaryMarketRegime', 'bearReturnMax', -0.05],
  ['primaryMarketRegime', 'rangeAbsReturnMax', 0.02],
  ['primaryMarketRegime', 'crisisDrawdownMax', -0.20],
  ['primaryMarketRegime', 'liquidityStressRatioMin', 3.0],
  ['primaryMarketRegime', 'recoveryShortReturnMin', 0.03],
  ['volatilityState', 'calmMax', 0.10],
  ['volatilityState', 'normalMax', 0.20],
  ['volatilityState', 'volatileMax', 0.35],
  ['inflationState', 'inflationaryMin', 3.0],
  ['inflationState', 'disinflationaryMax', 1.0],
  ['ratesState', 'risingDeltaMin', 0.25],
  ['ratesState', 'fallingDeltaMax', -0.25],
].map(([dimension, parameterName, value]) => Object.freeze({ dimension, parameterName, value })));

const feature = (featureDefinitionId, formulaId, requiredObservedFields, details) => Object.freeze({
  schemaVersion: 'WHEEL_JARVISE_G24_FEATURE_SEMANTIC_DECLARATION/1',
  featureDefinitionId,
  familyId: featureDefinitionId,
  formulaId,
  formulaVersion: '1',
  requiredObservedFields,
  sessionCount: 21,
  observedSessionCount: 22,
  producerStatus: 'NOT_IMPLEMENTED',
  ...details,
});

export const G24_FEATURE_SEMANTICS_R1 = Object.freeze([
  feature('F2_REALIZED_VOLATILITY', 'WHEEL_JARVISE_REALIZED_VOLATILITY/1', ['close'], {
    dailyReturn: 'ln(close_i / close_i-1)', estimator: 'sampleStandardDeviation', divisor: 20,
    annualizationConvention: 'FIXED_V1', annualizationFactor: 'sqrt(252)', unit: 'ANNUALIZED_DECIMAL_FRACTION', range: '[0,+infinity)',
  }),
  feature('F3_MAX_DRAWDOWN', 'WHEEL_JARVISE_MAX_DRAWDOWN/1', ['close'], {
    runningPeak: 'max(close_0 ... close_t)', drawdown: 'close_t / P_t - 1', aggregation: 'min(d_0 ... d_21)',
    unit: 'SIGNED_DECIMAL_FRACTION', range: '(-1,0]', noDrawdown: 0, deeperDrawdown: 'MORE_NEGATIVE',
  }),
  feature('F4_RELATIVE_VOLUME', 'WHEEL_JARVISE_RELATIVE_VOLUME/1', ['volume'], {
    current: 'volume(T)', baseline: 'arithmetic mean of PRIOR 21 sessions', currentParticipatesInBaseline: false,
    formula: 'current / baseline', unit: 'DIMENSIONLESS_RATIO', neutral: 1.0, zeroCurrent: 0.0,
    zeroBaselinePolicy: 'FAIL_CLOSED', producerBlockingGap: 'G23_MATERIALIZER_COMPUTE_PROJECTION_GAP',
    gate23DefinitionConstruction: 'DEFERRED_REQUIRES_COMPUTE_FUNCTION',
  }),
]);

export const G24_MACRO_SEMANTICS_R1 = Object.freeze([
  Object.freeze({ schemaVersion: 'WHEEL_JARVISE_G24_MACRO_SEMANTIC_DECLARATION/1', code: 'cpiYoY', macroMemberClass: 'DERIVED_FEATURE', semanticQuantity: 'year-over-year percentage change in US CPI-U all-items', representation: 'PERCENT', storageScale: 4, g24FacingValue: 'plain finite JavaScript number', g24FacingValueUnit: 'PERCENTAGE_POINTS' }),
  Object.freeze({ schemaVersion: 'WHEEL_JARVISE_G24_MACRO_SEMANTIC_DECLARATION/1', code: 'US.TREAS.DGS10', macroMemberClass: 'BASE_SERIES', semanticQuantity: '10-year US Treasury constant-maturity nominal yield', representation: 'PERCENT', storageScale: 2, g24FacingValue: 'plain finite JavaScript number', g24FacingValueUnit: 'PERCENTAGE_POINTS', deltaOperation: 'current.value - prior.value', deltaUnit: 'PERCENTAGE_POINTS' }),
]);
