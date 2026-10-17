// Module hooks that let the Terminal worker run the app's TypeScript sources
// directly (Node's type stripping): `@/x` resolves to <app>/src/x, and
// imports without an extension find x.ts or x/index.ts. Same rules as
// tests/ts-esm-loader.mjs.

const SRC = new URL('../../../src/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  const target = specifier.startsWith('@/') ? new URL(specifier.slice(2), SRC).href : specifier;
  try {
    return await nextResolve(target, context);
  } catch (error) {
    const local = target.startsWith('.') || target.startsWith('file:');
    if (/\.[cm]?[jt]sx?$/.test(target)) throw error;
    if (!local) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !target.includes('/')) throw error;
      return nextResolve(`${target}.js`, context);
    }
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(target + suffix, context);
      } catch {
        // the next candidate
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    return nextLoad(url, { ...context, format: 'module-typescript' });
  }
  return nextLoad(url, context);
}
