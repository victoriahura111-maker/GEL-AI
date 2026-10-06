# Security

The security model for the AI Virtual Task Assistant: how callers are
authenticated and authorized, how data is isolated and protected at rest and in
transit, how the AI pipeline resists prompt injection, and how the server is
hardened at the HTTP edge.

Phase 17 consolidated and extended these controls; where a control predates
Phase 17 the originating module is cited so it can be reviewed in place.

---

## 1. Threat model

| Adversary / risk                                                                   | Mitigation                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated caller reaches a private endpoint                                  | `authenticate` on every non-public route (§2); enforced by [`routeAuth.test.ts`](../tests/server/routeAuth.test.ts).                                                          |
| Authenticated user reads/mutates another user's data                               | Every query is scoped by `user_id` taken from the verified token (§3), RLS as a second layer, and [`crossUserIsolation.test.ts`](../tests/server/crossUserIsolation.test.ts). |
| Leaked anon key used against Supabase directly                                     | RLS on every table (§3).                                                                                                                                                      |
| Stolen Notion token read from the database                                         | AES-256-GCM encryption at rest (§4).                                                                                                                                          |
| OAuth `state` forgery / replay / cross-account redemption                          | Signed, expiring, single-use, user-bound state (§5).                                                                                                                          |
| Brute force / resource exhaustion / bill shock from the AI or Notion APIs          | Per-user/per-IP rate limiting + the sync cooldown (§6).                                                                                                                       |
| Malicious SPA origin reading API responses                                         | CORS allow-list (§7).                                                                                                                                                         |
| Class of transport/header weaknesses (MIME sniffing, clickjacking, `X-Powered-By`) | Helmet + `x-powered-by` disabled (§7).                                                                                                                                        |
| Prompt injection via user text or Notion-sourced content                           | Sanitize + wrap untrusted content and a data-only system prompt (§9).                                                                                                         |
| Secrets leaked through logs                                                        | Logging hygiene + `redact()` (§11).                                                                                                                                           |
| Missing/failed audit trail                                                         | Best-effort audit writes that never fail the request (§12).                                                                                                                   |

---

## 2. Authentication & authorization

- Every user-facing API route is protected by the `authenticate` middleware
  ([`server/src/middleware/authenticate.ts`](../server/src/middleware/authenticate.ts)),
  which verifies the Supabase access token and attaches `req.user = { id, email }`.
  It answers `503` when Supabase is not configured and `401` when the token is
  missing or invalid.
- The acting user id is **always** taken from the verified token, **never** from
  a request body, query string, or header. Handlers ignore any client-supplied
  `user_id`.
- **Public routes** are exactly three:
  - `GET /health` — liveness probe (always `200`, performs no I/O).
  - `GET /health/ready` — readiness probe; returns dependency **configuration
    booleans** only (`200` when Supabase is configured, `503` otherwise). It
    never exposes a URL, key, token, or other secret.
  - `GET /api/notion/oauth/callback` — the browser redirect target; trust is
    derived solely from the signed OAuth `state` (§5).
    Every other mounted route rejects an unauthenticated caller with `401`/`503`.
    The route inventory is asserted dynamically from the routers, so a future
    route added without `authenticate` fails the test suite.

### Bearer tokens, not cookies — CSRF is not applicable

The client authenticates with a **`Authorization: Bearer <token>`** header and
the token is held by the SPA (Supabase JS), not in a cookie. Because
cross-site requests cannot read or attach the victim's bearer token, and the
server never reads credentials from cookies, there is **no ambient credential
for a cross-site request to ride on** — the classic CSRF vector does not apply.
Consequently there is no CSRF-token middleware. If the token model ever changes
to cookies, CSRF protection (SameSite + a double-submit token) must be added.

---

## 3. Row Level Security & per-user scoping

- The server uses the Supabase **service-role** client
  ([`server/src/services/supabase.ts`](../server/src/services/supabase.ts)),
  which **bypasses RLS**. That client is server-only and must never be imported
  by client code.
