import fs from 'node:fs';
import { sha256Canonical } from './canonical-json.mjs';

const index = process.argv.indexOf('--file');
const file = index >= 0 ? process.argv[index + 1] : null;
if (!file) throw new Error('FILE_REQUIRED');
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
process.stdout.write(JSON.stringify({ file, payloadSha256: sha256Canonical(payload) }) + '\n');
