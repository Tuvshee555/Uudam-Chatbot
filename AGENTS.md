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
