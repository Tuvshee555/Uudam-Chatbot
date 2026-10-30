# Chatbot forensic audit — 2026-10-30

Scope: the exported conversation and trip tables (snapshot 2026-10-30 01:38 UTC), the full Git history
(558 commits, 2026-05-17 → 2026-10-30), and the current code replayed against the live catalogue with the
live model. No customer name, phone number or identifier appears in this document. The raw export stays
outside the repository.

## 1. What the export really contains

| | Rows | Senders |
|---|---:|---:|
| All conversation rows | 25,134 | 9,807 |
| **Real Messenger customers** (`facebook:<page>:<psid>` in June, bare PSIDs from July) | **3,290 (13%)** | **644** |
| Test, QA and replay sessions (`demo:*` — `demo:qa` alone is 4,589 sessions, plus `golden-*`, `replay-*`, `current-*`, `audit-*`, agent `codex-*` checks) | 21,844 (87%) | 9,163 |

- The "8,023 sender histories share a fingerprint" finding is almost entirely the scripted `demo:` traffic.
  Among real customers, 120 share a fingerprint, and those are one-message chats such as a greeting and the
  same reply.
- Real customers by month: June 189 rows, July 134, **no August rows**, September 982, October 1,985.
- Real conversations by customer turns: 1 turn 284, 2 turns 136, 3–4 turns 135, 5–9 turns 58, 10+ turns 31.
- **Phone requests ("Утасны дугаараа үлдээвэл"), real customers only:** July 31.1%, September 20.9%,
  October 0.9%. The 41% figure in the first audit is driven by test traffic (September test sessions 81%).
- **The 81 empty-text bot rows** are all real and all carry an attachment (photo sends), so they are not
  failures.
- **"Phone given, bot asked for a phone again"** happened 0 times for real customers. The July 9 example in
  the first audit is a `demo:` test session.

## 2. The known historical examples, checked

| Date | What happened (real customer unless noted) | Root cause | On current code (2026-10-30) |
|---|---|---|---|
| Jul 9 | Phone answered with a phone request | **Test session**, not a customer | Not a real-customer defect |
| Sep 11 | After the trip card, "zahialga hiie" (book, Latin script) got the same card again; the customer retyped in Cyrillic | Booking intent missed Latin "zahialga" | Latin booking was fixed later. **But** after the phone the bot asked "Аль аялал вэ?" and wrote no lead → **fixed today** |
| Oct 6 | "Бээжин үнэ" then "Universal bagtsan vne" got no reply | That message is **not in the database** (never ingested, or lost before saving). Nearby silences follow a staff reply, which pauses the bot. | Unverifiable from the export. Today the same chain is answered (see §4). |
| Oct 15 | "School break starts 11.1" re-sent the card with July/August dates | (a) Yearless dates rolled into next year: fixed later by `nearestOccurrenceOfYearless`. (b) "from date onwards" was never understood | (b) **fixed today**: replies list departures from that day |
| Oct 16 | "Any tour departing 10.20–23?" was answered about one unrelated trip | A trip-less sentence matched one trip's words | Already fixed (gate check "trip-less sentences: 0/25"); a window now lists every matching trip |
| Oct 24 | Vietnam, around Feb 5, children 6 and 2, villa/resort, "send the programme": answered "no Feb 5 departure" plus the December dates | Date lookup is factual; preferences and the programme request are ignored | **Still open** (backlog P2) |
| Oct 26 | "11/14-с хойш" (from 11/14) after a destination list got silence | "from date" not parsed | **Fixed today** |
| Oct 30 | "Захиалга өгөх" got silence | Reply compaction stripped the only question | Fixed this morning (2265779) |

Historical prices and dates are not judged against today's catalogue. Where this table calls an answer
"factual", it means it matched the data the bot read at the time; where that cannot be shown, it says
unverifiable.

## 3. Why four months of fixes did not produce a reliable assistant

**3.1 Layers were added on top, never replacing.** Keyword fast paths (June–July) came first, then
clarification state (Jul 7), then an AI "which trip" reading (Oct 2), an answer plan and a selected-trip
store (Oct 3), and one exit check for every reply plus a replay gate (Oct 16). Each was added beside the
old paths, and the webhook decides between them with ordered branches:

| Date | webhook.ts lines | reply-branch markers | src/lib lines | test files |
|---|---:|---:|---:|---:|
| 2026-06-10 | 1,773 | 0 | 8,561 | 18 |
| 2026-07-31 | 2,110 | 37 | 31,247 | 58 |
| 2026-09-30 | 2,415 | 53 | 37,906 | 88 |
| 2026-10-30 | 2,586 | 78 | 47,768 | 192 |

