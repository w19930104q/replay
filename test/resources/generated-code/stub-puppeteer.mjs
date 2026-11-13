// Test double for the `puppeteer` module used when executing generated
// scripts. It records every interaction to a JSON file instead of launching
// a browser. The output path is provided through PUPPETEER_STUB_LOG.
import { writeFileSync } from 'node:fs';

const logFile = process.env['PUPPETEER_STUB_LOG'];
export const calls = [];

function toSerializable(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toSerializable);
  }
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = toSerializable(value[key]);
    }
    return result;
  }
  return String(value);
}

function persist() {
  if (logFile) {
    writeFileSync(logFile, JSON.stringify(calls));
  }
}

function makeChain() {
  const chain = { then: undefined };
  const handler = {
    get(target, prop) {
      if (prop === 'then') {
        // The chain is never awaited directly; keep it non-thenable.
        return undefined;
      }
      return (...args) => {
        calls.push({ method: String(prop), args: toSerializable(args) });
        persist();
        // Return the proxy so further chained calls keep being intercepted.
        return proxy;
      };
    },
  };
  const proxy = new Proxy(chain, handler);
  return proxy;
}

export class Locator {
  static race(locators) {
    calls.push({
      method: 'Locator.race',
      args: toSerializable(locators),
    });
    persist();
    return makeChain();
  }
}

export const page = {
  setDefaultTimeout: (timeout) => {
    calls.push({ method: 'page.setDefaultTimeout', args: [timeout] });
    persist();
  },
  goto: (url) => {
    calls.push({ method: 'page.goto', args: [url] });
    persist();
  },
  setViewport: (viewport) => {
    calls.push({
      method: 'page.setViewport',
      args: [toSerializable(viewport)],
    });
    persist();
  },
  locator: (selector) => {
    calls.push({ method: 'page.locator', args: [selector] });
    persist();
    return makeChain();
  },
};

export const browser = {
  newPage: async () => {
    calls.push({ method: 'browser.newPage', args: [] });
    persist();
    return page;
  },
  close: async () => {
    calls.push({ method: 'browser.close', args: [] });
    persist();
  },
};

export const launch = async () => {
  calls.push({ method: 'launch', args: [] });
  persist();
  return browser;
};

export default { Locator, launch, page, browser, calls };
