/**
 * Production CLI parser coverage for P3H safe-batching.
 * Offline only. Does not invoke Yahoo, DNS, or HTTP.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTER_KEY_DELAY_MS_MAX_R1,
  parseJarviseHistoricalFetchOnceArgsR1,
} from './runJarviseHistoricalFetchOnceR1.mjs';

function assertCliFailure(argv, code) {
  assert.throws(
    () => parseJarviseHistoricalFetchOnceArgsR1(argv),
    (error) => error.code === code,
  );
}

test('P3H-SB-CLI unknown argument fails closed', () => {
  assertCliFailure(['--acquisition-root', 'C:\\outside\\acq', '--not-a-real-flag'], 'RUN_CLI_ARGUMENT_UNKNOWN');
});

test('P3H-SB-CLI --max-new-provider-keys missing value fails closed', () => {
  assertCliFailure(['--max-new-provider-keys'], 'RUN_CLI_OPTION_VALUE_MISSING');
  assertCliFailure(['--max-new-provider-keys', '--acquisition-root', 'C:\\outside\\acq'], 'RUN_CLI_OPTION_VALUE_MISSING');
});

test('P3H-SB-CLI --max-new-provider-keys 0 / negative / fractional / malformed fail closed', () => {
  assertCliFailure(['--max-new-provider-keys', '0'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', '-1'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', '1.5'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', '1e2'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', '+2'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', '02'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--max-new-provider-keys', 'abc'], 'RUN_CLI_OPTION_VALUE_INVALID');
});

test('P3H-SB-CLI duplicate conflicting --max-new-provider-keys fails closed', () => {
  assertCliFailure(
    ['--max-new-provider-keys', '1', '--max-new-provider-keys', '2'],
    'RUN_CLI_OPTION_DUPLICATE',
  );
});

test('P3H-SB-CLI invalid --inter-key-delay-ms fails closed', () => {
  assertCliFailure(['--inter-key-delay-ms'], 'RUN_CLI_OPTION_VALUE_MISSING');
  assertCliFailure(['--inter-key-delay-ms', '-1'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--inter-key-delay-ms', '1.5'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--inter-key-delay-ms', 'abc'], 'RUN_CLI_OPTION_VALUE_INVALID');
  assertCliFailure(['--inter-key-delay-ms', String(INTER_KEY_DELAY_MS_MAX_R1 + 1)], 'RUN_CLI_OPTION_VALUE_INVALID');
});

test('P3H-SB-CLI valid batch and pacing options parse', () => {
  assert.deepEqual(
    parseJarviseHistoricalFetchOnceArgsR1([
      '--acquisition-root', 'C:\\outside\\acq',
      '--max-new-provider-keys', '2',
      '--inter-key-delay-ms', '0',
    ]),
    {
      acquisitionRoot: 'C:\\outside\\acq',
      executionGrantPath: null,
      recoveryGrantPath: null,
      maxNewProviderKeys: 2,
      interKeyDelayMs: 0,
    },
  );
});
