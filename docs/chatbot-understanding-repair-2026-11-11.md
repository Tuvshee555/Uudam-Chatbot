# Chatbot understanding repair (2026-11-06 → 11-11)

Branch `fix/understanding-integrate` (local, not pushed, not deployed). Base `d500ecf`, `main` merged in on 11-11.

## 1. What was wrong (evidence, not hypothesis)

The owner's hypothesis is **confirmed**: the bot chose which trip/data to fetch before it knew what the customer
needed.

- About 37 gates and 7 keyword branches ran before the only model call, and that call (`understandTripMessage`) only
  identifies trips. Its `intent` output barely affected routing, and a trip/place word in the customer's text forced
  `intent = "trip"`.
- There was no home for social, organisation/group, payment-terms, transport-only, existing-booking or complaint
  messages. They got a trip card, a list, the booking collector's phone ask, or silence.
- Closed word lists were used as judgements:
  - `calendarWordsAreContextOnly`: any unlisted word beside a date meant "unknown destination" and silence (case 3).
  - `isHolidayCatalogQuestion`: holiday + place took the old "no trip then" template (cases 2 and 14).
- The selected trip was not defended. Evidence came from the current text only, so a word from another trip's title
  hijacked the selection (case 11). Sold-out trips could not be matched (case 13).
- An alias was matched inside longer words with no word boundary: "Санья" matched inside "санал" (case 14).
- Case 7 was a **real OpenAI credit outage** (429, 11-03 23:18 → 11-04 ~14:16), not a reasoning error. It only reached
  the customer as "system down" because group messages depended on the model.
- The case 8 discount claim was **invented by the model**. No discount, group or barter policy exists anywhere in the
  data, the prompt demanded a yes/no "Тийм" format, and no output guard checked commercial claims.
- Git: the same classes recurred after keyword-shaped fixes (holiday ×5 episodes, shared title word, origin city).
  c1a87bd (holidays) went live 11-04 19:56. That was after the 11-04 failure and before the 11-05 and 11-06 failures,
  which used a neighbouring phrasing it did not cover.

Full reports (session scratchpad): architecture, four case traces, git history, data consistency, and a review of 402
real threads (Oct 23 – Nov 6; 298 from the export plus 104 read from the DB for Oct 23–27).

## 2. What changed (architecture, not phrases)

1. **Need gate** (`messageNeed.ts`, `needDispatch.ts`). This is a deterministic step with no model call that runs
   before any trip lookup or the booking collector.
   - Thanks/praise get the thanks line. A bare "ok" gets nothing.
   - Organisation/group/custom asks get the website's verified custom-trip wording plus ONE question (destination,
     then month, then budget, then group size) and a typed lead. The handoff sentence appears only if the lead saved.
   - Barter, contract, instalments and discount questions get a typed lead and silence (no data → no answer).
   - Pick-up, transfer and ticket-only asks get a typed lead and silence.
   - Questions about an existing booking get a typed lead and never the phone ask.
   - Complaints go to the existing hand-off branch.
   - The model's `need` field is in **observe** mode (`NEED_MODEL=observe`, logged only).
2. **Commercial-claim guard** (`commercialFacts.ts`, `reply.ts`). A reply may state a discount, group price, barter
   or contract term only if the owner's FAQ, offers or discount policies hold it. The prompt no longer demands "Тийм".
3. **Identity and context** (`tripIdentity.ts`, `tripContrast.ts`, `aliasMatch.ts`, `soldOutNamed.ts`, `dateMiss.ts`,
   `scheduleTimes.ts`, `listCompleteness.ts`):
   - The selected trip stays the default. Another trip wins only on identity the selected one lacks; transport words
     are not identity.
   - "өмнөх / нөгөө / биш / эхний" resolve against a stack of the last trips shown.
   - Aliases match whole words only.
   - A full or closed named trip is announced as full or closed instead of listing its siblings.
   - A customer a consultant wrote to within 30 days is not re-sold other dates.
   - Flight-time questions are answered from the itinerary's clock times or not at all.
4. **Calendar and holiday** (`placeLikeTokens.ts`, `inheritedDateScope.ts`, `quotedPriceReply.ts`, `catalogListing.ts`):
   - One path for holiday ± place. The reply names the window and lists the nearest departures, or says the schedule
     is not out yet.
   - Departures that overlap the holiday are marked.
   - New Year lists put departures overlapping Dec 31 first.
   - Date follow-ups in ordinary words are answered, and the stated year is honoured.
   - An unknown place is a constraint: silence + lead, or the ended-trip notice. It is no longer dropped.
   - Party fares are computed per listed trip.
   - Quoted prices match adult fares first. If none match exactly, the budget answer is used. The reply asks for the
     poster instead of claiming a match.
