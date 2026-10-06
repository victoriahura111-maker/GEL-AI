/**
 * Typed errors thrown by the AI layer. All messages are user-safe: the route
 * maps each error to a fixed, non-leaking HTTP response.
 */

export type AiServiceErrorCode = 'not_configured' | 'provider_error' | 'network_error';

/**
 * Raised by the provider abstraction when the AI call cannot be completed.
 * `code === 'not_configured'` maps to a 503; every other code maps to a 502.
 */
export class AiServiceError extends Error {
  readonly code: AiServiceErrorCode;

  constructor(message: string, code: AiServiceErrorCode) {
    super(message);
    this.name = 'AiServiceError';
    this.code = code;
  }
}

/**
 * Raised by the intent extractor when the model output cannot be parsed into a
 * valid intent after the single corrective retry. The route maps this to a
 * graceful "I couldn't understand that" response.
 */
export class IntentExtractionError extends Error {
  constructor(message = "I couldn't understand that request.") {
    super(message);
    this.name = 'IntentExtractionError';
  }
}
