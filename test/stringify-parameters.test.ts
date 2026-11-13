/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { stringify, parseSourceMap, stripSourceMap } from '../src/stringify.js';
import { PuppeteerStringifyExtension } from '../src/PuppeteerStringifyExtension.js';
import { PuppeteerReplayStringifyExtension } from '../src/PuppeteerReplayStringifyExtension.js';
import { ParameterError } from '../src/Parameters.js';
import { StepType } from '../src/Schema.js';
import type { UserFlow } from '../src/Schema.js';
import type { LineWriter } from '../src/LineWriter.js';

function parameterizedFlow(): UserFlow {
  return {
    title: 'Report RPA',
    parameters: {
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://example.com/default',
      },
      value: {
        path: '/steps/1/value',
        type: 'string',
        defaultValue: 'recorded',
      },
      width: { path: '/steps/2/width', type: 'number', defaultValue: 800 },
      mobile: {
        path: '/steps/2/isMobile',
        type: 'boolean',
        defaultValue: false,
      },
    },
    steps: [
      { type: StepType.Navigate, url: 'https://example.com/recorded' },
      {
        type: StepType.Change,
        selectors: ['#query'],
        value: 'recorded',
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

describe('stringify parameter binding', () => {
  it('binds string, number and boolean literals in the puppeteer script', async () => {
    const script = await stringify(parameterizedFlow(), {
      parameters: {
        url: 'https://example.com/run',
        value: 'quarterly',
        width: 1280,
        mobile: true,
      },
    });

    assert.ok(script.includes("goto('https://example.com/run')"));
    assert.ok(script.includes(".fill('quarterly')"));
    assert.ok(script.includes('width: 1280'));
    // Recorded defaults must not leak into the generated script.
    assert.ok(!script.includes('https://example.com/recorded'));
  });

  it('uses declared defaults when no parameters are passed', async () => {
    const script = await stringify(parameterizedFlow());
    assert.ok(script.includes("goto('https://example.com/default')"));
    assert.ok(script.includes(".fill('recorded')"));
    assert.ok(script.includes('width: 800'));
  });

  it('escapes complex quotes and control characters in string literals', async () => {
    const tricky = `a"b'c\`d \${e} f\\g \n h`;
    const script = await stringify(parameterizedFlow(), {
      parameters: {
        url: 'https://example.com/run',
        value: tricky,
        width: 1280,
        mobile: true,
      },
    });
    // The generated script (minus its source map comment) must be syntactically
    // valid JavaScript. Top-level await and import statements are allowed by
    // the module parser.
    const stripped = stripSourceMap(script);
    const { promises: fs } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempFile = join(tmpdir(), `replay-generated-${Date.now()}.mjs`);
    await fs.writeFile(tempFile, stripped);
    const { execFileSync } = await import('node:child_process');
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ['--check', tempFile])
    );
    await fs.rm(tempFile, { force: true });
    // Every flavor of quote appears escaped inside the single fill() literal.
    const fillLine = script.split('\n').find((line) => line.includes('.fill('));
    assert.ok(fillLine, 'expected a fill() line');
    assert.ok(fillLine!.includes('a"b'));
    // The single quote is escaped because the literal is single-quoted.
    assert.ok(fillLine!.includes("b\\'c"));
    assert.ok(fillLine!.includes('\\\\g'));
    assert.ok(fillLine!.includes('\\n'));
  });

  it('keeps the source map aligned with the original steps', async () => {
    const flow = parameterizedFlow();
    const withoutParams = await stringify(flow);
    const withParams = await stringify(flow, {
      parameters: {
        url: 'https://example.com/run',
        value: 'x',
        width: 1,
        mobile: true,
      },
    });

    const baseline = parseSourceMap(withoutParams)!;
    const bound = parseSourceMap(withParams)!;
    assert.deepStrictEqual(bound, baseline);
    assert.strictEqual(bound[0], 1);
    // One entry per step plus the version int.
    assert.strictEqual(bound.length, 1 + flow.steps.length * 2);
  });

  it('applies the same binding semantics to the replay extension', async () => {
    const script = await stringify(parameterizedFlow(), {
      extension: new PuppeteerReplayStringifyExtension(),
      parameters: {
        url: 'https://example.com/run',
        value: 'quarterly',
        width: 1280,
        mobile: true,
      },
    });
    assert.ok(script.includes("url: 'https://example.com/run'"));
    assert.ok(script.includes("value: 'quarterly'"));
    assert.ok(script.includes('width: 1280'));
    assert.ok(script.includes('isMobile: true'));
    assert.deepStrictEqual(
      parseSourceMap(script),
      parseSourceMap(
        await stringify(parameterizedFlow(), {
          extension: new PuppeteerReplayStringifyExtension(),
        })
      )
    );
  });

  it('fails validation before generating any output hook', async () => {
    const flow = parameterizedFlow();
    let hookRan = false;
    class ProbeExtension extends PuppeteerStringifyExtension {
      override async beforeAllSteps(
        out: LineWriter,
        probeFlow: UserFlow
      ): Promise<void> {
        hookRan = true;
        await super.beforeAllSteps(out, probeFlow);
      }
    }
    await assert.rejects(
      stringify(flow, {
        extension: new ProbeExtension(),
        parameters: {
          url: 42, // type mismatch
          value: 'x',
          width: 1,
          mobile: true,
          unknown: true,
        },
      }),
      (err) => err instanceof ParameterError
    );
    assert.strictEqual(hookRan, false);
  });

  it('does not mutate the flow when stringifying with parameters', async () => {
    const flow = parameterizedFlow();
    const snapshot = JSON.parse(JSON.stringify(flow));
    await stringify(flow, {
      parameters: {
        url: 'https://example.com/run',
        value: 'x',
        width: 1,
        mobile: true,
      },
    });
    assert.deepStrictEqual(flow, snapshot);
  });
});