**3.2 Most of today's confirmed defects sit on a seam between an old and a new layer:**
- The booking collector (June) read the trip from the words of the last reply. The selected-trip store
  (Oct 3) was never wired into it. When follow-up answers stopped repeating the trip title (Oct 30), the
  booking flow lost the trip.
- Routing resolved a typed "3" to the right trip (July), but the card builder needed the trip name in the
  customer's own words, so a typed digit fell through to the free-text model. The button tap carried the
  name and worked, so tests that used taps passed.
- The answer plan (Oct 3) printed a "total" over children alone. Routing and the plan both merged the same
  turn's passengers, so a correction ("now 3 adults") replaced the party.
- Date parsing (`travelDates`) knew windows and single days, never "from this day on". The plan and the
  routing each read dates separately.

**3.3 Rules were reversed back and forth.**
- **Silence:** "Never let the bot stay silent or guess" (Sep 8) → "Stay silent when the bot does not
  know" (Sep 20) → "Owner's rule: no data, no answer" (Oct 16). About a dozen October commits then fixed
  silences the rule itself produced.
- **Pause after a hand-off:** 14 days → 30 days → 3 days → 1 hour → none (Oct 30).
- **Reply style:** ask for the phone on the first answer (Jun 28) → concise and single-question (Oct 30
  morning) → full card restored (Oct 30 afternoon).

**3.4 Fix volume without a conversation-level measure.** 558 commits, 165 with fix-like titles, 320 with
a Claude co-author line (Codex commits carry no marker, so the agent share is higher), often several agents
in parallel (AGENTS.md records the same bug fixed twice).
The safety net was unit tests plus a gate that checks trip *selection* only. Nothing measured whether a
real conversation reached its goal, so changes that moved a failure from one branch to another kept
"passing".

**3.5 Test traffic in the production database.** 87% of stored conversation rows are scripted sessions
written to the same table as real customers. Every aggregate quoted before today mixed the two.

## 4. Current-code reproduction (live model, live catalogue, nothing sent to anyone)

Method: `tmp/forensic/live.test.ts` (scratch, not committed) runs the real webhook handler on a read-only
copy of the live catalogue with the live model. Database writes stay in memory, and every Meta send is
captured. The same 11 scenarios (35 customer turns) were run on `main` (58e9f0c) and on this branch. Full
transcripts and per-turn grades are in `docs/chatbot-conversation-quality.md`.

Confirmed on `main` and fixed on this branch:

| # | Defect | Customer impact | Code at fault |
|---|---|---|---|
| 1 | Weekly-schedule trips showed "📅 undefined/undefined" in lists | Every list with such a trip (live since 58e9f0c) | `formatTripListCard` formatted text as a date |
| 2 | A typed number under a list got the free-text model or silence | Picking a trip by number, which the list itself invites | `fastPathRouting.chose` passed the bare digit as the turn |
| 3 | After the phone, booking asked "Аль аялал вэ?" and wrote no lead until answered; the picked trip was lost | Booking leads lost or without context | `bookingCollectFlow` ignored the selected trip; `advanceCollectState` required a trip |
| 4 | A phone typed after a list was saved with no context | Staff got a number and nothing else | webhook phone capture wrote a fixed note |
| 5 | "2 хүүхэдтэй" printed a total over the children alone | A misleading family price | `tripAnswerPlan` totals |
| 6 | "Одоо 3 том хүн" dropped the child; the answer to the adult question dropped the children | Wrong totals after a correction | `mergeTripSelection` replaced the party, and ran twice per turn |
| 7 | A head count on a single-fare trip asked for the date, again on every change | No price ever given | `stableFarePreview` refused passengers |
| 8 | "11.1-с эхлэх", "11/14-с хойш" got silence or another trip; "сарын 1-ээс хойш" read as that day | School-break constraints unanswered | `travelDates.requestedDepartureScope`, routing filler words |
| 9 | "<place> биш, далайтай нь" got that very place's trip | Wrong trip | No negation handling |

Still open: preferences such as villa or resort and "send the programme" in a multi-constraint opening
(Oct 24 shape); see the backlog.

## 5. Sources and confidence

- Traffic segmentation: high confidence (identifier formats are unambiguous; the `demo:` prefix is written by
  `src/pages/api/demo.ts`).
- Historical root causes: medium. They come from code at HEAD and commit messages; the exact deployed commit
  per message is not recorded in conversation rows.
- Current reproduction: high for deterministic paths; medium where the live model decides (one run each).
- Meta-side greetings and un-ingested messages cannot be seen in the export.
