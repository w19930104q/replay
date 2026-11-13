// ESM loader that redirects bare module specifiers used by generated scripts
// to the local test doubles, so the generated code runs fully offline.
const puppeteerStub = new URL('./stub-puppeteer.mjs', import.meta.url).href;
const replayEntry = new URL('../../../lib/main.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'puppeteer') {
    return nextResolve(puppeteerStub, context);
  }
  if (specifier === '@puppeteer/replay') {
    return nextResolve(replayEntry, context);
  }
  return nextResolve(specifier, context);
}