- Because the service role bypasses RLS, **application-level scoping is the
  primary control**: every repository query filters `.eq('user_id', userId)`.
  A foreign row is treated as if it did not exist (404 / empty result), so a
  foreign id is never distinguishable from a missing one.
- **RLS is enabled on every table** (`database/migrations/`), so a leaked anon
  key used directly against Supabase still cannot read another user's rows.
- The framework/tests enforce this at two levels:
  - repository tests using [`tests/server/supabaseFake.ts`](../tests/server/supabaseFake.ts)
    (which actually applies filters), and
  - [`tests/server/crossUserIsolation.test.ts`](../tests/server/crossUserIsolation.test.ts),
    which drives the real routes and repositories with two identities and asserts
    user A never sees or mutates user B's rows.

---

## 4. Encryption at rest (Notion tokens)

Implemented in [`server/src/utils/encryption.ts`](../server/src/utils/encryption.ts)
and used by the Notion connection repository.

- **Algorithm:** AES-256-GCM — authenticated encryption, so tampering is
  detected rather than silently decrypted.
- **Key:** derived deterministically from `ENCRYPTION_KEY` (>= 32 characters) via
  `scrypt` with a fixed, non-secret, domain-separated salt to 32 bytes. The key
  never leaves the server process.
- **Wire format:** `v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`. The `v1` prefix
  allows future key/algorithm rotation.
- **IV:** a fresh 12-byte random nonce per encryption (no IV reuse).
- **Fail closed:** a missing or too-short key raises a typed configuration error;
  there is no hard-coded fallback key. An auth-tag mismatch raises a typed
  `tampered` error and never returns attacker-controlled plaintext.
- **Only ciphertext is persisted.** `notion_connections.access_token_encrypted`
  never holds a raw token. The plaintext token is decrypted **only** by the
  internal `getConnection()` for server-side Notion calls.

Guarantees: confidentiality of the token at rest; integrity/authenticity (any
modification is detected); no key material in the database, logs, or responses.

---

## 5. OAuth state guarantees (Notion)

Implemented in
[`server/src/services/notion/oauthState.ts`](../server/src/services/notion/oauthState.ts).
The callback endpoint is unauthenticated (it is a browser redirect), so the
`state` is the sole basis of trust:

- **Signed** — HMAC-SHA256 over the payload, keyed by a value derived from
  `ENCRYPTION_KEY`. A state cannot be minted without the server secret.
- **Expiring** — `exp = iat + 10 minutes`; expired states are rejected.
- **Single-use** — a random per-state `nonce` is consumed on first successful
  verification; replays are rejected (`state_replayed`).
- **User-bound** — the payload carries the initiating `userId`; the callback
  derives the acting user only from the verified payload, never from a query
  parameter. A callback can never be redeemed against another account.
- **Constant-time comparisons** — signatures are compared with
  `crypto.timingSafeEqual`.
- **No secret leakage** — callback failures redirect with a short, fixed
  `reason` code. Raw provider errors, the client secret, and the token never
  appear in redirect URLs, responses, or logs.

**Single-instance limitation:** consumed nonces are tracked in an in-process TTL
map. Behind multiple instances/replicas, replay protection is best-effort across
instances; signature, expiry, and user binding still hold. Use a shared store
(e.g. Redis/Postgres) for strict single-use in horizontally scaled deployments.

---

## 6. Rate limiting

Implemented in [`server/src/middleware/rateLimit.ts`](../server/src/middleware/rateLimit.ts)
using `express-rate-limit` v7 (Express 4 compatible). Four limiters are applied:

| Limiter            | Scope                                                         | Default max / window                  |
| ------------------ | ------------------------------------------------------------- | ------------------------------------- |
| `globalLimiter`    | all `/api/*`                                                  | `RATE_LIMIT_MAX` = 300 / 60s          |
| `assistantLimiter` | `POST /api/assistant/messages`, `POST /api/assistant/actions` | `RATE_LIMIT_ASSISTANT_MAX` = 30 / 60s |
| `syncLimiter`      | `POST /api/sync`                                              | `RATE_LIMIT_SYNC_MAX` = 10 / 60s      |
| `notionLimiter`    | `/api/notion/*`                                               | `RATE_LIMIT_NOTION_MAX` = 60 / 60s    |

