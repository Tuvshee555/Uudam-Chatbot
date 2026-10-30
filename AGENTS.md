# Project Instructions

## Git Delivery Preference

- When Codex completes a requested code change in this repository, it should normally finish by committing and pushing its own change set to the current branch after verification passes.
- Do not include unrelated dirty worktree changes in the commit or push.
- If the worktree contains unrelated changes, stage only the files Codex intentionally changed for the current task.
- If pushing is not possible because of authentication, branch state, remote configuration, failing checks, or unclear ownership of changes, state the blocker clearly instead of pretending it was pushed.
- If the user explicitly says not to commit or push for a task, follow the user's latest instruction.

## Verification

- Before reporting a change as done, run the relevant checks for the scope of the change.
- Prefer `npm run typecheck`, targeted tests, full tests, and production build when the change touches bot routing, payments, customer documents, webhook behavior, or admin UI.

## Conversation-level regression (owner's standard, mandatory)

Reliability and the real customer experience come before any single fix. Unit tests alone are not
evidence that the chatbot works.

- Every change to replies, routing, trip matching, pricing, dates, booking, leads or the webhook must keep
  `npm run qa:conversations` green. It runs the customer-journey suites
  (`tests/conversation-journeys.test.ts`, `tests/forensic-regressions.test.ts`, and others) in CI and in the
  Vercel prebuild, so a broken journey cannot deploy.
- A fix for a conversation failure adds or extends a journey reproducing that conversation's shape
  (invented trips only), and that journey must fail without the fix.
- Before merging such a change, run `npm run qa:live` (live catalogue read-only, real model, nothing sent).
  It must report 0 fact issues; read every changed reply. The owner allows it on the normal OpenAI key
  (2026-10-30); it stays opted in and capped (below).

## AI spend safeguards (owner's, non-negotiable)

- Routine tests never call a model: `scripts/run-tests.mjs` strips every provider key and runs with a mock.
- Every script that spends model credit (`qa:live`, golden questions, catalogue demo, real-conversation
  replay, mimic scoring) goes through `scripts/lib/evalGuard.mjs`. It uses the normal `OPENAI_API_KEY`
  (or an optional `EVAL_OPENAI_API_KEY`) and refuses unless `EVAL_RUN_APPROVED=1` is set for the run, the
  target is not the production site, and no other evaluation run is going. It prints the estimated calls
  and cost first. `EVAL_MAX_MODEL_CALLS` (default 150) is a hard stop. The owner allows reasonable test
  runs on the existing credit without asking each time; never loop runs or remove the cap.
- The GitHub "Live replay" workflow is manual only and needs `approve: yes`.
- Model spend is recorded per day, environment, model and source in `travel_ai_usage` (admin System
  page). `AI_DAILY_BUDGET_USD` (default 20) raises a critical issue when production spend passes it.
- When the model fails on Messenger, the customer gets one short Mongolian notice
  (`AI_OUTAGE_HANDOFF_REPLY`) after the staff lead, never silence and never repeated within 30 minutes.
  Billing and key failures alert staff at once; rate-limit and provider failures alert once they persist.
- Never weaken or delete a journey assertion to make a change pass. If an expectation must change, say
  why in the commit message.
- When measuring real behaviour from `travel_conversations`, exclude `demo:` senders (test sessions,
  87% of rows as of 2026-10-30).
- Known open failures stay visible as `test.todo` and in `docs/chatbot-followups.md`; never report the
  chatbot as fully reliable while one is open.

## Admin Appearance

- Keep the admin interface in the user's white/light theme, including the desktop sidebar, mobile navigation, login, and content.
- Preserve that theme when improving layouts unless the user explicitly requests another theme.

## Bot answer rules (owner's, non-negotiable)

- No data, no answer: if the trip data does not hold the answer, the bot sends nothing and staff get a hand-off lead. Never a guessed trip, a vague-word mapping, or a polite deflection presented as an answer.
- Every customer-facing reply must leave through `deliverFastPathReply` (or the model path) in `src/pages/api/webhook.ts`, where `tripGrounding.ts` holds back a one-trip reply about a trip the conversation never pointed to. Do not add a branch that sends around it.
- Before pushing any change to trip matching, routing or reply wording, run `npm run gate` (read-only, no AI calls) and read every changed decision it prints. `npm run gate -- --save` only after the changes are judged correct.
- Never write a real trip, place, price or date into code, comments, tests or scripts; use invented names.
- Several agents have edited this repo at the same time and fixed the same bug twice. Pull first, check `git log`, and stage only your own files.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
