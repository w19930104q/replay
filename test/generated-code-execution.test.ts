/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { stringify } from '../src/stringify.js';
import { PuppeteerReplayStringifyExtension } from '../src/PuppeteerReplayStringifyExtension.js';
import { StepType } from '../src/Schema.js';
import type { UserFlow } from '../src/Schema.js';

const resourcesDir = path.join(
  process.cwd(),
  'test',
  'resources',
  'generated-code'
);
const loaderPath = path.join(resourcesDir, 'register.mjs');
const extensionPath = path.join(resourcesDir, 'recording-extension.mjs');

let workDir: string;

before(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), 'replay-gencode-'));
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function parameterizedFlow(): UserFlow {
  return {
    title: 'Report RPA generated',
    parameters: {
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://default.example/report',
      },
      query: {
        path: '/steps/1/value',
        type: 'string',
        defaultValue: 'default-query',
      },
      width: { path: '/steps/2/width', type: 'number', defaultValue: 800 },
      mobile: {
        path: '/steps/2/isMobile',
        type: 'boolean',
        defaultValue: false,
      },
    },
    steps: [
      { type: StepType.Navigate, url: 'https://recorded.example/report' },
      {
        type: StepType.Change,
        selectors: ['#query'],
        value: 'recorded-query',
      },
      {
        type: StepType.SetViewport,
        width: 400,
        height: 300,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false,
      },
    ],
  };
}

async function writeGeneratedScript(
  fileName: string,
  flow: UserFlow,
  parameters: Record<string, string | number | boolean> | undefined,
  useReplayExtension: boolean
): Promise<string> {
  const script = await stringify(flow, {
    extension: useReplayExtension
      ? new PuppeteerReplayStringifyExtension()
      : undefined,
    parameters,
  });
  const filePath = path.join(workDir, fileName);
  await fs.writeFile(filePath, script);
  return filePath;
}

function runGeneratedScript(scriptPath: string, logFile: string): void {
  execFileSync(
    process.execPath,
    ['--import', pathToFileURL(loaderPath).href, scriptPath],
    {
      stdio: 'pipe',
      env: { ...process.env, PUPPETEER_STUB_LOG: logFile },
    }
  );
}

describe('generated code execution', () => {
  it('executes a generated puppeteer script with bound parameters', async () => {
    const filePath = await writeGeneratedScript(
      'puppeteer-script.mjs',
      parameterizedFlow(),
      {
        url: 'https://run.example/emea',
        query: `it's a "complex" \`query\` ${'${x}'}`,
        width: 1280,
        mobile: true,
      },
      false
    );
    const logFile = path.join(workDir, 'puppeteer-calls.json');
    runGeneratedScript(filePath, logFile);

    const calls = JSON.parse(await fs.readFile(logFile, 'utf8')) as Array<{
      method: string;
      args: unknown[];
    }>;
    const gotoCall = calls.find((call) => call.method === 'page.goto')!;
    assert.strictEqual(gotoCall.args[0], 'https://run.example/emea');
    const fillCall = calls.find((call) => call.method === 'fill')!;
    assert.strictEqual(
      fillCall.args[0],
      `it's a "complex" \`query\` ${'${x}'}`
    );
    const viewportCall = calls.find(
      (call) => call.method === 'page.setViewport'
    )!;
    assert.strictEqual((viewportCall.args[0] as { width: number }).width, 1280);
  });

  it('embeds declared defaults when no parameters are supplied', async () => {
    const filePath = await writeGeneratedScript(
      'puppeteer-defaults.mjs',
      parameterizedFlow(),
      undefined,
      false
    );
    const logFile = path.join(workDir, 'puppeteer-default-calls.json');
    runGeneratedScript(filePath, logFile);

    const scriptText = await fs.readFile(filePath, 'utf8');
    assert.ok(scriptText.includes('https://default.example/report'));
    assert.ok(!scriptText.includes('https://recorded.example/report'));

    const calls = JSON.parse(await fs.readFile(logFile, 'utf8')) as Array<{
      method: string;
      args: unknown[];
    }>;
    const gotoCall = calls.find((call) => call.method === 'page.goto')!;
    assert.strictEqual(gotoCall.args[0], 'https://default.example/report');
  });

  it('executes a generated replay-extension script with bound parameters', async () => {
    const filePath = await writeGeneratedScript(
      'replay-script.mjs',
      parameterizedFlow(),
      {
        url: 'https://run.example/apac',
        query: 'apac-query',
        width: 1024,
        mobile: true,
      },
      true
    );
    const stepsLog = path.join(workDir, 'replay-steps.json');
    const wrapperPath = path.join(workDir, 'replay-wrapper.mjs');
    await fs.writeFile(
      wrapperPath,
      `import { run } from ${JSON.stringify(pathToFileURL(filePath).href)};
import RecordingExtension from ${JSON.stringify(
        pathToFileURL(extensionPath).href
      )};
const extension = new RecordingExtension();
await run(extension);
const fs = await import('node:fs');
fs.writeFileSync(${JSON.stringify(stepsLog)}, JSON.stringify(extension.steps));
`
    );

    execFileSync(
      process.execPath,
      ['--import', pathToFileURL(loaderPath).href, wrapperPath],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          PUPPETEER_STUB_LOG: path.join(workDir, 'unused.json'),
        },
      }
    );

    const steps = JSON.parse(await fs.readFile(stepsLog, 'utf8')) as Array<
      Record<string, unknown>
    >;
    assert.strictEqual(steps[0]!['url'], 'https://run.example/apac');
    assert.strictEqual(steps[1]!['value'], 'apac-query');
    assert.strictEqual(steps[2]!['width'], 1024);
    assert.strictEqual(steps[2]!['isMobile'], true);
  });

  it('fails before launching when a required parameter is missing', async () => {
    const flow: UserFlow = {
      title: 'invalid',
      parameters: {
        url: { path: '/steps/0/url', type: 'string' },
      },
      steps: [
        { type: StepType.Navigate, url: 'https://recorded.example/report' },
      ],
    };
    await assert.rejects(stringify(flow), /missing required parameter/);
  });
});
