import test from 'node:test';
import { runAuthorityAndScope } from '../evals/gee-r7-runner.mjs';

test('R7 authority and write scope are canonical and fail closed', () => {
  const result = runAuthorityAndScope();
  if (Object.values(result.positive).some((value) => value !== true)) throw new Error('R7_POSITIVE_SCOPE_FAILURE');
  if (Object.values(result.negative).some((value) => value !== false)) throw new Error('R7_NEGATIVE_SCOPE_FAILURE');
  if (result.r8 !== 'UNKNOWN / UNAUTHORIZED') throw new Error('R8_AUTHORITY_LEAK');
});
