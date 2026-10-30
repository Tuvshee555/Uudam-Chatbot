# Chatbot follow-ups (prioritised)

Open customer-experience failures confirmed by conversation replay. Each one stays open, and visible in
the test suite where possible, until a journey proves it fixed. Evidence: `docs/chatbot-forensic-audit.md`,
`docs/chatbot-conversation-quality.md`.

## P0-1 — OpenAI balance exhausted — RESTORED; safeguards on branch `fix/ai-billing-safeguards`
From about 07:43 UTC on 2026-10-30, every OpenAI call failed with 429 `credits_exhausted` (production logs
tagged f441aaf). Deterministic paths still answered; every AI-dependent turn ended in silence plus a staff
lead. Live replays run on the same key that day helped drain it. The balance was restored by 08:02 UTC
(Messenger webhook AI calls succeeded again; one controlled demo test at 08:09 succeeded on all models).
**Safeguards:** mocked CI, opted-in and capped evaluation runs (one at a time, never against the
production site), spend tracking per environment with a daily budget alert, an outage notice to the
customer instead of silence, immediate staff alerts on billing/key failures. The owner chose to keep one
OpenAI key for production and testing.
**Optional, not required:** a real-time staff channel (`STAFF_NOTIFY_PSIDS` or Telegram) so alerts are
pushed, not only shown in admin.

## P1-0 — Latin-script month words — FIXED (deployed 2026-10-30)
Production 2026-10-30: "<place> aylal neg sariin eheer sonirhoj bb" (early January, Latin script) got
December dates; "neg sard" got silence. Months written as Latin number words (neg, hoyor, gurav …) were
not read, and "neg" counted as a possible new destination. The fix reads them like digits and names a trip
new to the conversation. Journey `a month written as a Latin number word…` fails without it.

## P1-1 — Multi-constraint family opening (Oct 24 shape) — FIXED (2026-10-30)

**Now.** One trip named: the reply names it, gives the departures in the asked window (or, when
none, says so and gives the nearest three), the fares for the children, the programme, the hotel
names the data holds, then asks the one missing fact (how many adults). "6 болон 2 насны" ages and
"хавьцаа/орчим" (a week either side) are read. Villa/resort is never inferred: the reply says the
preference went to an advisor and a staff lead carries it (the line is dropped if the lead fails).
A list (no trip named) is answered the same way once the customer picks a trip. Live replay of the
real Oct 24 message and three related shapes: every part answered, 0 fact issues. Journeys: `a
family's multi-part opening…`, `a month asked right after a 'not then' list…` (both fail without
the fix). Also fixed: two children at one fare printed as one "x 1" line while the total counted both.
**Still not possible:** answering villa/resort from data (no lodging-type field; add one to the trip
schema and admin if the owner wants it answered automatically). Several trips named with no departure
in the window still get only "not then, these depart on …".

**Conversation shape.** First message: a family with children of given ages, a flexible date ("around
<month> <day>"), a destination, a lodging preference (villa / resort) and "send the programme if you have
one".

**Behaviour before the fix (live replay, production ad89535).** The reply says no departure on that date,
lists the destination's other departure dates and writes a staff lead. The children's ages, the
lodging preference and the programme request are ignored. No wrong fact is stated.

**Impact.** Typical of high-value family enquiries. The customer has to ask again or wait for staff,
and the bot looks inattentive, which is the pattern behind customers dropping off.

**Root cause.**
1. One opening message carries several requests, but the reply pipeline picks one branch (the
   date-availability answer) and returns.
2. The catalogue has no structured lodging-type field, so villa/resort cannot be answered from data.
3. The programme request is only served when it is the main topic.

**Proposed fix (in order).**
1. Answer every supported part in one reply: departures nearest the requested date (before and after),
   the fares for the stated party (children by age), and the programme link or PDF when one exists.
2. For lodging type, say plainly what the data holds (the trip's hotel name and stars) without
   inferring villa/resort, and add the preference to the staff lead.
3. Add a lodging-type field to the trip schema and admin, if the owner wants it answered automatically.

**Done when.** The `test.todo` in `tests/conversation-journeys.test.ts` becomes a passing journey,
`npm run qa:live` includes the shape (`family_opening_multi_constraint`) with every constraint addressed,
and there are 0 fact issues.

## P1-2 — Booked customer's follow-up gets silence — FIXED (2026-10-30)
**Root cause.** After a booking with a phone the bot pauses itself for 3 days (`booked_customer`), and
every paused message was stored and dropped: no reply, and nothing on the lead, so with no alert channel
nobody saw it. Before 661c6bd (2026-10-25) paused messages were not even stored.
**Now.** The bot's own booking pause: one reply built from the lead record (request received, trip,
masked phone, what staff marked: not yet contacted / called without answer / handling), never a
confirmation or a call time; later messages are only recorded. A consultant's pause (manual, or a staff
reply seen in the thread): no bot message. In both cases the question is appended to the customer's
lead, which goes back to unread in the Leads tab (staff are pinged when a channel is configured).
Journeys: `booking intent then a phone…`, `a booked customer hears what staff recorded…`, `during a human
takeover…`.
**Since 2026-10-30 (takeover rebuild, Facebook).** A customer waiting for a consultant keeps getting
answers: a status question gets the lead's status (a repeat gets one "nothing new" line, then nothing),
any other question is answered as usual and added to the lead. Only a consultant silences the bot
(P1-5). Instagram has no thread check, so it keeps the behaviour above.

