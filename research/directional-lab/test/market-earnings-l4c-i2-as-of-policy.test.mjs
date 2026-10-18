/** L4C-I2 EarningsAsOfResolutionPolicy/1 closed singleton. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEarningsAsOfResolutionPolicy,
  officialEarningsAsOfResolutionPolicyV1,
  verifyEarningsAsOfResolutionPolicy,
} from '../src/earnings/earningsAsOfResolutionPolicyL4CIIV1.mjs';
import { EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION } from '../src/contracts/earningsContractsL4CIIV1.mjs';
import {
  code,
  overlayL4CI2Store,
  withEarningsStore,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/** Store the closed singleton, then serve a field-mutated copy to the verifier. */
function withMutatedPolicy(store, patch, callback) {
  const built = buildEarningsAsOfResolutionPolicy({ store });
  const mutated = { ...structuredClone(built.earningsAsOfResolutionPolicy), ...patch };
  return callback(
    overlayL4CI2Store(store, new Map([[built.earningsAsOfResolutionPolicyId, mutated]])),
    built.earningsAsOfResolutionPolicyId);
}

test('I2-P001 builds the closed singleton and stores it under snapshots', () => {
  withEarningsStore((store) => {
    const built = buildEarningsAsOfResolutionPolicy({ store });
    assert.match(built.earningsAsOfResolutionPolicyId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(built.earningsAsOfResolutionPolicy.schemaVersion,
      EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION);
    const reread = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'snapshots', objectId: built.earningsAsOfResolutionPolicyId,
      }),
      expectedObjectId: built.earningsAsOfResolutionPolicyId,
      schemaVersion: EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    });
    assert.deepEqual(reread.value, built.earningsAsOfResolutionPolicy);
  });
});

test('I2-P002 rebuilding yields a byte-identical object and the same id', () => {
  withEarningsStore((store) => {
    const first = buildEarningsAsOfResolutionPolicy({ store });
    const second = buildEarningsAsOfResolutionPolicy({ store });
    assert.equal(second.earningsAsOfResolutionPolicyId, first.earningsAsOfResolutionPolicyId);
    assert.deepEqual(second.earningsAsOfResolutionPolicy, first.earningsAsOfResolutionPolicy);
  });
});

test('I2-P003 verifies a correctly stored policy', () => {
  withEarningsStore((store) => {
    const built = buildEarningsAsOfResolutionPolicy({ store });
    const verified = verifyEarningsAsOfResolutionPolicy({
      store, earningsAsOfResolutionPolicyId: built.earningsAsOfResolutionPolicyId,
    });
    assert.deepEqual(verified.earningsAsOfResolutionPolicy,
      officialEarningsAsOfResolutionPolicyV1());
  });
});

test('I2-P004 rejects a policy whose cutoffBoundaryRule was altered', () => {
  withEarningsStore((store) => {
    withMutatedPolicy(store, { cutoffBoundaryRule: 'PUBLIC_AVAILABLE_AT_LESS_THAN' },
      (overlay, id) => {
        assert.throws(() => verifyEarningsAsOfResolutionPolicy({
          store: overlay, earningsAsOfResolutionPolicyId: id,
        }), code('EARNINGS_AS_OF_POLICY_INVALID'));
      });
  });
});

test('I2-P005 rejects a missing policy reference', () => {
  withEarningsStore((store) => {
    assert.throws(() => verifyEarningsAsOfResolutionPolicy({
      store, earningsAsOfResolutionPolicyId: `sha256:${'0'.repeat(64)}`,
    }), code('EARNINGS_AS_OF_POLICY_MISSING'));
  });
});

test('I2-P006 rejects latestReferencePolicy other than FORBIDDEN', () => {
  withEarningsStore((store) => {
    withMutatedPolicy(store, { latestReferencePolicy: 'ALLOWED' }, (overlay, id) => {
      assert.throws(() => verifyEarningsAsOfResolutionPolicy({
        store: overlay, earningsAsOfResolutionPolicyId: id,
      }), code('EARNINGS_AS_OF_POLICY_INVALID'));
    });
  });
});

test('I2-P007 rejects globalCasScanPolicy other than FORBIDDEN', () => {
  withEarningsStore((store) => {
    withMutatedPolicy(store, { globalCasScanPolicy: 'ALLOWED' }, (overlay, id) => {
      assert.throws(() => verifyEarningsAsOfResolutionPolicy({
        store: overlay, earningsAsOfResolutionPolicyId: id,
      }), code('EARNINGS_AS_OF_POLICY_INVALID'));
    });
  });
});

test('I2-P008 rejects wallClockPolicy other than FORBIDDEN', () => {
  withEarningsStore((store) => {
    withMutatedPolicy(store, { wallClockPolicy: 'ALLOWED' }, (overlay, id) => {
      assert.throws(() => verifyEarningsAsOfResolutionPolicy({
        store: overlay, earningsAsOfResolutionPolicyId: id,
      }), code('EARNINGS_AS_OF_POLICY_INVALID'));
    });
  });
});

test('I2-P009 rejects snapshotSelectionPolicy other than EXPLICIT_PIN_ONLY', () => {
  withEarningsStore((store) => {
    withMutatedPolicy(store, { snapshotSelectionPolicy: 'LATEST_WINS' }, (overlay, id) => {
      assert.throws(() => verifyEarningsAsOfResolutionPolicy({
        store: overlay, earningsAsOfResolutionPolicyId: id,
      }), code('EARNINGS_AS_OF_POLICY_INVALID'));
    });
  });
});

test('I2-P010 pins emptyVisibleSetPolicy = MATERIALIZE_EMPTY', () => {
  const policy = officialEarningsAsOfResolutionPolicyV1();
  assert.equal(policy.emptyVisibleSetPolicy, 'MATERIALIZE_EMPTY');
  assert.equal(policy.futureRevisionPolicy, 'IGNORE_SILENTLY');
  assert.equal(policy.causalTimestampAuthority, 'REVISION_PUBLIC_AVAILABLE_AT');
  assert.equal(policy.cutoffBoundaryRule, 'PUBLIC_AVAILABLE_AT_LESS_THAN_OR_EQUAL');
  assert.equal(policy.cutoffTimezonePolicy, 'UTC_INSTANT_REQUIRED');
});
