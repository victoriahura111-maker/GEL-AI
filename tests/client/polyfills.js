/**
 * Jest (jsdom) environment polyfills for the client test suite.
 *
 * React Router v7 references `TextEncoder`/`TextDecoder` at module load time,
 * but jest-environment-jsdom's global does not expose them. Node provides both
 * on `node:util`, so install them before any test module (and therefore before
 * `react-router-dom`) is imported. Kept as plain JS to avoid pulling Node types
 * into the client test tsconfig.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS setup file; Node's util is the only source for these globals under jsdom
const { TextDecoder, TextEncoder } = require('node:util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}
