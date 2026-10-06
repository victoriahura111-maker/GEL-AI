/** @type {import('jest').Config} */
module.exports = {
  displayName: 'client',
  rootDir: '..',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/client/**/*.test.{ts,tsx}'],
  // React Router v7 touches TextEncoder/TextDecoder at import time; polyfill
  // them (from Node) before any test module is loaded.
  setupFiles: ['<rootDir>/tests/client/polyfills.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/client/setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tests/client/tsconfig.json' }],
  },
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': '<rootDir>/tests/client/styleMock.js',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  // Phase 18 — coverage (see tests/jest.server.config.js for the contract).
  // `client/src/services/supabase.ts` reads `import.meta.env`, which the CommonJS
  // ts-jest transform cannot type-check, so it is excluded (it is a Vite-only
  // module that every suite mocks or shims).
  collectCoverageFrom: ['client/src/**/*.{ts,tsx}'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/client/src/main.tsx',
    '<rootDir>/client/src/vite-env.d.ts',
    '<rootDir>/client/src/types.ts',
    '<rootDir>/client/src/types/',
    '<rootDir>/client/src/services/supabase.ts',
    '<rootDir>/client/src/services/index.ts',
    '<rootDir>/client/src/utils/index.ts',
    // Thin DOM-navigation wrapper; its behaviour is asserted at the call site via
    // a module mock (jsdom 26 makes `window.location.assign` unmockable).
    '<rootDir>/client/src/utils/navigation.ts',
    '<rootDir>/client/src/hooks/index.ts',
    '<rootDir>/client/src/context/index.ts',
    '<rootDir>/client/src/components/tasks/index.ts',
  ],
  // Jest 30 moved `coverageThreshold` to the root config (see jest.config.js);
  // defining it per project is no longer supported.
};
