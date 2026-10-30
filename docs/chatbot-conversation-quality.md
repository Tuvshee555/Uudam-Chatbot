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

## 5. Verification

- `npm test`: 1,498 / 1,498 pass.
- `npm run gate`: the trip decisions over 1,395 real messages are byte-identical before and after this
  branch; trip-less sentences 0/25; own answers rejected 0/247.
- `npm run qa:conversations` 38/38; `npm run qa:accuracy:fixture` 10/10; `tsc` and `eslint` clean.

## 6. Prioritised backlog (evidence → impact)

| Priority | Issue | Evidence | Impact |
|---|---|---|---|
| P1 | Model-only multi-constraint openings (dates + party + lodging + "send the programme") ignore all but the date | Oct 24 conversation; turn #12 | Lost family leads |
| P1 | Test sessions write to the production conversation table | 87% of rows are `demo:` | Every dashboard and audit is skewed; add a flag or a separate table |
| P1 | No conversation-level metric in CI | §3.4 of the audit | Regressions pass unit tests; make the live replay a scheduled, budgeted job |
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

- This branch is **not merged and not deployed to production**. Pushing the branch creates only a Vercel
  preview.
- Schema: no new column in this branch. `quick_info_sent_at` was added earlier by 58e9f0c with
  `ADD COLUMN IF NOT EXISTS`, and is safe to keep on rollback.
- To deploy after approval: merge to `main`. Vercel builds (prebuild runs the QA gates), then check the
  deployment is Ready and send one real test message from a staff account.
- Rollback: Vercel → Deployments → promote the previous production deployment (58e9f0c or 2265779), or
  `git revert` the merge commit. No data migration is involved.
