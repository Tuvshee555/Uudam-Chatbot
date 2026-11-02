# Chatbot accuracy and cost audit — 2026-11-02 (Phase 1)

Scope: the Messenger/Instagram reply pipeline (`src/pages/api/webhook.ts` and `src/lib/*`),
its model calls, the recorded spend (`travel_ai_usage`), the per-message outcome trail
(`travel_error_logs`), and 789 distinct real customer messages of the last 45 days (read
locally, anonymised, never committed). Reference: the Lorentz commerce chatbot at
`C:\Dev\github-v1\eyebrow` (`69e4110`, read-only). Branch: `work/chatbot-accuracy-cost`.
Nothing was written to production data.

## 1. What works well (keep)

- **Deterministic first.** Greetings, thanks, payment claims, bank-account requests, contact
  buttons, phone capture, booking collection, numbered picks, fare-only follow-ups, date and
  month follow-ups, trip cards, programme/PDF, "which trip?" lists and the whole
  `tripAnswerPlan` (fares per date/hotel/package, party totals, inclusions, booking terms,
  weather) run in code. In the last 7 days 54% of answered text turns never reached the free-text
  model.
- **Grounding at the exit.** Every reply (deterministic or model) passes `verifyTripReply`,
  price/date guards, wrong-trip and ungrounded-trip checks before `deliverFastPathReply`; the
  model's REFER means silence plus a staff lead, never a guess. Payments are never confirmed.
- **Understanding is bounded.** `tripUnderstanding.ts` lets the model propose a reading, but
  `customerTripEvidence` only allows trips the customer, a pending list, a stored selection or
  recent history actually point to; `buildTripRequest` re-parses dates, passengers, hotels and
  topics from the text.
- **Operational safety.** Signed webhooks, replay dedup, per-conversation lease, retry with
  backoff and timeouts (`resilience.ts`), rate limits, circuit breaker, outage notice to the
  customer, spend ledger per environment, daily budget alert, mocked CI, opt-in capped live
  evaluations (`evalGuard.mjs`), staff takeover detection, persisted privacy-safe outcome trail.
- **Business memory.** Dozens of guards each trace back to a real conversation (comments cite the
  date). These stay.

## 2. What causes incorrect answers today (evidence)

Measured on production, last 7 days, 238 text turns (96 silent because a consultant owns the
conversation; 142 the bot handled):

| Outcome | Turns | Share of handled |
|---|---:|---:|
| Deterministic answer (plan, lists, cards, contact, greeting, dates…) | 77 | 54% |
| Free-text model answered (`route=-`) | 25 | 18% |
| **No data → silence + lead** (model REFER 13, planner 3, unsupported request 8, not found 3) | 27 | **19%** |
| Other deterministic silence (get-started greeting) | 3 | 2% |

Decision records (14 days): 37 answered / 27 clarify / 6 handoff; handoffs for `price`,
`booking_terms.visa`, `transport`, `hotel.location`, `other.unsupported`.

Where wrong or missing answers come from:

1. **The free-text model path is fed the wrong catalogue.** `focusKnowledgeBase` is line-based,
   but two trips' descriptions contain line breaks, so every trip after them is never
   summarised; the "summary" prompt is 23.5K tokens instead of ~4.5K and per-date price
   tables (53% of all catalogue tokens) reach the model on every call. More text to pick the
   wrong fact from, and a third of these $0.08 calls end in REFER anyway.
2. **Latin-script intent gaps.** Hand-over keywords are Cyrillic/English only ("hun bnu",
   "operator bnu" are not caught); office/phone questions match only two Latin spellings;
   `normText` bridges ~25 Latin words (Lorentz: ~150). 49% of real messages are Latin-only.
3. **Facts the catalogue does not hold** (hand-off by design, not a bug): flight hours between
   cities, when a group forms, hotel distance/facilities, single-traveller seat rules. 31 trips
   still miss a required fare; 2 active trips have no price.
4. **Context loss at layer seams** (documented in `docs/chatbot-forensic-audit.md`): most were
   fixed on 2026-10-30; the Oct-24 family shape (P1-1) is fixed; remaining open items are in
   `docs/chatbot-followups.md`.

## 3. Where unnecessary model calls occur

| Call | Model | Per call | Calls (4 days) | When |
|---|---|---:|---:|---|
| `api.webhook` reply | gpt-4o | 31,605 in / 76 out | 37 | every turn no deterministic path answered; 13 of 37 ended REFER (silence) |
| `trip_understanding` | gpt-4.1 | 5,373 in / 79 out | 98 | nearly every text turn (except numbered picks, own buttons, greetings) |
| `api.webhook.reasoning` | gpt-4o-mini | 2,262 in | 23 | context-dependent messages |
| memory merge (`api.webhook.*` sources) | gpt-4o-mini | ~450–700 in / ~200 out | ~160 | after every answered turn |

Avoidable: the reply prompt carries ~19K tokens of un-summarised trip detail (bug) and a
4,101-token rule list; the understanding call reads the whole catalogue (37 lines, ~3,500
tokens) even when the deterministic matcher already names exactly one trip.

## 4. Where the spend originates (recorded, production, 4 days of data)

| Source | Cost | Share |
|---|---:|---:|
| free-text reply, gpt-4o | $2.95 | 70% |
| trip understanding, gpt-4.1 | $1.12 | 27% |
| everything else (gpt-4o-mini) | $0.15 | 3% |

≈ $1.05/day; ≈ $0.030 per handled text turn; ≈ $0.11 per turn that reaches the free-text model.
(`travel_ai_usage`, environment `production`; estimates at list price.)

## 5. Business facts not reliably grounded

- Fares: 31 trips lack a required fare (infant 28, child 11, adult 6), 2 active trips have no
  adult price → "price" hand-offs. Data work, not code.
- Office address and phones live in settings and are answered only by two exact button phrasings;
  any other phrasing goes to the model, which has no address in Context → silence.
- Hotel facilities/location, flight durations, group-formation dates, single-traveller policy:
  no field exists; the bot hands off (correct) but could say so.
- The understanding model is asked to infer `date`/`month` from relative phrases ("ирэх сард",
  "next weekend"); code parses months and explicit dates, not weekends.

## 6. Highest value, lowest risk (the plan)

1. **Evaluation harness first** (invented catalogue, real webhook, real or absent model,
   hard rules + expectations, per-turn tokens/cost). Dev set for tuning; a held-out set of
   ≥100 turns written after the engine is frozen and run once per model configuration.
2. **Fix the catalogue context** (newline-safe focus, summary lines without price tables,
   ≤3 focused trips, trimmed rule list). Expected: ~31K → ~8–10K tokens per reply call with
   the same facts available for the asked trip.
3. **Latin-script bridges** in one place (`normText` alias table + an `intentProbe` used by the
   hand-over, contact, booking and generic-request predicates), with real-message shapes as
   tests.
4. **Model benchmark** on the held-out set: reply gpt-4o vs gpt-4.1-mini vs gpt-4o-mini;
   understanding gpt-4.1 vs gpt-4.1-mini. Switch only what the numbers support; a model
   allow-list with explicit env override (`resolveReplyModel`).
5. **Skip the understanding call** when the deterministic matcher already verifies one trip and
   nothing is pending — only if the dev and held-out sets show no regression.
6. Reliability: keep the existing outage/retry design; add a hard check that no customer reply
   is ever a control token or an English rule leak (already guarded; covered by the harness).

Results, before/after cost and the held-out scores go in `docs/chatbot-accuracy-cost-report-2026-11.md`.