5. **Send guard** on the PDF/file senders (takeover).
6. **Merge with the corporate catalogue** (from `main`). The catalogue answers "organisation + travel" requests first.
   It never answers a thank-you, payment-terms, booking or complaint message.

## 3. Results (designed scenario set, NOT production accuracy)

`npm run qa:scenarios` on 299 scenarios (332 judged turns). Invented catalogue, mocked model, same set both runs:

| | before (d500ecf) | after |
|---|---|---|
| turns passed | 179/332 | 295/332 |
| need handled right | 120/211 | 198/211 |
| correct trip | 54/114 | 91/114 |
| correct date/holiday | 30/82 | 64/82 |
| wrong-topic reply rate | 88/229 | 16/218 |
| unsupported claims | 10/229 | 0/218 |
| silence on positive controls | 0/45 | 0/45 |
| bot interrupting staff | 0/40 | 0/40 |
| "system down" on model-free needs | 9/19 | 0/19 |
| model calls per turn | 0.83 | 0.35 |

**One paid live run** (11-11; live catalogue read-only, real model, nothing sent, cap 150 calls, estimate ~$2.61):
16 journeys, 29 turns, **0 fact issues**, 7 silent turns. Every reply was read.

**Checks on the final branch:**

| Check | Result |
|---|---|
| typecheck | clean |
| `qa:conversations` | 545 tests / 0 fail / 41 todo |
| `npm test` | 2989 / 0 fail / 41 todo |
| `qa:accuracy:fixture` | passes |
| `npm run gate` | 0/25 trip-less picks, 0/264 checker rejections. 161 changed decisions vs the 11-04 baseline: about 156 from catalogue edits since then, 8 from code, and the 8 are intended ("санал" no longer picks a Sanya trip, and similar). |
| `next build` (clean install) | passes |

## 4. Still open (visible as `test.todo`, see `tests/fixtures/understanding-scenarios-open.json`)

- **Weather across sibling trips (case 12):** now silence + lead instead of a wrong list, but no answer yet. The
  weather API is per trip, and sibling trips share the place.
- **Holiday + place with no departure in the window (case 2):** the reply is correct in shape (it names the window,
  says the schedule is not out, and lists the nearest dates). The scenario predicate wants only dates near the window,
  and the order should be nearest-to-window first.
- A long thank-you that opens with a greeting gets silence (and a lead), not the thanks line.
- Child fares under a New Year list leave a trip with no age band blank. "хүүхдийн үнэ" after a date question
  re-asks the date.
- Routing follow-ups (P2-6 in `chatbot-followups.md`):
  - a bare alias shared by a full trip and an open sibling;
  - a one-destination switch while the model is down;
  - existing customers on Instagram (no consultant rows there).
- The constraint ledger (sender-level destination, party, group size and purpose kept across trip switches) is
  **not built**. Only the date-scope seam (`inheritedDateScope.ts`) exists.
- `webhook.ts` is about 2,990 lines, over the 2,000-line cap.

## 5. Data problems (not AI)

- Corrupted FAQ and comment replies (literal `?`).
- `booking_terms` is empty on all trips.
- There is no group, corporate, barter or discount policy anywhere.
- Turkey 12/26 is on the website with no fare in the DB.
- Shanghai-Tianmen 11/19 is SOLD_OUT with "3 seats left".
- Archived trips carry phantom 2027 dates from `date_keys`.
- 7 of 39 trips have no transport type.
- Thin aliases: 16 of 39 trips have none.
- Nearly every lead has `seen_at` null. Verify that staff read the Leads tab, because "silence + lead" only works if
  they do.

## 6. Deploy and rollback

- **Deploy (needs owner approval):**
  1. Fast-forward `main` to `fix/understanding-integrate`, or merge it.
  2. Push. Vercel prebuild runs preflight, the accuracy fixture and the conversation gate.
  3. Watch `webhook.need_classified` and `webhook.inbound_outcome` routes in `travel_error_logs` for 48 h.
  4. Then `npm run gate -- --save`.
- **Rollback:** `git revert -m 1 <merge sha>` and push, or promote the previous production deployment in Vercel
  (instant).
- **Feature switch:** `NEED_MODEL=off` disables only the model-need observation. The rule gate has no switch, so
  reverting the code is the way to remove it.

## 7. Owner decisions needed

1. Should group/organisation asks keep the one verified line plus a question, or go fully silent (owner rule)? Should
   barter, transfer and existing-booking stay silent (current), or get one holding line?
2. Is a 30-day silent "existing customer" window right?
3. Should the model `need` stay in observe mode, or be enforced after reviewing about a week of logs?
4. Enter real group/discount/barter policy in the admin, if any exists. The bot will then answer from it.