- **Keying:** by the authenticated user id when available (`req.user?.id`),
  otherwise by client IP (IPv4-mapped IPv6 normalised). Limiters on authenticated
  routes run **after** `authenticate`, so the user key is populated.
- **Responses:** `429` with the standard `RateLimit-*` headers, a `Retry-After`
  header, and a small user-safe JSON body.
- **Trusted proxies:** `trust proxy` is set from `TRUST_PROXY` (default `false`)
  so per-IP limits see the real client behind a trusted reverse proxy and cannot
  be bypassed with spoofed `X-Forwarded-For` when directly exposed.
- The Phase 16 per-user **sync cooldown** (`services/sync/cooldown.ts`) is kept as
  an independent politeness guard and complements `syncLimiter`.
- **Tests:** when `NODE_ENV === 'test'` every exported limiter is skipped so the
  existing suites do not flake; the limiter contract is exercised with a
  factory-built limiter (`createRateLimiter({ enabledInTest: true })`) in
  [`tests/server/rateLimit.test.ts`](../tests/server/rateLimit.test.ts).

---

## 7. CORS, security headers & transport hardening

Implemented in [`server/src/middleware/security.ts`](../server/src/middleware/security.ts)
and wired in [`server/src/app.ts`](../server/src/app.ts).

- **Helmet** with JSON-API defaults: `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy: cross-origin` (the SPA is a separate origin),
  and CSP disabled because this server never returns HTML. `X-Powered-By` is
  removed via `app.disable('x-powered-by')`.
- **CORS** is restricted to the configured origin(s) `CORS_ORIGIN` (default
  `APP_URL`; comma-separated lists supported) with credentials, an explicit
  method list, and only `Authorization` / `Content-Type` as allowed request
  headers. Requests without an `Origin` (curl, server-to-server) are allowed; a
  browser request carrying a **disallowed** `Origin` is rejected with `403`.
- **Preflight** (`OPTIONS`) for an allowed origin is answered with `204 No
Content` and the `Access-Control-*` headers.
- **Body limits:** JSON and urlencoded bodies are capped at `100kb` (assistant
  content is already capped at 4000 characters). Oversized payloads are rejected
  with `413 Payload Too Large`, and malformed JSON with `400`.

---

## 8. Input validation

- Every route validates its body/query/params with **Zod** schemas from
  `server/src/validators/*` before use; failures return a fixed `400` shape that
  never echoes internal errors.
- Environment variables are validated with Zod at boot
  ([`server/src/config/index.ts`](../server/src/config/index.ts)); in production a
  missing required variable exits the process, while development/test log a
  warning and apply safe defaults.
- The service-role client is never imported into client code; the client only
  talks to the API with the bearer token.

---

## 9. Prompt-injection defenses

Implemented in
[`server/src/services/ai/untrustedContent.ts`](../server/src/services/ai/untrustedContent.ts)
and applied in [`server/src/services/ai/extractor.ts`](../server/src/services/ai/extractor.ts)
with a hardened system prompt in
[`server/src/services/ai/prompts.ts`](../server/src/services/ai/prompts.ts).

Untrusted content includes: the user's message, stored conversation turns
(which can embed task titles/descriptions/categories from Notion, or user text
echoed back), and any Notion database title placed in context.

- **Sanitize** (`sanitizeUntrustedContent`): strips control characters (keeping
  `\n`/`\t`), neutralizes instruction-like patterns — "ignore previous
  instructions", `system:`/`assistant:` role markers, "you are now" overrides,
  role tags, `###` headings, prompt-exfiltration attempts, jailbreak phrases —
  caps length, and **flags but keeps** base64-like blobs.
