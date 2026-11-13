/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PuppeteerRunnerOwningBrowserExtension } from './PuppeteerRunnerExtension.js';
import { RunnerExtension } from './RunnerExtension.js';
import type { UserFlow, Step } from './Schema.js';
import { bindParameters } from './Parameters.js';
import type { ParameterValues } from './Parameters.js';

async function _runStepWithHooks(
  extension: RunnerExtension,
  step: Step,
  flow?: UserFlow
) {
  await extension.beforeEachStep?.(step, flow);
  await extension.runStep(step, flow);
  await extension.afterEachStep?.(step, flow);
}

export class Runner {
  #flow?: UserFlow;
  #extension: RunnerExtension;
  #aborted: boolean = false;

  /**
   * @internal
   */
  constructor(extension: RunnerExtension) {
    this.#extension = extension;
  }

  abort(): void {
    this.#aborted = true;
  }

  set flow(flow: UserFlow) {
    this.#flow = flow;
  }

  /**
   * Validates the flow's parameter bindings against `parameters`, binds the
   * supplied values (or the declared defaults) and stores a deeply cloned
   * flow. The original flow is never mutated and every call produces an
   * independent flow, so repeated and parallel runs cannot leak values into
   * each other. Throws before any hook runs when a binding or value is
   * invalid.
   */
  setFlow(flow: UserFlow, parameters: ParameterValues = {}): void {
    this.#flow = bindParameters(flow, flow.parameters, parameters);
  }

  async runBeforeAllSteps(flow?: UserFlow): Promise<void> {
    await this.#extension.beforeAllSteps?.(flow);
  }

  async runAfterAllSteps(flow?: UserFlow): Promise<void> {
    await this.#extension.afterAllSteps?.(flow);
  }

  /**
   * Runs the provided `step` with `beforeEachStep` and `afterEachStep` hooks.
   * Parameters from the `flow` apply if the `flow` is set.
   */
  async runStep(step: Step): Promise<void> {
    await _runStepWithHooks(this.#extension, step);
  }

  /**
   * Run all the steps in the flow
   * @returns whether all the steps are run or the execution is aborted
   */
  async run(): Promise<boolean> {
    if (!this.#flow) {
      throw new Error(
        'Set the flow on the runner instance before calling `run`.'
      );
    }

    const flow = this.#flow;

    this.#aborted = false;

    await this.#extension.beforeAllSteps?.(flow);

    if (this.#aborted) {
      return false;
    }

    for (const step of flow.steps) {
      if (this.#aborted) {
        await this.#extension.afterAllSteps?.(flow);
        return false;
      }
      await _runStepWithHooks(this.#extension, step, flow);
    }

    await this.#extension.afterAllSteps?.(flow);

    return true;
  }
}

export async function createRunner(): Promise<Runner>;
export async function createRunner(flow: UserFlow): Promise<Runner>;
export async function createRunner(extension: RunnerExtension): Promise<Runner>;
export async function createRunner(
  flow: UserFlow,
  extension: RunnerExtension
): Promise<Runner>;
export async function createRunner(
  flow: UserFlow,
  parameters: ParameterValues
): Promise<Runner>;
export async function createRunner(
  flow: UserFlow,
  extension: RunnerExtension,
  parameters: ParameterValues
): Promise<Runner>;
export async function createRunner(
  flowOrExtension?: UserFlow | RunnerExtension,
  maybeExtensionOrParameters?: RunnerExtension | ParameterValues,
  maybeParameters?: ParameterValues
) {
  const isExtension = (
    value: RunnerExtension | ParameterValues | UserFlow | undefined
  ): value is RunnerExtension => value instanceof RunnerExtension;

  const extension =
    (isExtension(flowOrExtension) ? flowOrExtension : undefined) ??
    (isExtension(maybeExtensionOrParameters)
      ? maybeExtensionOrParameters
      : undefined);
  const flow: UserFlow | undefined = !isExtension(flowOrExtension)
    ? flowOrExtension
    : undefined;
  const parameters = isExtension(maybeExtensionOrParameters)
    ? maybeParameters
    : maybeExtensionOrParameters;

  // Parameters are bound and fully validated before the extension (and thus
  // any browser owned by it) is created or any hook can run. A flow that
  // declares parameters is always bound so its defaults apply.
  const hasDeclarations =
    flow !== undefined &&
    flow.parameters !== undefined &&
    Object.keys(flow.parameters).length > 0;
  const boundFlow =
    flow && hasDeclarations
      ? bindParameters(flow, flow.parameters, parameters ?? {})
      : flow;

  const runner = new Runner(
    extension ?? (await createPuppeteerRunnerOwningBrowserExtension())
  );
  if (boundFlow) {
    runner.flow = boundFlow;
  }
  return runner;
}

async function createPuppeteerRunnerOwningBrowserExtension() {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  return new PuppeteerRunnerOwningBrowserExtension(browser, page);
}
