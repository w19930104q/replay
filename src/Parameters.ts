/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UserFlow } from './Schema.js';

/**
 * The scalar types supported by typed flow parameters.
 */
export type ParameterValueType = 'string' | 'number' | 'boolean';

/**
 * A concrete parameter value. Only strings, finite numbers and booleans are
 * allowed (`null`, `NaN` and `Infinity` are rejected).
 */
export type ParameterValue = string | number | boolean;

/**
 * Declares a single typed parameter of a user flow.
 *
 * The parameter is bound to an existing leaf field of the flow identified by
 * an RFC 6901 JSON Pointer. At run time the field is replaced with the
 * supplied parameter value, or with `defaultValue` when no value is supplied.
 * A binding without a `defaultValue` makes the parameter required.
 */
export interface ParameterBinding {
  /**
   * An RFC 6901 JSON Pointer to an existing leaf field of the flow, for
   * example `/steps/0/url`.
   */
  path: string;
  /**
   * The only type accepted for the default and the run time value. It must
   * match the type of the field the pointer resolves to.
   */
  type: ParameterValueType;
  /**
   * Value used when no run time value is supplied. When omitted, the
   * parameter is required.
   */
  defaultValue?: ParameterValue;
}

/**
 * The parameter declarations of a flow, keyed by parameter name.
 */
export type ParameterDefinitions = Record<string, ParameterBinding>;

/**
 * The run time parameter values, keyed by parameter name.
 */
export type ParameterValues = Record<string, ParameterValue>;

/**
 * A single parameter validation problem.
 */
export interface ParameterIssue {
  /**
   * Name of the parameter the problem relates to, when one is known.
   */
  parameter?: string;
  /**
   * JSON Pointer of the binding the problem relates to, when one is known.
   */
  path?: string;
  message: string;
}

/**
 * Thrown when one or more parameter bindings or run time values are invalid.
 * Every detected problem is reported at once, before any hook runs or any
 * browser is launched.
 */
export class ParameterError extends Error {
  readonly issues: ParameterIssue[];

  constructor(issues: ParameterIssue[]) {
    super(
      [
        'Invalid flow parameters:',
        ...issues.map((issue) => {
          const where = [
            issue.parameter ? `parameter '${issue.parameter}'` : undefined,
            issue.path ? `path '${issue.path}'` : undefined,
          ]
            .filter(Boolean)
            .join(', ');
          return `- ${where ? `[${where}] ` : ''}${issue.message}`;
        }),
      ].join('\n')
    );
    this.name = 'ParameterError';
    this.issues = issues;
  }
}

const PARAMETER_TYPES: ReadonlySet<ParameterValueType> = new Set([
  'string',
  'number',
  'boolean',
]);

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function matchesParameterType(
  value: unknown,
  type: ParameterValueType
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return isFiniteNumber(value);
  }
}

/**
 * Splits an RFC 6901 JSON Pointer into its decoded reference tokens.
 *
 * @returns the decoded reference tokens, or an error message
 */
function parsePointer(pointer: string): string[] | string {
  if (pointer === '') {
    return 'a JSON Pointer must reference a leaf field, got the root pointer';
  }
  if (!pointer.startsWith('/')) {
    return 'a JSON Pointer must start with "/"';
  }
  const tokens: string[] = [];
  for (const rawToken of pointer.substring(1).split('/')) {
    if (/~[^01]/.test(rawToken)) {
      return `invalid escape sequence in JSON Pointer token '${rawToken}'`;
    }
    // Per RFC 6901, `~1` is decoded before `~0`.
    tokens.push(rawToken.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return tokens;
}

function isArrayIndexToken(token: string): boolean {
  if (token === '-') {
    return false;
  }
  if (!/^\d+$/.test(token)) {
    return false;
  }
  return token === '0' || !token.startsWith('0');
}

interface ResolvedLeaf {
  value: unknown;
  parent: object;
  key: string;
}

/**
 * Resolves a parsed JSON Pointer against the flow and verifies that it points
 * at an existing primitive leaf field.
 */
function resolveLeaf(
  flow: UserFlow,
  pointer: string,
  tokens: string[]
): ResolvedLeaf | string {
  let current: unknown = flow;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const isLast = i === tokens.length - 1;

    if (Array.isArray(current)) {
      if (!isArrayIndexToken(token)) {
        return `array index '${token}' is not valid at '${pointer}'`;
      }
      const index = Number(token);
      if (index >= current.length) {
        return `path '${pointer}' does not exist`;
      }
      const next = current[index];
      if (isLast) {
        return { value: next, parent: current, key: token };
      }
      current = next;
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return `path '${pointer}' does not exist`;
      }
      const next = (current as Record<string, unknown>)[token];
      if (isLast) {
        return { value: next, parent: current, key: token };
      }
      current = next;
    } else {
      return `path '${pointer}' does not exist`;
    }
  }
  return `path '${pointer}' does not reference a leaf field`;
}

function report(
  issues: ParameterIssue[],
  message: string,
  parameter?: string,
  path?: string
): void {
  issues.push({ message, parameter, path });
}

/**
 * Validates the parameter declarations against the flow and returns the
 * resolved leaves in declaration order. All problems are accumulated rather
 * than reported on the first failure.
 */
