import { config } from '../../config';
import { AiServiceError } from './errors';

/**
 * The single place in the server that talks HTTP to an AI provider.
 *
 * It targets the OpenAI-compatible `POST /chat/completions` contract, so any
 * provider exposing that shape (OpenAI, Azure OpenAI, OpenRouter, Groq, Ollama,
 * a local gateway, ...) works by pointing `AI_BASE_URL` at it. Swapping the
 * provider only requires changing this file.
 *
 * Built on the native `fetch` available in Node 18+ (no axios/node-fetch).
 * The API key is never logged and never included in thrown error messages.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** Defaults to the configured `AI_MODEL`. */
  model?: string;
  /** Defaults to 0 for deterministic intent extraction. */
  temperature?: number;
  /** When true, requests `response_format: { type: 'json_object' }`. */
  jsonMode?: boolean;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

/**
 * Calls the configured OpenAI-compatible chat-completions endpoint and returns
 * the assistant's text content.
 *
 * @throws {AiServiceError} with code `not_configured` when `AI_API_KEY` or
 * `AI_MODEL` is missing, `network_error` when the request never reaches the
 * provider, and `provider_error` for non-OK HTTP or unreadable/empty payloads.
 */
export async function createChatCompletion({
  messages,
  model,
  temperature = 0,
  jsonMode = false,
}: ChatCompletionRequest): Promise<string> {
  if (!config.isAiConfigured) {
    throw new AiServiceError('The AI assistant is not configured.', 'not_configured');
  }

  const requestModel = model ?? config.aiModel;
  if (!requestModel) {
    throw new AiServiceError('The AI assistant is not configured.', 'not_configured');
  }

  const baseUrl = config.aiBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify({
        model: requestModel,
        temperature,
        messages,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch {
    // Deliberately do not surface the underlying error or the request headers.
    throw new AiServiceError('Could not reach the AI provider.', 'network_error');
  }

  if (!response.ok) {
    throw new AiServiceError('The AI provider returned an error.', 'provider_error');
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new AiServiceError('The AI provider returned an unreadable response.', 'provider_error');
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AiServiceError('The AI provider returned an empty response.', 'provider_error');
  }

  return content;
}

export { AiServiceError };
