# AI Virtual Task Assistant

A full-stack, AI-powered personal task assistant. You talk to it in plain
language; it understands the intent, asks for anything it is missing, previews
the task, and — only after you confirm — creates and keeps it in sync with your
own **Notion** workspace while running reminders and proactive follow-ups from a
**Supabase**-backed automation layer.

> **Status: feature-complete.** All 19 build phases are implemented and the test
> suite is green (64 suites / 564 tests). Live end-to-end use requires you to
> configure Supabase, an OpenAI-compatible AI provider, and a Notion
> integration — see [Quick Start](#quick-start) and
> [`docs/deployment.md`](docs/deployment.md). See
> [Known limitations](#known-limitations) for the honest caveats.

---

## The product flow

The assistant is **confirm-only**: it never creates, edits, or deletes anything
in Notion without an explicit confirmation. A typical "case report" conversation:

```text
You:        I need to finish the case report.

Assistant:  Sure — when is it due, and should this go under Work or School?
            (missing-information rule: it asks instead of guessing)

You:        It's due this Friday, it's for the Johnson case — work.

Assistant:  Here's the task I'll create:
            ┌───────────────────────────────────────────────┐
            │ Write case report                              │
            │ Due: Fri 2026-10-09 · Priority: medium         │
            │ Database: Work Tasks                           │
            │ [ Create ]  [ Edit ]  [ Cancel ]               │
            └───────────────────────────────────────────────┘

You:        (click Create)

Assistant:  ✓ Task created — Write case report
            Due: 2026-10-09 · Database: Work Tasks · Reminder: 1 day before
            View in Notion ↗
```

From there the system keeps working in the background:

1. **Reminder** — the reminder scheduler fires the in-app reminder at the
   scheduled time (a notification-center row plus a proactive assistant message).
2. **Follow-up** — ahead of the deadline (and on overdue tasks) the follow-up
   engine asks how it's going and offers one-tap actions
   (`in_progress` / `blocked` / `completed` / `move deadline`).
3. **Deadline move** — "I need a bit more time" moves the deadline; the change is
   applied to Notion **and** the local mirror, and a `task_updated` audit row is
   written.
4. **Sync** — the synchronization engine reconciles Notion ↔ local in both
   directions (manual `POST /api/sync` or an opt-in periodic worker).

The end-to-end scenario (message → clarify → create → reminder → follow-up →
deadline move) is described and verified in
[Automated acceptance walkthrough](#automated-acceptance-walkthrough).

---

## Architecture at a glance

```text
┌───────────────────────────────┐        ┌──────────────────────────────────┐
│  Client (SPA)                 │        │  API server (Express + Zod)      │
│  React 18 · Vite · Tailwind   │        │  TypeScript · server-only secrets│
│  Assistant chat · Dashboard   │        │                                  │
│  Tasks · Reminders · Settings │        │  routes → controllers → services │
└──────────────┬────────────────┘        └───────┬───────────────┬──────────┘
               │  HTTPS · Authorization: Bearer   │               │
               │  (Supabase session token)        │               │
               ▼                                  ▼               ▼
        ┌─────────────┐                 ┌────────────────┐  ┌──────────────┐
        │  Supabase   │                 │  AI provider   │  │    Notion    │
        │  Auth + DB  │                 │ (OpenAI-compat)│  │  OAuth + API │
        │  (RLS)      │                 └────────────────┘  └──────────────┘
        └─────────────┘
```

- **Client / server split.** The SPA talks only to the API. It never holds the
  service-role key, the encryption key, the AI key, or a Notion token.
- **Identity is server-owned.** The acting user id always comes from the verified
  Bearer token (`req.user.id`), never a request body. Every repository query is
  additionally filtered by `user_id` (defense-in-depth over Supabase RLS).
- **Supabase is the automation layer, not the source of truth.** Notion remains
  the canonical workspace; `assistant_tasks` is a local **mirror** used for
  scheduling, dashboards, and offline-ish queries, reconciled by the sync engine.
- **Confirm-only mutations.** The model can only produce preview/select/update
  cards. All writes flow through one explicit endpoint, `POST /api/assistant/actions`.

Background workers (all optional and guarded by configuration):

| Worker                | Enabled by                              | Requires          |
| --------------------- | --------------------------------------- | ----------------- |
| Reminder scheduler    | `REMINDERS_ENABLED=true` (default)      | Supabase          |
| Follow-up scheduler   | `FOLLOW_UP_ENABLED=true` (default)      | Supabase          |
| Notion sync scheduler | `SYNC_ENABLED=true` (default **false**) | Supabase + Notion |

They are started by [`server/src/index.ts`](server/src/index.ts:1) and stopped on
`SIGTERM`/`SIGINT`. See [`docs/architecture.md`](docs/architecture.md).

---

## Tech stack

| Layer           | Technology                                                   |
| --------------- | ------------------------------------------------------------ |
| Frontend        | React 18, Vite 5, React Router 6, Tailwind CSS 3, TypeScript |
| Backend         | Node.js 18+, Express 4, TypeScript, Zod, dotenv              |
| Database & Auth | Supabase (PostgreSQL + Auth + Row Level Security)            |
| AI              | Any OpenAI-compatible chat-completions provider (JSON mode)  |
| Integration     | Notion OAuth 2.0 + REST API (`Notion-Version: 2022-06-28`)   |
| Testing         | Jest 29, ts-jest, Supertest, React Testing Library (jsdom)   |
| Tooling         | ESLint 8, Prettier 3, tsx, npm workspaces                    |

---

## Prerequisites

- **Node.js ≥ 18** (developed/verified on Node 24) and npm.
- A **Supabase** project (URL + anon key + service-role key).
- An **OpenAI-compatible** AI provider (API key + model id).
- A **Notion** public integration (client id/secret) — for Notion features.
- Migrations are plain SQL (Supabase SQL editor or the Supabase CLI).

---

## Quick Start

```bash
# 1. Clone and enter the repository
git clone <your-repo-url> "Task Management System"
cd "Task Management System"

# 2. Install all workspaces
npm install

# 3. Configure the environment
cp .env.example .env
#    Fill in Supabase, AI, and Notion values. Every variable is documented in
#    .env.example and docs/deployment.md.

# 4. Apply the database migrations
#    Run database/migrations/0001…0011 *in order* in the Supabase SQL editor,
#    or with the Supabase CLI (see docs/deployment.md → Supabase setup).

# 5. Run the app in development (API + SPA together)
npm run dev
#    API   → http://localhost:4000
#    SPA   → http://localhost:5173   (Vite proxies /api to the API)

# 6. Run the tests
npm test
```

### Production-style run

```bash
npm run build           # server tsc + client vite build
NODE_ENV=production npm start   # serves the compiled API from server/dist
```

The SPA build output is `client/dist/` (static assets for a CDN/host); the API is
`server/dist/`. Container images are available via
[`server/Dockerfile`](server/Dockerfile:1). See
[`docs/deployment.md`](docs/deployment.md).

---

## npm scripts

| Script                                        | Description                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run dev`                                 | Run the API and SPA concurrently (server `tsx watch` + Vite).          |
| `npm run build`                               | Build **both** workspaces (`server` → `tsc`, `client` → `vite build`). |
| `npm start` / `npm run start:server`          | Run the compiled API (`node server/dist/index.js`).                    |
| `npm run preview:client`                      | Preview the built SPA locally (`vite preview`).                        |
| `npm test`                                    | All Jest suites (server + client), no coverage.                        |
| `npm run test:server` / `npm run test:client` | One Jest project.                                                      |
| `npm run test:coverage`                       | Both projects **with coverage + thresholds**.                          |
| `npm run test:coverage:server` / `:client`    | Per-project coverage.                                                  |
| `npm run test:watch`                          | Jest watch mode.                                                       |
| `npm run lint` / `npm run lint:fix`           | ESLint (`--max-warnings 0`).                                           |
| `npm run format` / `npm run format:check`     | Prettier.                                                              |

Workspace-level scripts (`npm run build -w server`, `npm run dev -w client`, …)
are also available.

---

## Configuration

All configuration lives in a single **repository-root** `.env` file (git-ignored),
copied from [`.env.example`](.env.example:1). The server validates it at boot with
Zod: in **production** a missing required variable exits the process; in
development/test it warns and applies safe defaults. The browser bundle only
receives the `VITE_*` Supabase values.

The full, grouped reference (core, Supabase, AI, Notion, encryption, reminders,
follow-ups, sync, rate limits, CORS, frontend) is in
[`docs/deployment.md`](docs/deployment.md). Highlights:

| Group      | Variables                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Core       | `NODE_ENV`, `PORT`, `API_URL`, `APP_URL`                                                                                   |
| Supabase   | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`                                                           |
| AI         | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`                                                                     |
| Notion     | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI`                                                          |
| Encryption | `ENCRYPTION_KEY` (≥ 32 chars; encrypts Notion tokens, signs OAuth state)                                                   |
| Reminders  | `REMINDERS_ENABLED`, `REMINDER_TICK_MS`                                                                                    |
| Follow-ups | `FOLLOW_UP_ENABLED`, `FOLLOW_UP_TICK_MS`, `FOLLOW_UP_LEAD_HOURS`, `FOLLOW_UP_MIN_INTERVAL_HOURS`, `FOLLOW_UP_MAX_PER_TASK` |
| Sync       | `SYNC_ENABLED`, `SYNC_TICK_MS`, `SYNC_MIN_INTERVAL_MS`                                                                     |
| Hardening  | `CORS_ORIGIN`, `TRUST_PROXY`, `RATE_LIMIT_*`                                                                               |
| Frontend   | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`                                                                              |

Never commit `.env`. `.gitignore` excludes `.env`, `.env.*` (except
`.env.example`), `coverage/`, `dist/`, logs, and OS files.

---

## Testing

Hermetic: no live network and no live database. Only the edges are mocked (AI
HTTP, Notion `fetch`, Supabase, the browser Supabase client, timers).

```bash
npm test               # 64 suites / 564 tests
npm run test:coverage  # both projects; thresholds enforced per project
```

| Project   | Suites | Tests   | Coverage (statements / branches / functions / lines) |
| --------- | ------ | ------- | ---------------------------------------------------- |
| Server    | 51     | 513     | 80.53% / 64.78% / 67.82% / 82.30%                    |
| Client    | 13     | 51      | 70.91% / 54.22% / 63.10% / 73.73%                    |
| **Total** | **64** | **564** | merged 78.15% / 62.06% / 66.21% / 80.17%             |

Coverage thresholds are 78/62/65/80 (server) and 68/52/60/71 (client) and are
enforced only during a coverage run. The full strategy, the required-item
coverage map, and the flagship end-to-end suite are documented in
[`docs/testing.md`](docs/testing.md).

### Automated acceptance walkthrough

The end-to-end product scenario is exercised by
[`tests/server/assistantFlow.test.ts`](tests/server/assistantFlow.test.ts:1)
(real controllers/extractors/orchestrators over the Supabase fake and a routed
Notion `fetch`):

| Step                                                                    | Automated test coverage                                   | Needs live credentials? |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------- |
| Message → under-specified → **clarify** (no card, no writes)            | `assistantFlow`, `assistantRoute`, `aiExtraction`         | No                      |
| Message → complete `create_task` → **preview card** + resolved database | `assistantFlow`, `assistantRoute`                         | No                      |
| **Confirm** → Notion page + local mirror + pending reminder + audit     | `assistantFlow`, `createTask`, `assistantActionsRoute`    | Notion calls stubbed    |
| **Reminder delivery** (claim → dispatch → sent → audit, idempotent)     | `reminderEngine`, `inAppChannel`                          | No                      |
| **Follow-up** engine (candidates, send, response handling)              | `followUpCandidates`, `followUpEngine`, `followUpRespond` | No                      |
| **Deadline move** (create replacement → archive → mirror update)        | `updateTask`, `assistantFlow`                             | Notion calls stubbed    |
| **Sync** pull/push/watermark/loop-prevention                            | `syncEngine`, `syncRoute`                                 | Notion calls stubbed    |

So the logic is covered end-to-end against fakes. **Live end-to-end requires you
to configure Supabase, an AI provider, and a Notion integration** (with the
databases shared to the integration) — the automated tests deliberately never
touch a real provider, database, or workspace.

---

## Deployment

Summary (full checklist in [`docs/deployment.md`](docs/deployment.md)):

- Build both workspaces (`npm run build`); serve `client/dist` from a static host
  / CDN and run the API from `server/dist` (Node host or the provided Docker
  image) behind TLS.
- Set `NODE_ENV=production` and every required variable; the process refuses to
  boot if one is missing.
- Health probes: `GET /health` (liveness, always `200`) and `GET /health/ready`
  (readiness — `200` when Supabase is configured, `503` otherwise; reports
  dependency **booleans only**, never secrets).
- Set `CORS_ORIGIN` to the deployed SPA origin(s) and `TRUST_PROXY` to match your
  proxy topology.
- Run background workers in **exactly one** instance (or add a distributed lock) —
  see the single-instance scheduler caveat below.

---

## Project structure

```text
.
├── client/     # React + Vite + Tailwind SPA
│   └── src/{pages,components,services,hooks,layouts}
├── server/     # Express API (routes → controllers → services)
│   └── src/{routes,controllers,services,middleware,validators,config,utils}
│       └── Dockerfile
├── database/   # SQL migrations 0001–0011 (schema + RLS)
├── tests/      # Jest projects: tests/server, tests/client
├── docs/       # architecture, database-schema, assistant, ai-tools,
│               # notion-integration, reminders, notifications, security,
│               # deployment, testing
├── .env.example
├── docker-compose.yml
└── package.json (npm workspaces: client, server)
```

---

## Known limitations

- **Non–in-app notification channels are not implemented.** Only the `in_app`
  channel is real; `email`, `push`, `sms`, `whatsapp`, and `telegram` are
  registered as disabled placeholders (the registry is intentionally _total_).
  Adding one is a drop-in `NotificationChannel` — see
  [`docs/notifications.md`](docs/notifications.md).
- **Per-user settings are pending (Phase 24 items).** Follow-up lead/interval/cap
  are global env defaults today; per-user overrides are not yet wired.
- **Schedulers assume a single instance.** Reminder/follow-up claiming is
  idempotent (atomic `pending` → `sent`), but the background tickers are
  process-local. Running multiple API replicas can duplicate work and breaks the
  OAuth single-use state store; run the workers in one worker — or add a
  distributed lock / shared store — for horizontal scale.
- **Readiness is configuration-based, not a live dependency ping.**
  `GET /health/ready` reports whether dependencies are _configured_; it does not
  call Supabase/AI/Notion. It is cheap and safe to probe on every request.
- **Notion status options cannot be created implicitly.** If a mapped database
  has no matching status option, the status is updated in the local mirror only,
  with a warning (Notion pages retain their prior status).
- **AI extraction is non-deterministic.** Prompt-injection defenses reduce risk
  but cannot make a model provably safe; the authorization boundary (confirm-only
  mutations, strict per-user scoping) is what makes a bad model output
  non-catastrophic. See [`docs/security.md`](docs/security.md).

---

## Built in phases

The project was built incrementally across 19 phases, each documented and tested:

| Phase | Scope                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Monorepo foundation, tooling, CI-shaped scripts                                                                                 |
| 2     | Responsive app shell, routing, design system                                                                                    |
| 3–4   | Supabase Auth and user profiles                                                                                                 |
| 5–6   | Assistant chat UI + AI intent extraction (Zod, missing-info, injection hardening)                                               |
| 7     | Full Supabase schema, RLS, local task mirror (migrations 0001–0011)                                                             |
| 7–9   | Notion OAuth (signed single-use state, AES-256-GCM tokens), database discovery + purposes, schema inspection + property mapping |
| 10–11 | Task create / update / complete / cancel / delete / move                                                                        |
| 12    | Dashboard + tasks page (timezone-aware buckets)                                                                                 |
| 13    | Reminder engine (scheduler, idempotent claiming, recurrence)                                                                    |
| 14    | Notification system (channel abstraction, in-app, notification center)                                                          |
| 15    | Follow-up engine (schedulers, anti-spam, one-tap responses)                                                                     |
| 16    | Synchronization (pull/push, watermark, loop prevention)                                                                         |
| 17    | Security hardening (rate limits, Helmet, CORS, cross-user isolation)                                                            |
| 18    | Test sweep + coverage thresholds                                                                                                |
| 19    | Production preparation + full documentation (this phase)                                                                        |

Deeper reading: [`docs/architecture.md`](docs/architecture.md) ·
[`docs/assistant.md`](docs/assistant.md) ·
[`docs/database-schema.md`](docs/database-schema.md) ·
[`docs/notion-integration.md`](docs/notion-integration.md) ·
[`docs/reminders.md`](docs/reminders.md) ·
[`docs/notifications.md`](docs/notifications.md) ·
[`docs/security.md`](docs/security.md) ·
[`docs/ai-tools.md`](docs/ai-tools.md) ·
[`docs/testing.md`](docs/testing.md) ·
[`docs/deployment.md`](docs/deployment.md).
