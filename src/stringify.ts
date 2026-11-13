/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { InMemoryLineWriter } from './InMemoryLineWriter.js';
import { LineWriter } from './LineWriter.js';
import { PuppeteerStringifyExtension } from './PuppeteerStringifyExtension.js';
import type { Step, UserFlow } from './Schema.js';
import { StringifyExtension } from './StringifyExtension.js';
import { decode, encode } from './vlq.js';
import type { ParameterValues } from './Parameters.js';
import { bindParameters } from './Parameters.js';

export interface StringifyOptions {
  extension?: StringifyExtension;
  writer?: LineWriter;
  indentation?: string;
  /**
   * Run time values for the typed parameters declared on the flow. They are
   * validated and bound before any stringify hook runs. When omitted, the
   * declared default values are used.
   */
  parameters?: ParameterValues;
}

const SOURCE_MAP_PREFIX = '//# recorderSourceMap=';

/**
 * The format is [version, [lineNo, length], [lineNo, length] ... [lineNo, length]].
 */
export type SourceMap = Array<number>;

/**
 * Stringifes an entire recording. The following hooks are invoked with the `flow` parameter containing the entire flow:
 * - `beforeAllSteps` (once)
 * - `beforeEachStep` (per step)
 * - `stringifyStep` (per step)
 * - `afterEachStep` (per step)
 * - `afterAllSteps` (once)
 */
export async function stringify(
  flow: UserFlow,
  opts?: StringifyOptions
): Promise<string> {
  if (!opts) {
    opts = {};
  }
  const ext = opts.extension ?? new PuppeteerStringifyExtension();
  const out = opts.writer ?? new InMemoryLineWriter(opts.indentation ?? '  ');

  // Bind and validate parameters before invoking any extension hook. A flow
  // that declares parameters is always bound so that declared defaults are
  // applied; the binding only replaces scalar leaf values, so the generated
  // source map still maps to the original steps.
  const boundFlow =
    flow.parameters && Object.keys(flow.parameters).length > 0
      ? bindParameters(flow, flow.parameters, opts.parameters ?? {})
      : flow;

  await ext.beforeAllSteps?.(out, boundFlow);

  const sourceMap: Array<number> = [1]; // The first int indicates the version.
  for (const step of boundFlow.steps) {
    const firstLine = out.getSize();
    await ext.beforeEachStep?.(out, step, boundFlow);
    await ext.stringifyStep(out, step, boundFlow);
    await ext.afterEachStep?.(out, step, boundFlow);
    const lastLine = out.getSize();
    sourceMap.push(...[firstLine, lastLine - firstLine]);
  }
  await ext.afterAllSteps?.(out, boundFlow);

  out.appendLine(SOURCE_MAP_PREFIX + encode(sourceMap));

  return out.toString();
}

/**
 * Stringifes a single step. Only the following hooks are invoked with the `flow` parameter as undefined:
 * - `beforeEachStep`
 * - `stringifyStep`
 * - `afterEachStep`
 */
export async function stringifyStep(
  step: Step,
  opts?: StringifyOptions
): Promise<string> {
  if (!opts) {
    opts = {};
  }
  let ext = opts.extension;
  if (!ext) {
    ext = new PuppeteerStringifyExtension();
  }
  if (!opts.indentation) {
    opts.indentation = '  ';
  }
  const out = opts.writer ?? new InMemoryLineWriter(opts.indentation ?? '  ');

  await ext.beforeEachStep?.(out, step);
  await ext.stringifyStep(out, step);
  await ext.afterEachStep?.(out, step);

  return out.toString();
}

function isSourceMapLine(line: string): boolean {
  return line.trim().startsWith(SOURCE_MAP_PREFIX);
}

/**
 * Extracts a source map from a text.
 */
export function parseSourceMap(text: string): SourceMap | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (isSourceMapLine(line)) {
      return decode(line.trim().substring(SOURCE_MAP_PREFIX.length));
    }
  }
  return;
}

export function stripSourceMap(text: string): string {
  const lines = text.split('\n');
  return lines.filter((line) => !isSourceMapLine(line)).join('\n');
}
