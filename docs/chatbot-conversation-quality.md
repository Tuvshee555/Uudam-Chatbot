# Chatbot conversation quality — rubric, baseline and before/after (2026-10-30)

## 1. Rubric (per customer turn)

A turn is **correct** when all of these hold:
1. **Grounded:** every price, date and inclusion comes from the trip data the bot read (checked by
   `verifyTripReply`); no estimate, no invented availability.
2. **On the asked trip:** the trip the conversation selected or the customer named, or the list just
   shown. A ruled-out place is never answered.
3. **Context kept:** nothing the customer already said is asked again or dropped (trip, date window,
   party, booking intent).
4. **Progress:** the reply answers or asks the single missing fact. Silence is correct only when the data
   cannot answer (owner's rule), and then a staff lead must exist.
5. **Booking honest:** "received" only after the lead write succeeded; nothing promised that no system
   did.
6. **Format:** short list cards and a full card after a pick; no "undefined", no phone request on cards.

Failure categories used below: `silence`, `wrong-trip`, `lost-context`, `repeat-question`,
`misleading-total`, `ungrounded-model`, `format`, `ignored-constraint`.

## 2. Denominators

| Measure | Count |
|---|---:|
| Exported conversation rows | 25,134 |
| Rows from real customers / test sessions | 3,290 / 21,844 |
| Real customers (senders) | 644 |
| Real conversations with 3+ customer turns (the multi-turn population) | 224 |
| Historical examples traced to source (§2 of the forensic audit) | 8 |
| Replay scenarios / customer turns run live on `main` and on this branch | 11 / 35 |

## 3. Before/after on the same 35 turns (live model, live catalogue, 2026-10-30)

Lists (10 turns) are identical except where `main` printed "undefined/undefined" (3 of 10). The 25
conversational turns:

| # | Customer turn (scenario) | `main` (58e9f0c) | This branch |
|---|---|---|---|
| 2 | "1" under a list (booking chain) | `silence` + lead | Picked trip + bookable dates |
| 3 | "zahialga hiie" | Phone question ✓ | Phone question ✓ |
| 4 | phone | "Аль аялал вэ?", no lead (`lost-context`) | Trip named, request received, lead with trip ✓ |
| 6 | "1" after "<city> үнэ" | Fares ✓ | Fares ✓ |
| 7 | "Хүүхдийн амралт 11.20-с эхлэх…" | A different, sold-out trip (`wrong-trip`) | Departures from 11/20 of the picked trip ✓ |
| 9 | "11/14-с хойш" under a destination list | All destinations, destination dropped (`lost-context`) | That destination's trips from 11/14 ✓ |
| 10 | greeting | ✓ | ✓ |
| 11 | "11.10-15-ны хооронд эхлэх аялал" | Window list ✓ | Window list ✓ |
| 12 | Family, Feb 5, villa, "send the programme" | No Feb date + December dates (`ignored-constraint`) | Same — **open** |
| 14 | "Universal bagtsan vne" | Universal trip fares + inclusions ✓ | Same ✓ |
| 15 | "12 сард" | December date ✓ | December date ✓ (shorter) |
| 16 | "2 хүүхэдтэй" | "Нийт" over 2 children only (`misleading-total`) | Child fare + "Хэдэн том хүн явах вэ?" ✓ |
| 17 | "2" | `silence` + lead | Total for 2 adults + 2 children ✓ |
| 18 | "Захиалга өгье" | Phone question ✓ | ✓ |
| 19 | phone | "Аль аялал вэ?", no lead (`lost-context`) | Trip named, request received, lead ✓ |
| 21 | "3" under a list | Free-text model card (`ungrounded-model`, other format) | The same full card as the button ✓ |
| 22 | "Үнэ" | ✓ | ✓ |
| 24 | "1" | ✓ | ✓ |
| 25 | "2 том хүн 1 хүүхэд" | Date question only (`repeat-question`) | Total + bookable dates ✓ |
| 26 | "Одоо 3 том хүн" | Same date question again (`repeat-question`) | Total for 3 adults + the child ✓ |
| 28 | "<city> биш, далайтай нь" | That city's itinerary (`wrong-trip`) | Sea trips, the ruled-out city excluded ✓ |
| 29 | "Захиалга өгөх" | ✓ | ✓ |
| 31 | phone after a list | "Registered", lead without context | Same reply; lead names the trips shown ✓ |
| 33 | "1" | ✓ | ✓ |
| 34 | "2 хүүхэдтэй" | Date question (`repeat-question`) | Child fare + adult question ✓ |
| 35 | "2 том хүн" | Date question (`repeat-question`) | Total incl. the 2 children ✓ |

| | `main` | This branch |
|---|---:|---:|
| Conversational turns correct (of 25) | 12 | 24 |
| Silences where the data could answer | 2 | 0 |
| Wrong-trip answers | 2 | 0 |
| Booking chains ending with a lead naming the trip (of 2) | 0 | 2 |
| Misleading totals | 1 | 0 |
| Lists with "undefined" (of 10) | 3 | 0 |

Caveats: one run per scenario on a non-deterministic model; scenarios are shaped on real conversations but
are not a random sample. The deterministic paths behind each fix are pinned by
`tests/forensic-regressions.test.ts`. Its seven conversation checks fail on `main` and pass here (checked
by running them against `main`'s `src/`).

## 4. Regression tests added

`tests/forensic-regressions.test.ts` runs the real webhook on an invented catalogue with a mocked model:
- a weekly schedule renders as text in a list card;
- a typed number gets the same card as its button, with no free-text model call;
- booking after a pick completes on the phone, naming the trip, with no "Аль аялал вэ?";
- a phone after a list writes a lead naming the trips shown;
- children only → child fare + one adult question → "2" → total over everyone → "Одоо 3 том хүн" keeps the
  children;
- "from this date on" lists only later departures;
- "<place> биш, …" excludes that place and lists what was asked;
- unit rules: date-onward parsing, party merging, the adult-count answer, negation, lead context.

Updated tests whose expectation was the old behaviour: `booking-collect` (the phone completes),
`compact-booking-webhook`, `webhook-configured-reply-boundary` (a booked customer belongs to staff).

## 5. Verification (final branch state, rebased on the production hotfix d8c236f)

- `npm test`: 1,509 pass, 0 fail, 1 todo (the open multi-constraint gap, kept visible on purpose).
- `npm run gate`: the trip decisions over 1,430 real messages are byte-identical to production (d8c236f);
  trip-less sentences 0/25; own answers rejected 0/247.
- `npm run qa:conversations` (the CI and Vercel prebuild gate): 66 pass, 1 todo, 0 fail (was 38 tests).
  `npm run qa:accuracy:fixture` 10/10; `tsc` and `eslint` clean.
- `npm run qa:live`: 12 journeys, 42 turns, 0 fact issues; the 3 silent turns are a booked customer and a
  staff takeover, both by design.

## 5a. Final end-to-end replay of customer journeys (live model, live catalogue)

16 journeys covering every area under review. Every reply was also fact-checked: each ₮ amount must be a
stored catalogue number or a total that adds up, and each month/day must be a stored departure. **0 fact
issues.**

| Journey | Result |
|---|---|
| Pick by typed number, then "Үнэ" | Full card of the 2nd shown trip; price of that trip ✓ |
| Pick by tapping button 3, then "хүүхдийн үнэ" | Full card of trip 3; its child fare ✓ |
| Pick, "zahialga hiie", phone | Phone asked once; request received naming the trip; lead carries trip + phone ✓ |
| "Захиалга өгөх", destination, phone | Lead carries the trips that were shown ✓ (the trip is not chosen, so it is not named) |
| Children only → "2" → "Одоо 3 том хүн" | Child fare + adult question; totals 2 adults + 2 children, then 3 + 2, arithmetic correct ✓ |
| "2 том хүн 1 хүүхэд" → "зөвхөн 2 том хүн" | Total for the party, then for 2 adults only ✓ |
| "Хүүхдийн амралт 11.20-с эхлэх…" on a picked trip | Only departures from 11/20 ✓ |
| "11/14-с хойш" under a destination list | That destination's trips from 11/14 ✓ |
| "11.10-15-ны хооронд эхлэх аялал" | Every trip departing in the window ✓ |
| Destination list, "12 сард" | December departures of that destination ✓ |
| Switch destination mid-conversation | New destination's list ✓; a following "хүүхдийн үнэ" under that list got "Аль аялал вэ?" (acceptable, not ideal: P2) |
| "<place> биш, далайтай нь" | Sea trips, the ruled-out place excluded ✓ |
| Staff takeover, then questions and "захиалга өгье" | No bot message; inbound kept for staff ✓ |
| Returning after 40 days: greeting, then "үнэ" | Greeting without the old trip; "үнэ" re-lists the earlier trips rather than pricing one silently ✓ |
| "мэдээлэл", greeting, "мэдээлэл" | Company intro once; the second time "Аль аялал вэ?" ✓ |
| **Oct 24 shape: family, ~Feb 5, children 6 and 2, villa/resort, "send the programme"** | **Repaired 2026-10-30.** Departures in the window, the children's fares, the programme, the hotel, "how many adults?"; villa/resort passed to staff with a lead, never inferred (see `docs/chatbot-followups.md` P1-1). |

**The Oct 24 gap (closed 2026-10-30).** It affected first messages that pack several constraints together,
typical of high-value family bookings. They are now answered part by part; lodging type still cannot be
answered from data (the catalogue has no villa/resort field), so that part goes to staff. The journey
`a family's multi-part opening…` in `tests/conversation-journeys.test.ts` guards it.

Also fixed during this replay: when the model resolves a trip only from old turns (no live selection, for
example a customer back after weeks), the answer now names that trip instead of quoting a bare price.

## 5b. Conversation-level quality gate

- `tests/conversation-journeys.test.ts`, `tests/forensic-regressions.test.ts`,
  `tests/conversation-followups.test.ts` and `tests/list-card-dates.test.ts` now run inside
  `npm run qa:conversations`. That gate runs in GitHub CI on every push and pull request **and in the
  Vercel prebuild**, so a change that breaks a customer journey fails the build and cannot deploy.
- Each journey asserts the outcome the customer needed (the right card, a lead naming the trip, a correct
  total, the right departures, silence during a takeover). Every reply in the journey suite is also checked
  against the catalogue for amounts, dates, totals and placeholders.
- `npm run qa:live` (`scripts/live-replay.ts`) replays journeys against the live catalogue and the real
  model and fails on any fact issue. `.github/workflows/live-replay.yml` runs it on pull requests that touch
  the bot, weekly, and on demand. It needs two repository secrets, `LIVE_REPLAY_NEON_DATABASE_URL` (read-only
  role recommended) and `LIVE_REPLAY_OPENAI_API_KEY`, and is skipped with a notice until they exist.

## 6. Prioritised backlog (evidence → impact)

| Priority | Issue | Evidence | Impact |
|---|---|---|---|
| P1 | Model-only multi-constraint openings (dates + party + lodging + "send the programme") ignore all but the date | Oct 24 conversation; turn #12 | Lost family leads |
| P1 | Test sessions write to the production conversation table | 87% of rows are `demo:` | Every dashboard and audit is skewed; add a flag or a separate table |
| P1 | A booked customer asking a follow-up ("хэзээ холбогдох вэ") gets no reply until staff answer, and staff alerts have no channel | Live replay, booking journey | The customer can wait unanswered; add an alert channel or one acknowledgement |
| Done | Conversation-level gate in CI and Vercel prebuild; live replay workflow | §5b | — |
| P2 | A fare-kind question under a fresh multi-trip list ("хүүхдийн үнэ") gets "Аль аялал вэ?" instead of that fare for the listed trips | Live replay, destination switch | One extra turn |
| P2 | Fuzzy match crosses look-alike destinations (one letter apart) | One destination read as a look-alike other (earlier finding) | Wrong trip; needs a data-side "not this place" field |
| P2 | Un-ingested messages are invisible | Oct 6 "Universal bagtsan vne" absent from the DB | Log every inbound event ID before routing |
| P2 | Staff alerts have no channel | `staff_alert.no_channel_configured` | Leads wait until someone opens the Leads tab |
| P3 | Free-text model still writes ISO dates and phone asks when it answers | Turn #21 on `main` | Now rarer; tighten its prompt or post-check |

## 7. Meta settings checklist (cannot be changed from code)

- Meta Business Suite → Inbox → Automations: the greeting / instant reply with the customer's name is
  Meta's, not the bot's. Turn it off, or align it with the bot.
- Check that no other automation (away message, FAQ) answers the same keywords as the bot.
- Webhook subscription: `messages`, `messaging_postbacks` for each page in `FACEBOOK_PAGES`.

## 8. Deploy and rollback

- Production runs **d8c236f** (the isolated list-date hotfix). This branch is rebased on it and **not
  merged**; pushing it creates only a Vercel preview.
- Schema: no new column in this branch. `quick_info_sent_at` was added earlier by 58e9f0c with
  `ADD COLUMN IF NOT EXISTS`, and is safe to keep on rollback. Booking state written by the old flow at its
  "trip" step still completes (covered by `booking-collect.test.ts`).
- To deploy after approval: fast-forward `main` to the branch. Vercel builds (the prebuild runs the
  conversation gate), then confirm the deployment is Ready for that commit and send one test conversation
  from a staff account (list → number → "захиалга" → a staff phone).
- Rollback: Vercel → Deployments → promote d8c236f (the current production deployment), or
  `git revert` the merge. No data migration is involved.
- Watch after deploy: `webhook.no_data_reply_suppressed` and `booking_collect_completed_total` counters, and
  new leads' context lines.
