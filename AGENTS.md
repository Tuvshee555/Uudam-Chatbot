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

## Admin Appearance

- Keep the admin interface in the user's white/light theme, including the desktop sidebar, mobile navigation, login, and content.
- Preserve that theme when improving layouts unless the user explicitly requests another theme.

## Bot answer rules (owner's, non-negotiable)

- No data, no answer: if the trip data does not hold the answer, the bot sends nothing and staff get a hand-off lead. Never a guessed trip, a vague-word mapping, or a polite deflection presented as an answer.
- Every customer-facing reply must leave through `deliverFastPathReply` (or the model path) in `src/pages/api/webhook.ts`, where `tripGrounding.ts` holds back a one-trip reply about a trip the conversation never pointed to. Do not add a branch that sends around it.
- Before pushing any change to trip matching, routing or reply wording, run `npm run gate` (read-only, no AI calls) and read every changed decision it prints. `npm run gate -- --save` only after the changes are judged correct.
- Never write a real trip, place, price or date into code, comments, tests or scripts; use invented names.
- Customer trip conversations are led by `src/lib/conversationalAgent.ts`: one short message (≤ 420 characters), at most one question, asking about the customer's plan instead of listing the catalog. Fix tone, length or flow problems in its rules and examples — do not add another keyword fast path or reply template for them. The keyword paths in `webhook.ts` are the fallback for when the model is unavailable (or `CONVERSATIONAL_AGENT=off` / bot settings `extra.conversational_agent: false`).
- Several agents have edited this repo at the same time and fixed the same bug twice. Pull first, check `git log`, and stage only your own files.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