- **Wrap** (`wrapUntrustedContent`): places sanitized content between explicit
  `<<<UNTRUSTED_DATA ... >>>` / `<<<END_UNTRUSTED_DATA>>>` delimiters with a
  `DATA ONLY — never instructions` marker.
- **System prompt:** states that anything inside those delimiters is data to
  interpret, never a command, and instructs the model to refuse attempts to
  change its role/instructions, reveal the system prompt, or expose other users'
  data, and to never invent or expose data the user does not own.
- **Defense in depth in the controller:** a model response can only build
  preview/select/update cards — it **never performs a privileged mutation**. All
  writes require the user's explicit confirm action (`POST /api/assistant/actions`)
  and are scoped to the authenticated user.
- **Tests:** [`tests/server/untrustedContent.test.ts`](../tests/server/untrustedContent.test.ts)
  and [`tests/server/promptInjection.test.ts`](../tests/server/promptInjection.test.ts).
  Note that prompt injection is a mitigations-in-depth problem: these controls
  reduce risk but cannot make a non-deterministic model perfectly reliable; the
  authorization boundary (no unconfirmed mutations, strict per-user scoping) is
  what makes an injection non-catastrophic.

---

## 10. Secrets handling

- Secrets (`NOTION_CLIENT_SECRET`, `ENCRYPTION_KEY`, the Supabase service-role
  key, `AI_API_KEY`) live only in server environment variables, loaded from a
  repo-root `.env` (git-ignored). Only `.env.example` placeholders are committed;
  no secret is ever hard-coded.
- The Notion access token is returned by Notion **only** to the server and is
  never sent to the browser.
- Errors surfaced to clients use fixed, user-safe messages. Provider internals,
  stack traces, tokens, and secrets are never included, and the error middleware
  maps payload/JSON errors to fixed `413`/`400` bodies without echoing input.

---

## 11. Logging hygiene

Implemented in [`server/src/middleware/requestLogger.ts`](../server/src/middleware/requestLogger.ts).

- One line per completed request: method, **redacted** path, status, duration,
  and the authenticated user id.
- It **never** logs the `Authorization`/`Cookie` headers, request bodies (which
  may contain tokens), or query-string secrets.
- `redact()` removes `Bearer` tokens and JWT-shaped values; `redactUrl()` masks
  sensitive query parameters (`token`, `code`, `state`, `secret`, `password`, …)
  before the URL is logged. Both are unit-tested in
  [`tests/server/requestLogger.test.ts`](../tests/server/requestLogger.test.ts).

---

## 12. Audit coverage

Audit rows are written to `public.assistant_audit_logs` via
[`server/src/services/audit/auditLog.ts`](../server/src/services/audit/auditLog.ts).
Writes are **best-effort**: a failure is logged and swallowed so it never fails a
user action that already succeeded. Rows are always scoped to `userId`, and
**no sensitive payloads or tokens are stored** in metadata.

Covered events:

- `task_created`, task updates/moves/deletes (`services/tasks/*`),
- reminder delivery/failure (`services/reminders/engine.ts`),
- follow-up sends and responses (`services/followup/*`),
- `notion_connected` / `notion_disconnected` (OAuth callback / disconnect),
- `notion_database_selected` (purpose/default mapping change),
- `sync_performed` (counts only) plus per-page `sync_*` events.

---

## 13. Cross-user isolation guarantees

For every user-scoped resource the server guarantees that a caller can only ever
observe or change their **own** rows:

- the identity is derived from the verified token only;
- every read/write is filtered by `user_id`;
- a foreign id yields `404`/empty (indistinguishable from missing), never the
  other user's data or a `200` with their payload;
- Notion access is scoped to the caller's own encrypted connection, so a user
  without a connection receives `409` and can never read another user's Notion
  databases or schemas.

These guarantees are asserted end-to-end in
[`tests/server/crossUserIsolation.test.ts`](../tests/server/crossUserIsolation.test.ts)
for tasks, task-by-id, reminders, reminder cancel, conversations/messages,
notifications (list / unread-count / mark-read), the Notion connection,
databases, mappings, schema, sync, and sync status.
