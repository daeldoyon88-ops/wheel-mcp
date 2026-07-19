import { CorporateActionError } from '../contracts/corporateActionL2CV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from '../contracts/datasetSnapshotV1.mjs';
import { isPlainObject } from '../contracts/contractPrimitivesV1.mjs';

export function assertCorporateActionInput(input) {
  if (!isPlainObject(input)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'input must be a plain object');
}
export function assertCorporateActionStore(store, methods = ['readCanonicalObject', 'uriForObject']) {
  if (!store || typeof store !== 'object') throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'store is required');
  for (const method of methods) if (typeof store[method] !== 'function') throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `store.${method} is required`);
}
export function assertCorporateActionId(value, label) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `${label} is invalid`);
}
export function readCorporateActionObject(store, objectId, schemaVersion, label) {
  assertCorporateActionId(objectId, label);
  try {
    const uri = store.uriForObject({ namespace: 'snapshots', objectId });
    return store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion }).value;
  } catch (error) {
    if (error instanceof CorporateActionError) throw error;
    const missing = error?.code === 'CAS_OBJECT_CORRUPT' && error?.details?.fsCode === 'ENOENT';
    throw new CorporateActionError(missing ? 'CORPORATE_ACTION_REFERENCE_MISSING' : 'CORPORATE_ACTION_REFERENCE_CORRUPT',
      `${label} could not be recovered from the CAS`, { objectId, cause: error });
  }
}
export function putCorporateActionObject(store, schemaVersion, value) {
  assertCorporateActionStore(store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  const published = store.putCanonicalObject({ namespace: 'snapshots', schemaVersion, value });
  const reread = store.readCanonicalObject({ uri: published.uri, expectedObjectId: published.objectId, schemaVersion });
  return { ...published, value: reread.value };
}
