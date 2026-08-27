import { Router } from 'express';
import { getJarviseCaptureContextR1 } from './jarviseCaptureContextR1.mjs';
import { runJarvisePipelineR1 } from './jarvisePipelineR1.mjs';

export default function createJarviseRoutesR1({ pipeline = runJarvisePipelineR1, context = getJarviseCaptureContextR1 } = {}) {
  const router = Router();
  router.get('/regime', (req, res) => {
    const outcome = pipeline({ symbol: req.query.symbol, knowledgeCutoff: req.query.knowledgeCutoff });
    const code = outcome.status === 'AVAILABLE' ? 200 : 409;
    return res.status(code).json(outcome);
  });
  router.get('/context', (req, res) => {
    const outcome = context({ symbol: req.query.symbol });
    const code = outcome.status === 'FAIL_CLOSED'
      ? (outcome.reasonCode === 'SYMBOL_INVALID' ? 400 : 409)
      : 200;
    return res.status(code).json(outcome);
  });
  return router;
}
