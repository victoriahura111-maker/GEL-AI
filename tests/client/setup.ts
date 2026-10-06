import '@testing-library/jest-dom';

/**
 * Vite-only module shim for Jest.
 *
 * `client/src/services/supabase.ts` reads `import.meta.env.VITE_SUPABASE_*`, which
 * Vite replaces at build time. jest-environment-jsdom transpiles to CommonJS,
 * where `import.meta` is a runtime syntax error, so importing the real module
 * from a test crashes.
 *
 * This registers a lightweight global Supabase stub. Suites that need specific
 * auth behaviour (App/auth/shell) call `jest.mock` on the same module themselves
 * and their factory takes precedence, so this shim only replaces the real client
 * for suites that would otherwise only need the module to load.
 */
jest.mock('../../client/src/services/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signUp: jest.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
      signInWithPassword: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: jest.fn().mockResolvedValue({ data: {}, error: null }),
      updateUser: jest.fn().mockResolvedValue({ data: { user: null }, error: null }),
    },
  },
}));
