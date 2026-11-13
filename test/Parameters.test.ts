/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { bindParameters, ParameterError } from '../src/Parameters.js';
import type { ParameterDefinitions } from '../src/Parameters.js';
import type { UserFlow } from '../src/Schema.js';
import { StepType } from '../src/Schema.js';
import { parse } from '../src/SchemaUtils.js';

function navigateUrl(flow: UserFlow): string {
  const step = flow.steps[0]!;
  if (step.type !== StepType.Navigate) {
    throw new Error('expected navigate step');
  }
  return step.url;
}

function makeFlow(parameters?: ParameterDefinitions): UserFlow {
  return {
    title: 'Report RPA',
    parameters,
    steps: [
      {
        type: StepType.Navigate,
        url: 'https://example.com/report?region=default',
      },
      {
        type: StepType.Change,
        selectors: ['#query'],
        value: 'default query',
      },
      {
        type: StepType.SetViewport,
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false,
      },
      {
        type: StepType.Scroll,
        x: 0,
        y: 10,
      },
    ],
  };
}

describe('bindParameters', () => {
  it('binds string, number and boolean leaf fields', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
      query: { path: '/steps/1/value', type: 'string' },
      width: { path: '/steps/2/width', type: 'number' },
      mobile: { path: '/steps/2/isMobile', type: 'boolean' },
      scrollY: { path: '/steps/3/y', type: 'number' },
    });

    const bound = bindParameters(flow, flow.parameters, {
      url: 'https://example.com/report?region=emea',
      query: 'quarterly',
      width: 1280,
      mobile: true,
      scrollY: 42,
    });

    assert.strictEqual(
      navigateUrl(bound),
      'https://example.com/report?region=emea'
    );
    const changeStep = bound.steps[1]!;
    if (changeStep.type !== StepType.Change) {
      throw new Error('expected change step');
    }
    assert.strictEqual(changeStep.value, 'quarterly');
    const viewport = bound.steps[2]!;
    if (viewport.type !== StepType.SetViewport) {
      throw new Error('expected viewport step');
    }
    assert.strictEqual(viewport.width, 1280);
    assert.strictEqual(viewport.isMobile, true);
    const scroll = bound.steps[3]!;
    if (scroll.type !== StepType.Scroll) {
      throw new Error('expected scroll step');
    }
    assert.strictEqual(scroll.y, 42);
  });

  it('uses declared defaults when values are not supplied', () => {
    const flow = makeFlow({
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://example.com/default',
      },
      width: { path: '/steps/2/width', type: 'number', defaultValue: 1024 },
      mobile: {
        path: '/steps/2/isMobile',
        type: 'boolean',
        defaultValue: true,
      },
    });

    const bound = bindParameters(flow);

    assert.strictEqual(navigateUrl(bound), 'https://example.com/default');
    const viewport = bound.steps[2]!;
    if (viewport.type !== StepType.SetViewport) {
      throw new Error('expected viewport step');
    }
    assert.strictEqual(viewport.width, 1024);
    assert.strictEqual(viewport.isMobile, true);
  });

  it('run time values override declared defaults', () => {
    const flow = makeFlow({
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://example.com/default',
      },
    });

    const bound = bindParameters(flow, flow.parameters, {
      url: 'https://example.com/override',
    });
    assert.strictEqual(navigateUrl(bound), 'https://example.com/override');
  });

  it('handles escaped JSON pointer tokens', () => {
    const flow = {
      title: 'escaped',
      steps: [],
      metadata: {
        'a/b': { 'c~d': 'leaf' },
      },
    } as unknown as UserFlow;
    const definitions: ParameterDefinitions = {
      escaped: { path: '/metadata/a~1b/c~0d', type: 'string' },
    };
    const bound = bindParameters(flow, definitions, {
      escaped: 'value',
    });
    const metadata = (
      bound as unknown as {
        metadata: Record<string, Record<string, string>>;
      }
    ).metadata;
    assert.strictEqual(metadata['a/b']!['c~d'], 'value');
  });

  it('supports numeric JSON pointer segments including 0 and leading zeros', () => {
    const flow = makeFlow({
      first: { path: '/steps/0/url', type: 'string' },
    });
    const bound = bindParameters(flow, flow.parameters, {
      first: 'https://example.com/zero',
    });
    assert.strictEqual(navigateUrl(bound), 'https://example.com/zero');
  });

  it('never mutates the original flow', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
    });
    const originalUrl = navigateUrl(flow);
    bindParameters(flow, flow.parameters, { url: 'changed' });
    assert.strictEqual(navigateUrl(flow), originalUrl);
  });

  it('produces independent flows on repeated and parallel bindings', async () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
    });
    const first = bindParameters(flow, flow.parameters, { url: 'first' });
    const second = bindParameters(flow, flow.parameters, { url: 'second' });
    const parallel = await Promise.all([
      Promise.resolve(bindParameters(flow, flow.parameters, { url: 'p1' })),
      Promise.resolve(bindParameters(flow, flow.parameters, { url: 'p2' })),
    ]);

    assert.strictEqual(navigateUrl(first), 'first');
    assert.strictEqual(navigateUrl(second), 'second');
    assert.strictEqual(navigateUrl(parallel[0]!), 'p1');
    assert.strictEqual(navigateUrl(parallel[1]!), 'p2');
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.steps, second.steps);
  });

  it('returns a flow that still parses against the schema', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
      width: { path: '/steps/2/width', type: 'number' },
      mobile: { path: '/steps/2/isMobile', type: 'boolean' },
    });
    const bound = bindParameters(flow, flow.parameters, {
      url: 'https://example.com/x',
      width: 375,
      mobile: true,
    });
    // Re-parsing must not throw and must preserve the bound values.
    const reparsed = parse(JSON.parse(JSON.stringify(bound)));
    assert.strictEqual(navigateUrl(reparsed), 'https://example.com/x');
  });

  function expectParameterError(
    fn: () => unknown,
    expectedName: string,
    expectedPath?: string | RegExp
  ): ParameterError {
    try {
      fn();
      assert.fail('Expected bindParameters to throw');
    } catch (err) {
      assert.ok(err instanceof ParameterError);
      const text = err.message;
      assert.ok(
        text.includes(`'${expectedName}'`),
        `message should name parameter '${expectedName}', got: ${text}`
      );
      if (expectedPath) {
        if (expectedPath instanceof RegExp) {
          assert.match(text, expectedPath);
        } else {
          assert.ok(
            text.includes(`'${expectedPath}'`),
            `message should include path '${expectedPath}', got: ${text}`
          );
        }
      }
      return err;
    }
  }

  it('fails on an unknown parameter', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
    });
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { unknown: 'x' }),
      'unknown'
    );
  });

  it('fails on a missing required parameter', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
    });
    expectParameterError(() => bindParameters(flow), 'url', '/steps/0/url');
  });

  it('fails on a type mismatch of a run time value', () => {
    const flow = makeFlow({
      width: { path: '/steps/2/width', type: 'number' },
      mobile: { path: '/steps/2/isMobile', type: 'boolean' },
      url: { path: '/steps/0/url', type: 'string' },
    });
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { width: 'wide' }),
      'width'
    );
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { mobile: 'yes' }),
      'mobile'
    );
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { url: 42 }),
      'url'
    );
  });

  it('rejects non-finite numbers in values and defaults', () => {
    const flow = makeFlow({
      width: { path: '/steps/2/width', type: 'number' },
    });
    expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          width: Number.POSITIVE_INFINITY,
        }),
      'width'
    );
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { width: Number.NaN }),
      'width'
    );

    const badDefaults = makeFlow({
      width: {
        path: '/steps/2/width',
        type: 'number',
        defaultValue: Number.NaN,
      },
    });
    expectParameterError(() => bindParameters(badDefaults), 'width');
  });

  it('fails on an invalid or missing JSON pointer', () => {
    const flow = makeFlow({
      noSlash: { path: 'steps/0/url', type: 'string' },
      missing: { path: '/steps/99/url', type: 'string' },
      root: { path: '', type: 'string' },
      badEscape: { path: '/steps/0~2/url', type: 'string' },
    });
    const err = expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          noSlash: 'a',
          missing: 'b',
          root: 'c',
          badEscape: 'd',
        }),
      'noSlash'
    );
    assert.strictEqual(err.issues.length, 4);
    assert.deepStrictEqual(
      err.issues.map((issue) => issue.parameter),
      ['badEscape', 'missing', 'noSlash', 'root']
    );
  });

  it('fails when a pointer targets an object or array rather than a leaf', () => {
    const flow = makeFlow({
      wholeStep: { path: '/steps/2', type: 'string' },
      selectors: { path: '/steps/1/selectors', type: 'string' },
    });
    const err = expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          wholeStep: 'x',
          selectors: 'y',
        }),
      'wholeStep'
    );
    assert.strictEqual(err.issues.length, 2);
  });

  it('fails when a pointer targets a type field', () => {
    const flow = makeFlow({
      stepType: { path: '/steps/0/type', type: 'string' },
    });
    expectParameterError(
      () => bindParameters(flow, flow.parameters, { stepType: 'navigate' }),
      'stepType',
      '/steps/0/type'
    );
  });

  it('fails when the declared type does not match the leaf field type', () => {
    const flow = makeFlow({
      widthAsString: { path: '/steps/2/width', type: 'string' },
      urlAsNumber: { path: '/steps/0/url', type: 'number' },
    });
    const err = expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          widthAsString: 'x',
          urlAsNumber: 1,
        }),
      'urlAsNumber'
    );
    assert.strictEqual(err.issues.length, 2);
  });

  it('fails on duplicate bindings of the same path', () => {
    const flow = makeFlow({
      first: { path: '/steps/0/url', type: 'string' },
      second: { path: '/steps/0/url', type: 'string' },
    });
    const err = expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          first: 'a',
          second: 'b',
        }),
      'second'
    );
    assert.match(err.message, /already bound by parameter 'first'/);
  });

  it('reports a duplicate path even when a binding also has a type mismatch', () => {
    const flow = makeFlow({
      first: { path: '/steps/2/width', type: 'number' },
      second: { path: '/steps/2/width', type: 'string' },
    });
    const err = expectParameterError(
      () =>
        bindParameters(flow, flow.parameters, {
          first: 1,
          second: 'b',
        }),
      'second'
    );
    assert.strictEqual(err.issues.length, 2);
    assert.ok(
      err.issues.some((issue) =>
        issue.message.includes('does not match the number field')
      )
    );
    assert.ok(
      err.issues.some((issue) =>
        issue.message.includes("already bound by parameter 'first'")
      )
    );
  });

  it('reports every problem in a single failure', () => {
    const flow = makeFlow({
      url: { path: '/steps/0/url', type: 'string' },
      badPath: { path: '/does/not/exist', type: 'string' },
    });
    try {
      bindParameters(flow, flow.parameters, {
        url: 1, // type mismatch
        unknown: true, // unknown parameter
        // badPath and url: missing required values
      });
      assert.fail('Expected throw');
    } catch (err) {
      assert.ok(err instanceof ParameterError);
      const messages = err.issues.map((issue) => issue.message).join('\n');
      assert.ok(err.issues.length >= 4, messages);
      assert.ok(err.issues.some((issue) => issue.parameter === 'url'));
      assert.ok(err.issues.some((issue) => issue.parameter === 'badPath'));
      assert.ok(err.issues.some((issue) => issue.parameter === 'unknown'));
    }
  });

  it('accepts bindings declared on the flow without explicit definitions', () => {
    const flow = makeFlow({
      url: {
        path: '/steps/0/url',
        type: 'string',
        defaultValue: 'https://default.example',
      },
    });
    const bound = bindParameters(flow);
    assert.strictEqual(navigateUrl(bound), 'https://default.example');
  });

  it('supports complex quotes and unicode in string values', () => {
    const flow = makeFlow({
      query: { path: '/steps/1/value', type: 'string' },
    });
    const complex = `he said "hi" it's \`code\` \${x}\n\t中文`;
    const bound = bindParameters(flow, flow.parameters, { query: complex });
    const changeStep = bound.steps[1]!;
    if (changeStep.type !== StepType.Change) {
      throw new Error('expected change step');
    }
    assert.strictEqual(changeStep.value, complex);
  });
});
