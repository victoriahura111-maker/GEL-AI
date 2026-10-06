import { createChatCompletion } from './provider';
import type { ChatMessage } from './provider';
import { IntentExtractionError } from './errors';
import { buildIntentSystemPrompt, CORRECTIVE_SYSTEM_MESSAGE } from './prompts';
import { wrapUntrustedContent } from './untrustedContent';
import { intentSchema } from '../../validators/intent';
import type { Intent } from '../../validators/intent';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExtractIntentParams {
  /** The latest user message to interpret. */
  content: string;
  /** Optional prior conversation turns (oldest first). */
  history?: ChatTurn[];
  /** The user's IANA timezone. */
  timezone: string;
  /** The current instant as ISO 8601 (callers pass a single `now` for the request). */
  nowIso: string;
}

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 4000;
const MAX_TURN_CHARS = 2000;

type ParseResult = { success: true; data: Intent } | { success: false; error: string };

/**
 * Keeps only the most recent history turns, bounded by both a turn count and a
 * total character budget, so the model context cannot be flooded.
 */
function trimHistory(history: ChatTurn[] = []): ChatTurn[] {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const kept: ChatTurn[] = [];
  let budget = MAX_HISTORY_CHARS;

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
    const content = turn.content.slice(0, MAX_TURN_CHARS);
    if (content.length > budget) break;
    kept.unshift({ role: turn.role, content });
    budget -= content.length;
  }

  return kept;
}

/**
 * Parses JSON from model output, tolerating markdown code fences and leading or
 * trailing prose around a single JSON object.
 */
export function parseJsonResponse(raw: string): unknown {
  const withoutFences = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start !== -1 && end > start) {
      // Let the caller handle a second JSON.parse failure.
      return JSON.parse(withoutFences.slice(start, end + 1));
    }
    throw new Error('Unparseable AI response.');
  }
}

function tryParseIntent(raw: string): ParseResult {
  try {
    const json = parseJsonResponse(raw);
    const parsed = intentSchema.safeParse(json);
    if (parsed.success) {
      return { success: true, data: parsed.data };
    }
    return { success: false, error: JSON.stringify(parsed.error.flatten()).slice(0, 1000) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'parse error' };
  }
}

/**
 * Builds the provider message list. Every piece of untrusted text — the stored
 * conversation turns and the new user message — is sanitized and wrapped in
 * explicit DATA-ONLY delimiters so instruction-like content cannot be mistaken
 * for a system instruction (prompt-injection hardening).
 */
function buildMessages(systemPrompt: string, history: ChatTurn[], content: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((turn) => ({
      role: turn.role,
      content: wrapUntrustedContent(
        turn.role === 'user' ? 'conversation history (user)' : 'conversation history (assistant)',
        turn.content
      ),
    })),
    { role: 'user', content: wrapUntrustedContent('user message', content) },
  ];
}

/**
 * Converts a natural-language message into a validated `Intent`.
 *
 * Sends the system prompt plus recent history and the new message to the
 * OpenAI-compatible provider in JSON mode, then validates the output against
 * `intentSchema`. On validation failure it retries exactly once with a
 * corrective system message; if the retry also fails it throws an
 * `IntentExtractionError` (the route maps this to a graceful response).
 *
 * Provider-level failures (`AiServiceError`) propagate unchanged.
 */
export async function extractIntent(params: ExtractIntentParams): Promise<Intent> {
  const { content, timezone, nowIso } = params;
  const systemPrompt = buildIntentSystemPrompt({ timezone, nowIso });
  const history = trimHistory(params.history);
  const conversation = buildMessages(systemPrompt, history, content);

  const firstRaw = await createChatCompletion({
    messages: conversation,
    jsonMode: true,
    temperature: 0,
  });

  const firstAttempt = tryParseIntent(firstRaw);
  if (firstAttempt.success) {
    return firstAttempt.data;
  }

  // Single corrective retry. The raw output is echoed back to the model only,
  // never to the caller.
  const correctiveMessages: ChatMessage[] = [
    ...conversation,
    { role: 'assistant', content: firstRaw },
    {
      role: 'system',
      content: `${CORRECTIVE_SYSTEM_MESSAGE}\nValidation errors: ${firstAttempt.error}`,
    },
  ];

  const secondRaw = await createChatCompletion({
    messages: correctiveMessages,
    jsonMode: true,
    temperature: 0,
  });

  const secondAttempt = tryParseIntent(secondRaw);
  if (secondAttempt.success) {
    return secondAttempt.data;
  }

  // Log validation failures only — never the API key or raw model output.
  console.error(
    '[ai] Intent extraction failed after retry.',
    `first=${firstAttempt.error}`,
    `second=${secondAttempt.error}`
  );
  throw new IntentExtractionError();
}
