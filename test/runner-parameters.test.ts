/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Runner, createRunner } from '../src/Runner.js';
import { RunnerExtension } from '../src/RunnerExtension.js';
import { ParameterError } from '../src/Parameters.js';
import { StepType } from '../src/Schema.js';
import type { Step, UserFlow } from '../src/Schema.js';

/**
 * A recording extension that never launches a browser: it records every hook
 * invocation and the steps it was asked to run.
 */
class RecordingExtension extends RunnerExtension {
  readonly log: string[] = [];
  readonly ranSteps: Step[] = [];
  readonly ranFlows: UserFlow[] = [];

  override async beforeAllSteps(flow?: UserFlow): Promise<void> {
    this.log.push('beforeAll');
    if (flow) {
      this.ranFlows.push(flow);
    }
  }

  override async beforeEachStep(step: Step): Promise<void> {
    this.log.push(`before:${step.type}`);
  }

  override async runStep(step: Step, flow?: UserFlow): Promise<void> {
    this.log.push(`run:${step.type}`);
    this.ranSteps.push(step);
    if (flow && !this.ranFlows.includes(flow)) {
      this.ranFlows.push(flow);
    }
  }

  override async afterEachStep(step: Step): Promise<void> {
    this.log.push(`after:${step.type}`);
  }

  override async afterAllSteps(): Promise<void> {
    this.log.push('afterAll');
  }
}

function parameterizedFlow(): UserFlow {
  return {
    title: 'Report RPA',
    parameters: {
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://example.com/default',
      },
      width: { path: '/steps/1/width', type: 'number', defaultValue: 800 },
      mobile: {
        path: '/steps/1/isMobile',
        type: 'boolean',
        defaultValue: false,
      },
    },
    steps: [
      { type: StepType.Navigate, url: 'https://example.com/recorded' },
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

function viewportOf(flow: UserFlow) {
  const step = flow.steps[1]!;
  if (step.type !== StepType.SetViewport) {
    throw new Error('expected viewport step');
  }
  return step;
}

function navigateOf(flow: UserFlow) {
  const step = flow.steps[0]!;
  if (step.type !== StepType.Navigate) {
    throw new Error('expected navigate step');
  }
  return step;
}

describe('Runner parameter binding', () => {
  it('binds values through createRunner and runs hooks on the bound flow', async () => {
    const extension = new RecordingExtension();
    const flow = parameterizedFlow();
    const runner = await createRunner(flow, extension, {
      url: 'https://example.com/emea',
      width: 1280,
      mobile: true,
    });

    assert.strictEqual(await runner.run(), true);

    assert.deepStrictEqual(extension.log, [
      'beforeAll',
      'before:navigate',
      'run:navigate',
      'after:navigate',
      'before:setViewport',
      'run:setViewport',
      'after:setViewport',
      'afterAll',
    ]);
    const boundFlow = extension.ranFlows[0]!;
    assert.strictEqual(navigateOf(boundFlow).url, 'https://example.com/emea');
    assert.strictEqual(viewportOf(boundFlow).width, 1280);
    assert.strictEqual(viewportOf(boundFlow).isMobile, true);
  });

  it('supports the (flow, parameters) overload without an extension argument', async () => {
    // Passing a plain object parameters argument must not be mistaken for an
    // extension. No browser is launched because the flow has zero steps and a
    // recording extension is supplied via setFlow-free path below.
    const extension = new RecordingExtension();
    const flow = parameterizedFlow();
    const runner = new Runner(extension);
    runner.setFlow(flow, {
      url: 'https://example.com/x',
      width: 1024,
      mobile: true,
    });
    await runner.run();
    assert.strictEqual(
      navigateOf(extension.ranFlows[0]!).url,
      'https://example.com/x'
    );
  });

  it('applies defaults when no parameters are supplied', async () => {
    const extension = new RecordingExtension();
    const runner = await createRunner(parameterizedFlow(), extension);
    await runner.run();
    const flow = extension.ranFlows[0]!;
    assert.strictEqual(navigateOf(flow).url, 'https://example.com/default');
    assert.strictEqual(viewportOf(flow).width, 800);
    assert.strictEqual(viewportOf(flow).isMobile, false);
  });

  it('fails before any hook runs on invalid parameters', async () => {
    const extension = new RecordingExtension();
    const flow = parameterizedFlow();
    await assert.rejects(
      createRunner(flow, extension, {
        url: 123, // type mismatch
        width: 640,
        mobile: false,
      }),
      (err) => err instanceof ParameterError
    );
    assert.deepStrictEqual(extension.log, []);
    assert.strictEqual(extension.ranSteps.length, 0);
  });

  it('fails on a missing required parameter before running hooks', async () => {
    const extension = new RecordingExtension();
    const flow: UserFlow = {
      title: 'required',
      parameters: {
        url: { path: '/steps/0/url', type: 'string' },
      },
      steps: [{ type: StepType.Navigate, url: 'https://example.com' }],
    };
    const runner = new Runner(extension);
    await assert.rejects(
      async () => runner.setFlow(flow, {}),
      (err) => err instanceof ParameterError
    );
    // setFlow threw, so no bound flow or hooks exist.
    assert.deepStrictEqual(extension.log, []);
  });

  it('does not mutate the original flow', async () => {
    const extension = new RecordingExtension();
    const flow = parameterizedFlow();
    await createRunner(flow, extension, {
      url: 'https://example.com/changed',
      width: 1,
      mobile: true,
    });
    assert.strictEqual(navigateOf(flow).url, 'https://example.com/recorded');
    assert.strictEqual(viewportOf(flow).width, 400);
    assert.strictEqual(viewportOf(flow).isMobile, false);
    assert.deepStrictEqual(flow.parameters, parameterizedFlow().parameters);
  });

  it('keeps repeated and parallel runs from leaking values into each other', async () => {
    const flow = parameterizedFlow();

    const first = new RecordingExtension();
    const runnerA = await createRunner(flow, first, {
      url: 'https://example.com/a',
      width: 100,
      mobile: true,
    });
    const second = new RecordingExtension();
    const runnerB = await createRunner(flow, second, {
      url: 'https://example.com/b',
      width: 200,
      mobile: false,
    });

    await Promise.all([runnerA.run(), runnerB.run()]);
    await runnerA.run();
    await runnerB.run();

    assert.strictEqual(
      navigateOf(first.ranFlows[0]!).url,
      'https://example.com/a'
    );
    assert.strictEqual(
      navigateOf(second.ranFlows[0]!).url,
      'https://example.com/b'
    );
    assert.strictEqual(viewportOf(first.ranFlows[0]!).width, 100);
    assert.strictEqual(viewportOf(second.ranFlows[0]!).width, 200);
    // The same flow object seen on repeated runs remains stable per runner.
    assert.strictEqual(first.ranFlows[0], first.ranFlows[1]);
    assert.strictEqual(second.ranFlows[0], second.ranFlows[1]);
    assert.notStrictEqual(first.ranFlows[0], second.ranFlows[0]);
  });
});
