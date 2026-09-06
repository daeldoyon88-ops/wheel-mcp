import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildJarviseHistoricalCalendarBindingDocumentR1 } from '../app/jarvise/jarviseHistoricalCalendarBindingR1.mjs';

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const document = buildJarviseHistoricalCalendarBindingDocumentR1();
const bytes = `${JSON.stringify(document, null, 2)}\n`;
const output = option('--output');
if (output) writeFileSync(resolve(output), bytes, { flag: 'wx' });
else process.stdout.write(bytes);
