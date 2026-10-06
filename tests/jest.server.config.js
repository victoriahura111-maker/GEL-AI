/** @type {import('jest').Config} */
module.exports = {
  displayName: 'server',
  rootDir: '..',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/server/setupEnv.ts'],
  testMatch: ['<rootDir>/tests/server/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tests/server/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],

  // Phase 18 — coverage. Collection covers `server/src` minus the bootstrap
  // entrypoint, ambient types, and pure barrels. `collectCoverageFrom` alone does
  // NOT enable collection: `npm test` stays fast, and `npm run test:coverage`
  // turns it on (which is when the thresholds below are enforced).
  collectCoverageFrom: ['server/src/**/*.{ts,tsx}', '!server/src/**/*.d.ts'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/server/src/index.ts',
    '<rootDir>/server/src/types/',
    '<rootDir>/server/src/services/index.ts',
    '<rootDir>/server/src/controllers/index.ts',
    '<rootDir>/server/src/routes/index.ts',
    '<rootDir>/server/src/validators/index.ts',
    '<rootDir>/server/src/middleware/index.ts',
    '<rootDir>/server/src/utils/index.ts',
  ],
  // Jest 30 moved `coverageThreshold` to the root config (see jest.config.js);
  // defining it per project is no longer supported.
};
