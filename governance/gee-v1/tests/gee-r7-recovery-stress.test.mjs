import test from 'node:test';
import { runRecoveryStress } from '../evals/gee-r7-runner.mjs';

test('R7 fresh-process recovery preserves completed work without zero restart', () => {
  const result = runRecoveryStress();
  if (result.restartedFromZero !== false) throw new Error(`R7_RESTART_FROM_ZERO:${JSON.stringify(result)}`);
  if (result.completedPreserved < 1 || result.tasksInvalidated < 1) throw new Error(`R7_RECOVERY_SELECTIVITY_FAILURE:${JSON.stringify(result)}`);
});
