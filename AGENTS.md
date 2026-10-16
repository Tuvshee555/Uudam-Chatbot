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

## Bot answer rules (owner's, non-negotiable)

- No data, no answer: if the trip data does not hold the answer, the bot sends nothing and staff get a hand-off lead. Never a guessed trip, a vague-word mapping, or a polite deflection presented as an answer.
- Every customer-facing reply must leave through `deliverFastPathReply` (or the model path) in `src/pages/api/webhook.ts`, where `tripGrounding.ts` holds back a one-trip reply about a trip the conversation never pointed to. Do not add a branch that sends around it.
- Before pushing any change to trip matching, routing or reply wording, run `npm run gate` (read-only, no AI calls) and read every changed decision it prints. `npm run gate -- --save` only after the changes are judged correct.
- Never write a real trip, place, price or date into code, comments, tests or scripts; use invented names.
- Several agents have edited this repo at the same time and fixed the same bug twice. Pull first, check `git log`, and stage only your own files.
