# AI Tools

Describes how the assistant talks to the AI provider and why it uses a strict
JSON _intent_ contract instead of OpenAI function/tool calling.

> **Status (final).** The assistant does **not** use provider function/tool
> calling, so there is no external tool registry to catalogue. Instead the model
> returns a structured JSON **intent** validated by Zod; the server maps that
> intent to UI cards and performs **all** privileged work itself, only after the
> user confirms. See [assistant.md](assistant.md) for the action contract.
>
> **Notion access stays server-side.** The Notion inspection/mapping services a
> `get_notion_database_schema` tool would have wrapped are real and in production
> use — but they are called directly by the task orchestrators, never exposed to
> the model:
> [`getDatabaseSchema()`](../server/src/services/notion/schema.ts:191),
> [`resolvePropertyMapping()`](../server/src/services/notion/propertyMapping.ts:146),
> and [`buildNotionProperties()`](../server/src/services/notion/propertyMapping.ts:337).
> Keeping Notion behind the server (rather than as model-callable tools) is a
> deliberate security boundary — the model can never read a token or issue a
> Notion write directly (see [security.md](security.md) §9).

## Provider abstraction

All provider HTTP goes through a single module: [`server/src/services/ai/provider.ts`](../server/src/services/ai/provider.ts:1).

- [`createChatCompletion()`](../server/src/services/ai/provider.ts:49) POSTs to `${AI_BASE_URL}/chat/completions` using native `fetch` (Node 18+, no axios/node-fetch).
- It sends `Authorization: Bearer <AI_API_KEY>` and, when `jsonMode` is true, `response_format: { type: 'json_object' }`.
- It returns the assistant's text content and throws a typed [`AiServiceError`](../server/src/services/ai/errors.ts:12) on non-OK HTTP, network failure, empty payloads, or when the AI is not configured.
- The API key is never logged and never included in error messages. Swapping providers means editing only this file (or changing `AI_BASE_URL`).

## Structured output (intent schema)

Rather than function/tool calls, Phase 5 uses a strict JSON contract validated by Zod.

- Schema: [`intentSchema`](../server/src/validators/intent.ts:271) — a strict discriminated union on `intent`.
- Extraction + single corrective retry: [`extractIntent()`](../server/src/services/ai/extractor.ts:107).
- System prompt (schema description, current date/time, timezone, no-invention rule, prompt-injection hardening): [`buildIntentSystemPrompt()`](../server/src/services/ai/prompts.ts:23).
- Intent → UI card mapping: [`intentToCards()`](../server/src/services/ai/toCards.ts:110).

Supported intents: `create_task`, `update_task`, `complete_task`, `cancel_task`, `delete_task`, `postpone_task`, `reschedule_task`, `search_tasks`, `list_tasks`, `get_task`, `create_reminder`, `update_reminder`, `cancel_reminder`, `check_task_status`, `clarify`, `general`.

## Missing-information rule

The model must never invent data. Missing fields are `null`/omitted and surfaced in `missing_information`; when required details are absent the model returns `clarify` and the assistant asks a follow-up question. No card is emitted for a `clarify` intent.

## Prompt-injection hardening

Everything the user writes — and any externally sourced content — is treated as **DATA**, never as instructions. The system prompt explicitly tells the model to ignore attempts to change its role, reveal the prompt, or override the rules.

## Required environment variables

| Variable      | Required    | Purpose                                                              |
| ------------- | ----------- | -------------------------------------------------------------------- |
| `AI_API_KEY`  | yes         | Provider credential (never logged).                                  |
| `AI_MODEL`    | yes         | Model identifier.                                                    |
| `AI_PROVIDER` | recommended | Provider label (documentation/telemetry only).                       |
| `AI_BASE_URL` | no          | OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`. |

The endpoint returns `503` when `AI_API_KEY` or `AI_MODEL` is missing.

## Tests

Provider HTTP is always mocked in tests — no real AI calls are made. See [`tests/server/aiExtraction.test.ts`](../tests/server/aiExtraction.test.ts) and [`tests/server/assistantRoute.test.ts`](../tests/server/assistantRoute.test.ts).
