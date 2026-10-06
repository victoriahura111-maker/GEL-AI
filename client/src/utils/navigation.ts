/**
 * Full-page navigation seam.
 *
 * Redirecting to an external origin (e.g. Notion's OAuth page) requires a real
 * top-level navigation. Wrapping the browser call in a tiny module keeps the
 * call site testable: jsdom 26 (shipped with Jest 30) defines
 * `window.location.assign` as a non-configurable, non-writable property, so it
 * can no longer be stubbed directly from a test. Tests mock this module instead.
 */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
