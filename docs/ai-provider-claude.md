# The bot on Claude (Anthropic): one switch

Owner, 2026-11-22: "make it only use the Anthropic key ... use Haiku on the simple ones". The
admin assistant has run on Claude Sonnet 5.5 since 2026-11-22 (`ASSISTANT_PROVIDER=anthropic`,
`src/lib/assistantAgent/anthropicTools.ts`). This switch moves **every other AI call** too:
customer replies, which-trip understanding, chat memory, new-trip files, price photos, customer
documents (images and PDFs), photo queries and ranking, the daily health ping.

## Switch

| Variable | Value | Meaning |
|---|---|---|
| `AI_PROVIDER` | `anthropic` | Claude answers every bot AI call. Remove it to go back to OpenAI. |
| `ANTHROPIC_API_KEY` | the key | Required. Without it the bot stays on OpenAI. |
| `AI_OPENAI_BACKUP` | `off` | Optional. By default OpenAI answers when a Claude call fails (credit out, outage) as long as `OPENAI_API_KEY` exists. `off` = Claude only. |
| `AI_CLAUDE_SMART_MODEL` | `claude-sonnet-5-5` | Optional override of the smart model. |
| `AI_CLAUDE_FAST_MODEL` | `claude-haiku-5-5` | Optional override of the fast model. |
| `AI_CLAUDE_EFFORT` / `AI_CLAUDE_CAREFUL_EFFORT` | `low`…`max` | Optional. Default `medium` (Haiku `low`). |

With `AI_PROVIDER=anthropic` and the Anthropic key set, `OPENAI_API_KEY` is no longer required.
Removing it also removes the backup.

## Which model does what

The code still names the OpenAI model each call was tuned for. `src/lib/anthropicChat.ts` maps it:

- **Claude Haiku 5.5**: the calls that ran on `gpt-4o-mini` / `gpt-4.1-nano`, the simple ones
  (photo search words, photo ranking, the health ping, chat memory notes, category labels).
- **Claude Sonnet 5.5**: everything else (customer replies, trip understanding, customer images
  and PDFs, new-trip files, price tables).

Customer steps answer at once with no thinking, so they reply about as fast as the OpenAI models.
Admin file work (`travel.ops.*`, price tables, file text) thinks first.
When Sonnet is overloaded or rate-limited, Haiku answers instead of nobody.

## What stays the same

- Every call still goes through `askOpenAIChatParts` (`src/lib/openaiFallback.ts`), which hands it
  to Claude first. No caller changed.
- A declined or empty reply is `REFER`: no answer to the customer, and staff get a lead.
- Spend is recorded per model in `travel_ai_usage` (admin System page).
- Claude failures show on the System page as "Claude (Anthropic)" with the console link.

## Checks before flipping production

1. Free: `npm test` (`tests/ai-claude-provider.test.ts`), `npm run qa:conversations`.
2. One paid run on Claude:
   `AI_PROVIDER=anthropic AI_OPENAI_BACKUP=off EVAL_RUN_APPROVED=1 npm run qa:live`.
   It must report 0 fact issues. Compare it with the last OpenAI report.
3. Add `AI_PROVIDER=anthropic` in Vercel (production) and redeploy. To revert, remove it and redeploy.
