import test from 'node:test';
import { runHostileAudit } from '../evals/gee-r7-runner.mjs';

test('R7 H01-H18 hostile audit fails closed', () => {
  const result = runHostileAudit();
  if (result.total !== 18 || result.pass !== 18 || result.fail !== 0) throw new Error(`R7_HOSTILE_FAILURE:${JSON.stringify(result)}`);
  if (result.materialDefects.length !== 0) throw new Error('R7_MATERIAL_DEFECT');
});
