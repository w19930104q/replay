// Runs the parameterized recording with run time values that override the
// declared defaults. Invalid parameters throw a ParameterError before any
// hook runs or any browser is launched.
import { createRunner, parse } from '../../lib/main.js';
import fs from 'fs';

const recordingText = fs.readFileSync(
  new URL('./recording.json', import.meta.url),
  'utf8'
);
const recording = parse(JSON.parse(recordingText));

const runner = await createRunner(
  recording,
  // No custom extension: the runner launches its own browser. Pass an
  // extension as the second argument and the parameters object as the third.
  {
    reportUrl: 'https://example.com/report?region=emea',
    query: 'quarterly',
    viewportWidth: 1280,
    mobile: true,
  }
);

await runner.run();
