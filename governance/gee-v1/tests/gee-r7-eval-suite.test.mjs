import test from 'node:test';
import { runEvalSuite } from '../evals/gee-r7-runner.mjs';

test('R7 E01-E10 deterministic eval suite passes', () => {
  const result = runEvalSuite();
  if (result.total !== 10 || result.pass !== 10 || result.fail !== 0) throw new Error(`R7_EVAL_FAILURE:${JSON.stringify(result)}`);
});
