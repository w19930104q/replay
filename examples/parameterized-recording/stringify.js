// Exports a standalone Puppeteer script with parameter values embedded as
// escaped literals. The source map still points at the original steps.
import { stringify, parse } from '../../lib/main.js';
import fs from 'fs';

const recordingText = fs.readFileSync(
  new URL('./recording.json', import.meta.url),
  'utf8'
);
const recording = parse(JSON.parse(recordingText));

const script = await stringify(recording, {
  parameters: {
    reportUrl: 'https://example.com/report?region=apac',
    query: `it's a "complex" query`,
    viewportWidth: 1024,
    mobile: false,
  },
});

console.log(script);
