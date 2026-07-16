# Travel Agency AI Receptionist

A Facebook/Instagram Messenger AI receptionist for travel agencies. It answers
customer DMs using the agency's own trip and price data, captures booking leads, and
lets staff pause the bot per-conversation from an admin panel.

Deployed for Uudam, serving multiple Facebook pages from one deployment — each
page replies with its own token and can be paused independently from the admin
panel.

## What it does

- **Answers DMs** on Messenger/Instagram via a Meta webhook, using OpenAI grounded
  in the agency's trip data (Neon Postgres, editable from the admin panel).
- **Captures leads** when a customer shows booking intent.
- **Staff pause** — agents can take over a conversation and pause the bot.
- **Ingests price lists** — staff paste or upload price files (PDF/Excel) or link a
  Google Drive folder; the AI extracts clean structured data.
- **Production-hardened** — webhook signature verification, payload size limits,
  rate limiting, replay protection, circuit-breaker + retry on external calls,
  observability sinks, and a preflight that blocks broken deploys.

## Tech stack

Next.js (Pages API routes) · React 19 · TypeScript · Neon Postgres · Upstash Redis
(optional) · OpenAI · Tailwind v4. Deployed on Vercel.

## Quick start (local)

```bash
cp .env.example .env.local   # fill in the required vars (see below)
npm install
npm run dev                  # http://localhost:3004
```

### Minimum env vars

`OPENAI_API_KEY`, `VERIFY_TOKEN`, `FACEBOOK_PAGES` (one or more `pageId:token`
pairs, comma-separated), `META_APP_SECRET`, `ADMIN_SECRET`, `NEON_DATABASE_URL`.
Everything else has safe defaults — see [.env.example](.env.example). Redis is
optional locally; configure `REDIS_URL` **or** the
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` pair for production.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server on port 3004 |
| `npm run validate` | lint + typecheck + tests + build (run before deploying) |
| `npm test` | Test suite (Node's built-in test runner) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build (runs preflight config check first) |

## Key routes

- `POST /api/webhook` — Meta webhook (messages in, replies out)
- `GET /api/ping` — health check
- `GET /api/metrics` — operational metrics
- `/api/admin/*` — admin panel APIs (trips, leads, settings, file parsing)

## Project layout

```
src/lib/        core logic (webhook, OpenAI, redis, db, resilience, observability)
src/pages/api/  HTTP routes (webhook, admin, metrics, ping)
src/components/ admin UI + demo chat
tests/          70+ tests (env, webhook security/replay, rate limit, parsing, ...)
supabase/       SQL migrations
```
