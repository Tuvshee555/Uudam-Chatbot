# Chatbot accuracy and API cost — delivery report (2026-11-02)

Branch `work/chatbot-accuracy-cost`, five commits on top of `85c5e7b` (main):
`9f4e0d2` (evaluation harness, audit, accuracy fixes), `0c879ed` (cost), `2aa48ad` (held-out
findings, model choice), `2763241` (a gpt-4.1-mini regression found by the live replay), and
this report. **Not pushed, merged or deployed** — as the brief required. Nothing was
written to production data; every database read was read-only.

How results were measured:

- **Evaluation harness** (`npm run eval:chatbot`): the real webhook handler over an invented
  catalogue of 12 trips (`tests/eval/catalogue.ts`), with the real OpenAI models ("live") or with
  every model call refused ("rules", which is also a full provider-outage test). Each turn is
  scored on hard rules (no amount, departure date or phone number the catalogue does not hold; no
  leaked control token; silence only with a staff lead) and on the case's expectations.
- **Dev set** (`tests/eval/dev.cases.ts`, 131 turns): used to find and fix problems.
- **Held-out set** (`tests/eval/heldout.cases.ts`, 112 turns, 93 conversations): written before
  it was ever run, run once per model configuration on the frozen engine (the "blind" results),
  then used to find more problems — results after those fixes are reported separately because
  the set is no longer blind for them.
- **Live catalogue** (read-only snapshot): prompt sizes counted with the o200k tokenizer, the
  replay gate (`npm run gate`) and the live replay (`npm run qa:live`).
- **Production spend before**: `travel_ai_usage` (environment `production`), measured in the audit.

Costs are list-price estimates. Evaluation spend is separate from production spend: all live
evaluation and replay runs together cost about **$1.95** (≈1,860 model calls) and were never
recorded as production.

## 1. Initial architecture assessment

Detailed in `docs/chatbot-cost-accuracy-audit-2026-11-02.md`. In short: a layered webhook
(greetings and hand-over keywords → contact → booking flow → trip routing with a model-based
"understanding" step → a deterministic answer planner → catalogue/date/program fast paths → a
free-text model reply as the last resort), with code checks on every reply before it is sent.
Of 142 bot-handled text turns in the 7 days measured, 54% were answered deterministically, 18% by
the free-text model, 19% went silent with a staff lead (no data).

Production spend was ≈ **$1.05/day** (≈ $0.030 per handled turn): the free-text reply on gpt-4o
70% ($0.08 per call, 31,605 input tokens), the understanding call on gpt-4.1 27% ($0.011 per call,
5,373 input tokens), everything else 3%.

## 2. Strengths preserved

Deterministic answers first; every reply checked against the catalogue at the exit
(`deliverFastPathReply`, `verifyTripReply`, price/date/wrong-trip guards); "no data → silence and
a staff lead"; payments never confirmed; staff takeover detection; signed webhooks, dedup,
retries, rate limits, circuit breaker, outage notice; spend ledger with a daily budget alert;
opt-in capped evaluations. None of these was removed or weakened. Every existing journey still
passes; three test inputs changed (section 13), with reasons in the commit messages.

## 3. Problems discovered

From the audit and the first evaluation runs on the original engine:

| Problem | Effect |
|---|---|
| Two trip descriptions contain line breaks; the catalogue summariser is line-based | ~19,000 tokens of full trip detail on every reply call; nine named trips sent the whole 38,000-token catalogue |
| Rules and catalogue interleaved with per-message lines | provider prompt cache could not reuse the prompt |
| Understanding model (gpt-4.1) called on nearly every message | 27% of spend, also for messages code could settle |
| Latin-typed Mongolian gaps | "hun bnu", "ymar aylal bga we", "kaldor viz heregtei yu", "uridchilgaa", "huuhed hed" … went to the model or silence |
| Typed phone/address questions | only two button phrasings answered; the rest went silent |
| "за ok", "бодож үзье" | sent to the model; a REFER paged staff for an "ok" |
| Wrong or missing facts | a 1-year-old quoted the child fare; a sold-out date answered as "no trip then"; weekly trips silent; per-hotel fares hidden behind a date question; "2 хүн" not counted |
| Model over-reach | the understanding model filed answerable questions (visa, passport, hotel) as "unsupported", invented packages and topics, and once returned list position "1" as catalogue key "T1" (a different trip) |
| Budget answers | the "2 саяд багтах" list was always withheld (heading read as an invented fare); "1.5 сая" was read as 5 million |

## 4. Changes implemented

