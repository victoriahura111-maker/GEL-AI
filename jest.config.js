module.exports = {
  projects: ['<rootDir>/tests/jest.server.config.js', '<rootDir>/tests/jest.client.config.js'],
  // Phase 18 — coverage options are *global* (they are deliberately absent from
  // the per-project option allowlist). Jest 30 additionally moved
  // `coverageThreshold` here: defining it in a project config now emits a
  // validation warning and is ignored, so the thresholds live at the root and
  // apply to the combined client+server coverage.
  coverageReporters: ['text-summary', 'lcov'],
  // Merged client+server coverage; ~2 points below the measured
  // 78.15 / 64.15 / 66.21 / 80.18 (statements/branches/functions/lines).
  coverageThreshold: {
    global: {
      statements: 76,
      branches: 62,
      functions: 64,
      lines: 78,
    },
  },
};
