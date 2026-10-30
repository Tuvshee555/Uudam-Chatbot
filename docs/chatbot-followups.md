# Chatbot follow-ups (prioritised)

Open customer-experience failures confirmed by conversation replay. Each one stays open, and visible in
the test suite where possible, until a journey proves it fixed. Evidence: `docs/chatbot-forensic-audit.md`,
`docs/chatbot-conversation-quality.md`.

## P0-1 — OpenAI balance exhausted — OPEN (owner action)
Since about 07:43 UTC on 2026-10-30, every OpenAI call fails with 429 `credits_exhausted` (production logs
tagged f441aaf). Deterministic paths still answer: lists, cards, number picks, booking with phone, family
pricing on keyword routing. Every AI-dependent turn ends in silence plus a staff lead on Messenger, and in
"passed to an advisor" on the website chat. Live replays run on the same key that day helped drain it.
**Fix:** top up the OpenAI balance and add a low-balance alert. Replays now require a separate
`LIVE_REPLAY_OPENAI_API_KEY`.

## P1-0 — Latin-script month words — FIX READY (branch `fix/latin-month-words`, awaiting approval)
Production 2026-10-30: "<place> aylal neg sariin eheer sonirhoj bb" (early January, Latin script) got
December dates; "neg sard" got silence. Months written as Latin number words (neg, hoyor, gurav …) were
not read, and "neg" counted as a possible new destination. The fix reads them like digits and names a trip
new to the conversation. Journey `a month written as a Latin number word…` fails without it.

## P1-1 — Multi-constraint family opening (Oct 24 shape) — OPEN

**Conversation shape.** First message: a family with children of given ages, a flexible date ("around
<month> <day>"), a destination, a lodging preference (villa / resort) and "send the programme if you have
one".

**Current behaviour (live replay, production ad89535).** The reply says no departure on that date,
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

## P1-2 — Booked customer's follow-up gets silence — OPEN
After a booking request the customer belongs to staff, so a question such as "хэзээ холбогдох вэ" ("when
will you contact me?") gets no reply, and staff alerts have no delivery channel. Configure an alert channel,
or send one short acknowledgement per booked customer.

## P1-3 — Test traffic in the production conversation table — OPEN
`demo:` sessions (87% of rows) are written beside real customers. Flag them or store them separately, so
every metric uses real traffic.

## P1-4 — "Universal bagtsan vne" answered without the price — RECHECK after P0-1
Earlier on 2026-10-30 the reply carried the fares and inclusions. Later runs (production and branch code
alike) gave the inclusions only. Those runs coincided with the exhausted model balance, so recheck once
credit is restored before treating this as a code defect.

## P2-1 — Fare question under a fresh multi-trip list — OPEN
"хүүхдийн үнэ" ("child price?") right after a new list gets "Аль аялал вэ?" instead of the child fare of the
listed trips.

## P2-2 — Website chat endpoint answers weakly — OPEN (to investigate)
`/api/demo` (the website chat) answered "Бээжин" and "Бээжин үнэ" with a generic question during the
2026-10-30 smoke check, while Messenger lists the trips. Its pipeline differs from the webhook.

## P2-3 — Look-alike destinations — OPEN
Fuzzy matching can take a destination one letter away for another. Needs a data-side "not this place"
field, not code.

## P2-4 — Un-ingested inbound messages — OPEN
A message absent from the database cannot be diagnosed. Log every inbound event ID before routing.
