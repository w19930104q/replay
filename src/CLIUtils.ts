/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parse,
  createRunner,
  PuppeteerRunnerOwningBrowserExtension,
  bindParameters,
} from './main.js';
import { readFileSync, readdirSync, lstatSync } from 'fs';
import { join, isAbsolute, extname, relative } from 'path';
import { pathToFileURL } from 'url';
import { cwd } from 'process';
import { Browser } from 'puppeteer';
import { styleText } from 'node:util';
import type { ParameterValues, ParameterValue } from './Parameters.js';

export class StatusReport extends Array<string[]> {
  override toString(): string {
    const headers = ['Title', 'Status', 'File', 'Duration'];
    const allRows = [headers, ...this];

    const colWidths = headers.map((_, colIndex) => {
      return Math.max(...allRows.map((row) => (row[colIndex] || '').length));
    });

    return allRows
      .map((row, rowIndex) => {
        const paddedRow = row
          .map((cell, colIndex) => {
            const cellStr = cell || '';
            let formattedCell = cellStr;

            if (rowIndex > 0 && colIndex === 1) {
              formattedCell =
                cellStr === ' Success '
                  ? styleText(['white', 'bgGreen'], cellStr)
                  : styleText(['white', 'bgRed'], cellStr);
            }

            const padding = ' '.repeat(
              Math.max(0, colWidths[colIndex]! - cellStr.length)
            );
            return formattedCell + padding;
          })
          .join('  ');

        if (rowIndex === 0) {
          const separator = colWidths.map((w) => '═'.repeat(w)).join('══');
          return `${paddedRow}\n${separator}`;
        }
        return paddedRow;
      })
      .join('\n');
  }
}

export function getJSONFilesFromFolder(path: string): string[] {
  return readdirSync(path)
    .filter((file) => extname(file) === '.json')
    .map((file) => join(path, file));
}

export function getRecordingPaths(
  paths: string[],
  log: boolean = true
): string[] {
  const recordingPaths: string[] = [];

  for (const path of paths) {
    let isDirectory;
    try {
      isDirectory = lstatSync(path).isDirectory();
    } catch (err) {
      log && console.error(`Couldn't find file/folder: ${path}`, err);

      continue;
    }

    if (isDirectory) {
      const filesInFolder = getJSONFilesFromFolder(path);

      if (!filesInFolder.length)
        log && console.error(`There is no recordings in: ${path}`);

      recordingPaths.push(...filesInFolder);
    } else recordingPaths.push(path);
  }

  return recordingPaths;
}

export function getHeadlessEnvVar(headless?: string) {
  if (!headless) {
    return true;
  }
  switch (headless.toLowerCase()) {
    case '1':
    case 'true':
      return true;
    case 'shell':
      return 'shell';
    case '0':
    case 'false':
      return false;
    default:
      throw new Error('PUPPETEER_HEADLESS: unrecognized value');
  }
}

/**
 * Parses `--param name=value` CLI arguments into run time parameter values.
 * Each value is first interpreted as a JSON literal (so `true`, `false`,
 * numbers and quoted strings keep their type); values that are not valid JSON
 * are treated as plain strings. Throws on arguments without `=`.
 */
export function parseParameterArgs(args: string[]): ParameterValues {
  const parameters: ParameterValues = {};
  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator <= 0) {
      throw new Error(
        `Invalid --param argument '${arg}'. Expected 'name=value'.`
      );
    }
    const name = arg.substring(0, separator);
    const rawValue = arg.substring(separator + 1);
    parameters[name] = parseParameterValue(rawValue);
  }
  return parameters;
}

function parseParameterValue(rawValue: string): ParameterValue {
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  const maybeNumber = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isFinite(maybeNumber)) {
    return maybeNumber;
  }
  // Fall back to JSON parsing for quoted strings and reject non-scalar JSON.
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (
      typeof parsed === 'string' ||
      typeof parsed === 'boolean' ||
      (typeof parsed === 'number' && Number.isFinite(parsed))
    ) {
      return parsed;
    }
  } catch {
    // Not valid JSON: treat the raw text as a string.
  }
  return rawValue;
}

type Result = {
  startedAt: Date;
  file: string;
  finishedAt: Date;
  success: boolean;
  title: string;
};

export function createStatusReport(results: Result[]): StatusReport {
  const table = new StatusReport();

  for (const result of results) {
    const row: string[] = [];

    const duration =
      result.finishedAt?.getTime()! - result.startedAt.getTime() || 0;
    const status = result.success ? ' Success ' : ' Failure ';

    row.push(result.title);
    row.push(status);
    row.push(relative(process.cwd(), result.file));
    row.push(`${duration}ms`);

    table.push(row);
  }

  return table;
}

export async function importExtensionFromPath(path: string): Promise<any> {
  const module = await import(
    pathToFileURL(isAbsolute(path) ? path : join(cwd(), path)).toString()
  );
  return module.default;
}

export async function runFiles(
  files: string[],
  opts: {
    log: boolean;
    headless: boolean | 'shell';
    extension?: string;
    parameters?: ParameterValues;
  } = {
    log: true,
    headless: true,
  }
): Promise<void> {
  let Extension = PuppeteerRunnerOwningBrowserExtension;
  let browser: Browser | undefined;

  if (opts.extension) {
    Extension = await importExtensionFromPath(opts.extension);
  }

  const results: Result[] = [];
  for (const file of files) {
    const result: Result = {
      title: '',
      startedAt: new Date(),
      finishedAt: new Date(),
      file,
      success: true,
    };

    opts.log && console.log(`Running ${file}...`);
    try {
      const content = readFileSync(file, 'utf-8');
      const object = JSON.parse(content);
      const recording = parse(object);
      result.title = recording.title;

      // Bind and validate parameters before launching the browser so that
      // invalid parameters fail fast with their name and pointer. A flow
      // with declared parameters is always bound so defaults apply.
      const boundRecording =
        recording.parameters && Object.keys(recording.parameters).length > 0
          ? bindParameters(
              recording,
              recording.parameters,
              opts.parameters ?? {}
            )
          : recording;

      const { default: puppeteer } = await import('puppeteer');
      browser = await puppeteer.launch({
        headless: opts.headless,
      });
      const page = await browser.newPage();
      const extension = new Extension(browser, page);
      const runner = await createRunner(boundRecording, extension);
      await runner.run();
      opts.log && console.log(`Finished running ${file}`);
    } catch (err) {
      opts.log && console.error(`Error running ${file}`, err);
      result.success = false;
    } finally {
      result.finishedAt = new Date();
      results.push(result);

      await browser?.close();
    }
  }

  if (opts.log) {
    const statusReport = createStatusReport(results);
    console.log(statusReport.toString());
  }

  if (results.every((result) => result.success)) return;

  throw new Error('Some recordings have failed to run.');
}