**Accuracy and language** (each with a journey that fails without it):
hand-over phrasings in both scripts (and the understanding step's "human" reading); typed
phone/address questions; acknowledgements and deferrals answered in one line; ~25 Latin spelling
bridges for question and term words; sold-out dates; weekly schedules and fares; per-hotel fares
and hotel names without stars; infant fare by age; "N хүн" as adults (10+ as a staff-handled
group checked against seats left); picks by quality or way of travel under a list; bargaining
answered with the real fare and the discount data; inclusions ("юу багтдаг", "тусдаа", an item
of the trip's own list), breakfast as food, cancellation and balance-payment questions; one
programme day ("3 дахь өдөр"); trip names typed in Latin removed before reading intent; cheapest,
family and Latin catalogue questions; budget lists; hotel distance, facilities with suffixes and
flight hours handed to staff; model readings checked by code (whole-question "unsupported" flags,
property-less hotel flags, model-only topics, invented packages, list position as key).

**Cost:** one line per trip in the catalogue; an index of every trip (next six departures) plus
at most four focused trips in their own section, price tables cut at a row with a "REFER for a date
not shown" marker; stable rules and catalogue first, per-message parts last (cacheable prefix);
understanding skipped for a trip's full name, a pick that fits one offered trip, and a generic
follow-up on the selected trip; four instead of eight departures per trip in the understanding
prompt; understanding moved to gpt-4.1-mini; reply output capped at 1,000 tokens.

**Spend accounting:** cached input billed at the provider's discounted share in the estimator
(production ledger and evaluations); model names from the environment checked against known
models (a typo falls back to the default with a warning).

## 5. Files changed

`src/lib/`: `acknowledgements.ts` (new), `modelConfig.ts` (new), `aiTripContext.ts`, `aiUsage.ts`,
`businessData.ts`, `catalogListing.ts`, `chatbotReplyPolicy.ts`, `contactReplies.ts`,
`conversation.ts`, `customerTurn.ts`, `fastPathRouting.ts`, `greetingPhrases.ts`,
`handoffDetection.ts`, `openaiFallback.ts`, `reply.ts`, `requestedFacts.ts`, `travelFastPaths.ts`,
`travelFastPathsPricing.ts`, `travelTextNorm.ts`, `tripAnswerPlan.ts`, `tripPlaceDaysReply.ts`,
`tripRequest.ts`, `tripUnderstanding.ts`, `tripUnderstandingModel.ts`.
`src/pages/api/`: `webhook.ts`, `demo.ts`.
Scripts: `scripts/chatbot-eval.ts` (new), `scripts/conversation-gate.mjs`, `package.json`
(`eval:chatbot`).
Tests: `tests/accuracy-cost-journeys.test.ts` (new, in `qa:conversations`),
`tests/accuracy-cost-units.test.ts` (new), `tests/eval/{catalogue,dev.cases,heldout.cases}.ts`
(new), `tests/helpers/conversationGateHarness.ts`, `tests/ai-trip-context.test.ts`,
`tests/human-takeover-journeys.test.ts`, `tests/webhook-conversations.test.ts`.
Docs: this report, `docs/chatbot-cost-accuracy-audit-2026-11-02.md`, `docs/chatbot-followups.md`.

## 6. Factual accuracy

Hard rules (no amount, departure date or phone number outside the catalogue; no leaked token;
silence only with a lead) held on **every turn of every live and no-model run** after the first:
131/131 dev, 112/112 held-out in all four blind configurations and after the fixes. On the
original engine the dev set had 1 hard-rule failure in 118 turns.

This measures invented figures, not every possible wrong statement; case expectations cover
the rest (right trip, right fare tier, the asked fact present, silence where data is missing).

## 7. Mongolian language results (turns correct)

| Run | Cyrillic | Latin | Mixed | English |
|---|---|---|---|---|
| Dev, original engine, live | 52/66 | 31/47 | — | 4/5 |
| Dev (same 118 turns), final engine, live | 66/66 | 47/47 | — | 5/5 |
| Held-out blind, gpt-4.1 (A) | 74/82 | 20/22 | 4/5 | 3/3 |
| Held-out blind, gpt-4.1-mini (B) | 75/82 | 20/22 | 5/5 | 3/3 |
| Held-out after fixes, final engine | 81/82 | 22/22 | 5/5 | 3/3 |

## 8. Held-out results

Blind (the frozen engine of `0c879ed`, each configuration run once):

| Understanding / reply model | Correct | Unsupported claims | Follow-up turns | Safe fallback | Intent | $/turn |
|---|---|---|---|---|---|---|
| none (provider outage) | 97/112 (86.6%) | 0/105 | 14/19 | 3/5 | 25/28 | 0 |
| gpt-4.1 / gpt-4o (old defaults) | 101/112 (90.2%) | 0/100 | 19/19 | 3/5 | 26/28 | $0.00202 |
| gpt-4.1-mini / gpt-4o | 103/112 (92.0%) | 0/103 | 18/19 | 3/5 | 26/28 | $0.00074 |
| gpt-4.1-mini / gpt-4.1-mini | 103/112 (92.0%) | 0/103 | 18/19 | 3/5 | 26/28 | $0.00052 |

After fixing what it found (no longer blind; final engine `2aa48ad`, new defaults):
**111/112 (99.1%)**, unsupported claims 0/103, follow-ups 19/19, safe fallback 5/5, intent 28/28,
$0.00043 per turn. With no model at all the same engine scores 110/112.

The remaining failure ("Калдор 3 сарын 20-нд суудал байна уу") is an expectation I dispute:
the website holds no seat row for that departure, so the bot stays silent and writes a lead,
which is the owner's no-data rule. It is listed as an owner decision in `docs/chatbot-followups.md`.

Columns: "unsupported claims" = replies with an amount, date or phone not in the catalogue;
"follow-up turns" = every turn after the first in multi-turn conversations (context retention);
"safe fallback" = the five questions the data cannot answer (expected: silence plus a lead);
"intent" = hand-over, contact, booking, catalogue and small-talk turns.

## 9. API cost before and after

**Measured on the evaluation (same 118 dev turns, real API, list prices):**

| | Original engine | Final engine |
|---|---|---|
| Correct turns | 87/118 | 118/118 |
| Model calls per turn | 1.68 | 1.53 |
| Free-text reply calls | 15 | 2 |
| Cost per turn | $0.0066 | $0.00055 |
| Cost per conversation | $0.0084 | $0.0007 |

The original run recorded no cached-token data, so its cost is at full list price; at full list
price (no cache discount) the final engine costs $0.0010 per turn, still −84%.

**Measured on the live catalogue (prompt size per call, tokenizer count, no model call):**

| Call | Before | After |
|---|---|---|
| Free-text reply, general question (system + catalogue) | ~27,700 | 11,057 |
| Free-text reply, one trip in focus | ~28,000 | 11,430 |
| Free-text reply, three trips in focus | up to 38,000+ | 13,840 |
| Understanding (system + catalogue) | 5,578 | 5,258 |

**Production after deployment — estimate, not measured:** with production's call counts
unchanged (no credit taken for the fewer reply and understanding calls, nor for caching), the
smaller reply prompt and gpt-4.1-mini understanding give ≈ **$0.45–$0.50/day** against the
measured ≈ $1.05/day. The real figure must be read from `travel_ai_usage` after deploying.

## 10. Tokens per turn

Evaluation, same 118 turns: 3,042 → 1,938 input tokens per turn, 204 → 211 output. The invented
catalogue is small (12 trips); the production saving shows in the per-call prompt sizes above.

## 11. Model routing

| Step | Before | After |
|---|---|---|
| Understanding | gpt-4.1, nearly every message | gpt-4.1-mini (`TRIP_UNDERSTANDING_MODEL`); skipped when code settles the trip |
| Free-text reply | gpt-4o (fallback gpt-4o-mini on 429) | unchanged; output capped at 1,000 tokens |
| Memory merge, pre-answer analysis | gpt-4o-mini | unchanged (memory is 8–30% of evaluation spend; batching would save little) |

gpt-4.1-mini for understanding: dev 130–131/131 against 131/131 for gpt-4.1, held-out 103/112
against 101/112, at about a third of the cost. Its misreadings found on the way (an invented
package and topic, a kind-of-trip question read as a follow-up) are now caught by code, each with
a journey. The reply model was reached on 2–3 evaluated turns, too few to compare; gpt-4.1-mini
replies looked equivalent there, but it stays gpt-4o.

## 12. Performance and reliability

- Provider outage: the no-model runs score 110/112 held-out and 131/131 dev with every hard rule
  kept; the customer gets the outage notice only when the answer truly needed the model.
- Malformed, empty or invalid-key understanding replies fall back to the catalogue matcher (journey).
- Understanding timeout 8 s → keyword routing; reply timeouts and retries unchanged
  (`OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES`, circuit breaker).
- A model value from the environment that is not a known model falls back to the default.
- Already covered by the existing suite and still passing: rate-limit fallback, send retry with
  dedup, repeated delivery, concurrent same-customer ordering, long latency, database read
  failure (503 so Meta redelivers), Redis disconnect, consultant answering mid-composition.
- Fewer model calls on the critical path: ~10% fewer understanding calls in the evaluation and
  almost no free-text calls, which also shortens reply time.

## 13. Regression tests

| Check | Result |
|---|---|
| `npm test` | 1,708 tests: 1,707 pass, 0 fail, 1 to-do (pre-existing) |
| `npm run typecheck`, `eslint` (changed files) | clean |
| `npm run build` (runs preflight, accuracy fixture and `qa:conversations`) | passes; conversation gate 157 pass, 0 fail |
| `npm run gate` (read-only replay of 60 days of real messages) | identical decisions on original and final code; its listed changes come from catalogue edits since the saved baseline (baseline not re-saved) |
| `npm run qa:live` (live catalogue, real model, nothing sent) | see the result line below |
| New journeys | 26 in `tests/accuracy-cost-journeys.test.ts` (in `qa:conversations`); each fix's journey was run against the code before it and failed |

Test inputs changed (assertions unchanged, reasons in the commits): human-takeover journey 8 and
the webhook "explicit trip survives a contradicting model" case now send messages that still need
the model, because a trip's full name or a generic follow-up no longer calls one;
`tests/ai-trip-context.test.ts` follows the new catalogue layout.

**`npm run qa:live`** (12 journeys, 44 turns on the live catalogue, real model, nothing sent):
**0 fact issues**; the two silent turns are the staff-takeover scenario, where silence is
required. Every reply was read. The first run with gpt-4.1-mini showed one weaker shape: "далайн
аялал байна уу" right after picking a land trip got that trip's date menu, where gpt-4.1 and the
original engine list the sea trips. That decision is now made by code (commit `2763241`), and the
final replay lists the sea trips; it is the only reply that changed between the two full runs.
Another weak shape is unchanged from the original engine and listed in section 14 (a family's
adult count after "2 хүүхэдтэй" gets the date menu without the party total).

## 14. Remaining limitations

- Production effect is estimated, not measured; measure for a week after deploying.
- The evaluation catalogue is invented and small (12 trips). The live catalogue has 37 trips.
- The free-text reply model was barely exercised by either set; its choice is untested here.
- The understanding model still over-flags; code now filters the clear cases, partial-span flags
  still hand off (by design).
- Seat questions for a date with no seat data go to staff (owner decision pending).
- Live replay, unchanged from the original engine: after "2 хүүхэдтэй" and the adult count, a
  live trip whose fares differ by date gets the date menu without the party total; the total
  comes once a date is chosen. No wrong fact, but one extra turn.
- Data gaps from the audit remain data work: 31 trips miss a fare tier, 2 have no adult price.
- `npm audit --omit=dev` reports 21 pre-existing advisories (2 critical: `next`, `dompurify`;
  10 high, e.g. `@vercel/blob`, `sharp`, `undici`). Not changed here; worth a separate update.
- Desktop-consultant detection within 20 s and look-alike destinations stay open
  (`docs/chatbot-followups.md`).

## 15. Environment variables

No new variable is required. Optional:

| Variable | Default | Purpose |
|---|---|---|
| `TRIP_UNDERSTANDING_MODEL` | `gpt-4.1-mini` (was `gpt-4.1`) | understanding model; set `gpt-4.1` to roll back |
| `OPENAI_REPLY_MODEL` | `gpt-4o` | free-text reply model |
| `AI_DAILY_BUDGET_USD` | 20 | daily production spend alert (unchanged) |
| `EVAL_RUN_APPROVED`, `EVAL_MAX_MODEL_CALLS`, `EVAL_MODE`, `EVAL_SET`, `EVAL_ONLY`, `EVAL_LABEL`, `EVAL_UNDERSTANDING_MODEL`, `EVAL_REPLY_MODEL` | — | evaluation runs only |

## 16. Production deployment checklist

1. Review the three commits; merge `work/chatbot-accuracy-cost` into `main` (owner's call).
2. CI and the Vercel prebuild run `qa:conversations`; confirm green.
3. Leave `TRIP_UNDERSTANDING_MODEL` unset (gpt-4.1-mini) or set it explicitly; check no typo.
4. Deploy; confirm the deployment for the merge commit reaches Ready.
5. Send a few test messages from the test customer profile (owner's live test setup): a Latin
   price question, "hun bnu", a typed address question, a budget question.
6. For the first days, watch the admin System page (spend by model, `trip_understanding` now
   gpt-4.1-mini) and the Leads tab for `answer_plan` hand-offs.
7. After a week compare `travel_ai_usage` (production) with ≈ $1.05/day; record it in
   `docs/chatbot-followups.md` (P2-6).
8. Rollback: revert the merge, or set `TRIP_UNDERSTANDING_MODEL=gpt-4.1` for the model alone.