## P1-5 — The bot talked over consultants replying from a computer — FIXED (2026-10-30)
**Evidence (production threads of 60 customers, takeover diagnostics).** A consultant on the phone app
is tagged `source:mobile` (341 messages). The bot, a consultant in Business Suite on a computer and
Meta's automations are all `source:web`, so the old rule (only `source:mobile` counts) never saw a
desktop consultant. Meta's `message_echoes` webhook would say who sent each message, but the page token
holds only `pages_messaging` and `public_profile`: no `pages_manage_metadata`, so the app cannot keep that
subscription (echoes stopped after 2026-08-01). The token's data access expired 2026-09-10.
**Now (`staffTakeover.ts`).** The bot records the id Meta returns for every message it sends
(`travel_outbound_messages`). In the thread, its own messages are known by that id (or by a reply it
stored at that moment); `source:mobile` is a consultant; any other `source:web` Page message is a consultant
on a computer, except Meta's automations and inbox notices (within 20 s of the customer, or a notice
text). Messages from before the ids were recorded count as before. A consultant's message silences the
bot for three days from that message. A thread that cannot be read (timeout, permission, API error,
incomplete) is never taken as "no consultant": where staff may own the conversation (a consultant replied
in the last week, an assigned lead, an open request from the last three days) the message waits for
staff on the lead; anyone else is answered as usual. The Leads tab has "Би хариулна" (stop the bot for this
customer) and "Ботод буцаах" (hand it back). Graph calls use one version (v25.0, what Meta was already
serving for the pinned v19.0).
Journeys: `tests/staff-takeover-journeys.test.ts` (14 cases; 2, 9, 10–12 and 14 fail without the fix).
**Owner action for the strongest signal.** Reconnect the Page to the Meta app with `pages_manage_metadata`
and subscribe the app to `messages` and `message_echoes` (POST `/api/subscribe-feed`); echoes then name the
sending app on every Page message.

## P1-3 — Test traffic in the production conversation table — OPEN
`demo:` sessions (87% of rows) are written beside real customers. Flag them or store them separately, so
every metric uses real traffic.

## P1-4 — "Universal bagtsan vne" answered without the price — FIXED (2026-10-30)
**Root cause.** With the model available the request is read correctly (live replay: all six phrasings,
also after another Beijing tour, give the Universal trip's fares, 0 fact issues). Without it (the credit
outage) the keyword reader decides, and it took "vne" (ү typed as v) for no price word and let
"bagtsan"/"included" drop the price topic, so only the inclusions were sent.
**Now.** "vne" reads as үнэ and "<feature> багтсан/included үнэ/price" asks the price. Journey `a price
asked by the attraction a trip includes…` runs each phrasing with the model and with it unavailable.

## P2-1 — Fare question under a fresh multi-trip list — OPEN
"хүүхдийн үнэ" ("child price?") right after a new list gets "Аль аялал вэ?" instead of the child fare of the
listed trips.

## P2-2 — Website chat endpoint answers weakly — OPEN (to investigate)
`/api/demo` (the website chat) answered "Бээжин" and "Бээжин үнэ" with a generic question during the
2026-10-30 smoke check, while Messenger lists the trips. Its pipeline differs from the webhook.

## P2-3 — Look-alike destinations — OPEN
Fuzzy matching can take a destination one letter away for another. Needs a data-side "not this place"
field, not code.

## P2-4 — Inbound messages missing from the conversation table — FIXED (2026-10-30)
**Evidence (production, read-only).** Five real customers had messages counted but none stored. Four
wrote while paused, before paused messages were stored (fixed 661c6bd). One question was delivered 31
times on 2026-10-10 and failed every time: never stored, answered or seen. On 2026-10-24, 39 replies over
2,000 characters were rejected by Meta and redelivered in a loop (long replies are split since).
Runtime logs are kept 1 hour on this plan, so none of it could be explained afterwards.
**Now.** Persisted, privacy-safe trail in `travel_error_logs` (7 days; admin error-log view):
`webhook.inbound_received` (every delivery, retries included), `webhook.inbound_duplicate`,
`webhook.get_started_silent`, `webhook.inbound_outcome` (answered / silent with reason / stored without
reply / failed with reason and attempt, plus route, stored, sent), `webhook.send.primary_failed`, and
`webhook.inbound_preserved_after_failures`. Ids are hashed (`senderHash`, `eventKeyHash`); no text or
phone. After 6 failed attempts of one message it is stored once, staff get a lead, and the event is
accepted so the loop ends; a failed attempt that sent nothing removes the copy it wrote.
**Reading it.** No `inbound_received` → Meta never delivered it. `inbound_duplicate` → a redelivery
skipped. `inbound_outcome` status `silent` → a deliberate rule (the reason says which). `failed` with
reason `delivery_failed:*` → Meta refused the reply; any other reason → processing failed.

## P2-5 — Test rows in the production database — OPEN
`travel_page_control` holds rows for fixture pages ("fixture-page", "1234567890", "000000000000000",
updated as late as 2026-10-30): some test or script run used the production database. Find the run and
point it at a fixture database.
