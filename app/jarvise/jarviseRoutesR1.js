import { Router } from 'express';
import { runJarvisePipelineR1 } from './jarvisePipelineR1.mjs';

export default function createJarviseRoutesR1({ pipeline = runJarvisePipelineR1 } = {}) {
  const router = Router();
  router.get('/regime', (req, res) => {
    const outcome = pipeline({ symbol: req.query.symbol, knowledgeCutoff: req.query.knowledgeCutoff });
    const code = outcome.status === 'AVAILABLE' ? 200 : 409;
    return res.status(code).json(outcome);
  });
  return router;
}