function validateDefinitions(
  flow: UserFlow,
  definitions: ParameterDefinitions,
  issues: ParameterIssue[]
): void {
  const boundPaths = new Map<string, string>();
  const names = Object.keys(definitions).sort();

  for (const name of names) {
    const binding = definitions[name] as unknown;
    const fail = (message: string, path?: string) =>
      report(issues, message, name, path);

    if (!name) {
      fail('parameter name must not be empty');
      continue;
    }
    if (binding === null || typeof binding !== 'object') {
      fail('parameter binding must be an object');
      continue;
    }

    const { path, type, defaultValue } = binding as Record<string, unknown>;
    const bindingPath = typeof path === 'string' ? path : undefined;
    let leaf: ResolvedLeaf | undefined;
    let tokens: string[] | undefined;
    let pointerResolved = true;

    if (bindingPath === undefined || bindingPath === '') {
      fail('binding must contain a non-empty string `path`');
      pointerResolved = false;
    } else {
      const parsed = parsePointer(bindingPath);
      if (typeof parsed === 'string') {
        fail(parsed, bindingPath);
        pointerResolved = false;
      } else {
        tokens = parsed;
        const resolved = resolveLeaf(flow, bindingPath, tokens);
        if (typeof resolved === 'string') {
          fail(resolved, bindingPath);
          pointerResolved = false;
        } else {
          leaf = resolved;
        }
      }
    }

    const typeValid =
      typeof type === 'string' &&
      PARAMETER_TYPES.has(type as ParameterValueType);
    if (!typeValid) {
      fail(`binding \`type\` must be one of 'string', 'number' or 'boolean'`);
    }

    // Whether the pointer resolves to a scalar, non-`type` leaf that could be
    // bound. A type mismatch does not make the leaf unbindable for the
    // purposes of duplicate detection.
    let bindableLeaf = false;
    if (pointerResolved && leaf && tokens && bindingPath) {
      const lastToken = tokens[tokens.length - 1];
      if (lastToken === 'type') {
        fail('the `type` field cannot be bound to a parameter', bindingPath);
      } else if (
        leaf.value === null ||
        typeof leaf.value === 'object' ||
        Array.isArray(leaf.value)
      ) {
        fail(
          `path must point at a leaf field but the value at '${bindingPath}' is ${describeType(
            leaf.value
          )}`,
          bindingPath
        );
      } else {
        bindableLeaf = true;
        if (
          typeValid &&
          !matchesParameterType(leaf.value, type as ParameterValueType)
        ) {
          fail(
            `binding type '${type}' does not match the ${describeType(
              leaf.value
            )} field at '${bindingPath}'`,
            bindingPath
          );
        }
      }
    }

    if (defaultValue !== undefined) {
      if (
        !typeValid ||
        !matchesParameterType(defaultValue, type as ParameterValueType)
      ) {
        fail(
          `default value ${JSON.stringify(
            defaultValue
          )} does not match the declared binding type`,
          bindingPath
        );
      }
    }

    // Duplicate paths are reported regardless of type problems so every
    // issue surfaces in the single pre-run failure. Only pointers that
    // resolve to an existing, bindable leaf are tracked.
    if (bindingPath && bindableLeaf) {
      const owner = boundPaths.get(bindingPath);
      if (owner !== undefined) {
        fail(`path is already bound by parameter '${owner}'`, bindingPath);
      } else {
        boundPaths.set(bindingPath, name);
      }
    }
  }
}

function validateValues(
  definitions: ParameterDefinitions,
  values: ParameterValues,
  issues: ParameterIssue[]
): void {
  for (const name of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
      report(issues, `unknown parameter has no binding declaration`, name);
    }
  }

  for (const name of Object.keys(definitions).sort()) {
    const binding = definitions[name]!;
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      if (binding.defaultValue === undefined) {
        report(
          issues,
          `missing required parameter and no default value is declared`,
          name,
          binding.path
        );
      }
      continue;
    }
    const value = values[name];
    if (!matchesParameterType(value, binding.type)) {
      const detail =
        binding.type === 'number' &&
        typeof value === 'number' &&
        !Number.isFinite(value)
          ? 'numbers must be finite'
          : `expected ${binding.type} but got ${describeType(value)}`;
      report(
        issues,
        `parameter value is invalid: ${detail}`,
        name,
        binding.path
      );
    }
  }
}

/**
 * Binds typed parameter values to a user flow.
 *
 * Bindings are declared on the flow as `parameters` and point at existing
 * leaf fields through RFC 6901 JSON Pointers. The original flow is never
 * mutated: a deeply cloned flow with the bound values is returned.
 *
 * Every declaration and run time value is validated up front and a single
 * {@link ParameterError} reporting all problems is thrown before any hook
 * runs or any browser is launched. The returned flow conforms to the same
 * user flow schema as the input.
 *
 * @param flow - the recording containing the leaf fields and optional
 * `parameters` declarations
 * @param definitions - the parameter declarations; defaults to `flow.parameters`
 * @param values - the run time parameter values; declared defaults are used
 * for parameters that are not supplied
 */
export function bindParameters(
  flow: UserFlow,
  definitions: ParameterDefinitions = flow.parameters ?? {},
  values: ParameterValues = {}
): UserFlow {
  const issues: ParameterIssue[] = [];
  validateDefinitions(flow, definitions, issues);
  validateValues(definitions, values, issues);

  if (issues.length > 0) {
    throw new ParameterError(issues);
  }

  const boundFlow = structuredClone(flow);
  for (const name of Object.keys(definitions)) {
    const binding = definitions[name]!;
    const tokens = parsePointer(binding.path) as string[];
    let parent: unknown = boundFlow;
    for (let i = 0; i < tokens.length - 1; i++) {
      const token = tokens[i] as string;
      parent = (parent as unknown[] | Record<string, unknown>)[
        token as never
      ] as unknown;
    }
    const lastToken = tokens[tokens.length - 1] as string;
    (parent as Record<string, unknown>)[lastToken] =
      Object.prototype.hasOwnProperty.call(values, name)
        ? values[name]
        : binding.defaultValue;
  }

  return boundFlow;
}
