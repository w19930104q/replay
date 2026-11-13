/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseParameterArgs } from '../src/CLIUtils.js';

describe('parseParameterArgs', () => {
  it('parses strings, booleans and finite numbers', () => {
    assert.deepStrictEqual(
      parseParameterArgs([
        'region=emea',
        'width=1280',
        'ratio=0.5',
        'mobile=true',
        'landscape=false',
      ]),
      {
        region: 'emea',
        width: 1280,
        ratio: 0.5,
        mobile: true,
        landscape: false,
      }
    );
  });

  it('keeps non-numeric and quoted values as strings', () => {
    assert.deepStrictEqual(
      parseParameterArgs([
        'query=quarterly report',
        'quoted="true"',
        'label=123abc',
      ]),
      {
        query: 'quarterly report',
        quoted: 'true',
        label: '123abc',
      }
    );
  });

  it('supports repeated parameters and complex quotes', () => {
    assert.deepStrictEqual(
      parseParameterArgs([
        'a=one',
        'a=two',
        'tricky=he said "hi" it\'s `code` ${x}',
      ]),
      {
        a: 'two',
        tricky: 'he said "hi" it\'s `code` ${x}',
      }
    );
  });

  it('rejects arguments without an assignment', () => {
    assert.throws(() => parseParameterArgs(['novalue']), /name=value/);
    assert.throws(() => parseParameterArgs(['=value']), /name=value/);
  });
});
