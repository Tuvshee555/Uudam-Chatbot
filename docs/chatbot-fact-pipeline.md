# Authoritative Trip Facts

## Request and Selection

`tripUnderstanding` interprets the full message once, including every requested
topic and explicit date, hotel, package and passenger age/count. Its catalog
keys are checked against real trip IDs. Code applies exact duration, transport
and calendar requirements; near matches are alternatives, not exact matches.

`fastPathRouting` retains an explicit selection in Redis for six hours, with a
bounded process fallback. A different trip resets date, hotel, package and
passenger context. Model failure can still use verified names, numbered
choices and narrowly recognized offer follow-ups. Greetings do not price an
old trip.

## Offers and Answers

`tripOffers` resolves one trip/date/hotel/package and each passenger fare.
Modern price groups override legacy groups, which override base summaries;
precise passenger bands override scalar compatibility summaries. Conflicts,
unknown fares and ambiguous age boundaries never become guessed totals.
Conditional discounts need confirmation; expired discounts do not apply.
Zero is free only when the data explicitly represents a free fare.

`tripAnswerPlan` builds factual sections and totals in code. Ordinary identical
fares across departures can be answered without asking for a date. Real
date/hotel/package differences ask for the missing selection. Availability is
per departure; a closed date does not close a different open departure.

Live webhook and demo both use `tripAnswerRuntime`. Weather comes from the
existing booking website report for the exact selected ID/date. Legacy and
model-generated replies pass the same final price/category/date/availability
verification. The exact canonical plan is trusted directly, including its
computed totals, rather than treated as an arbitrary model-generated amount.
Unsupported information follows the existing channel's staff-handoff policy.

## Database and Connected Outputs

Facts stay in the database, not in permanent customer-specific correction
rules. Trip saves audit both raw and normalized effective records, preserving
explicit years and rejecting newly introduced errors with field paths. An
unrelated edit on a legacy record is not blocked by pre-existing problems.

The connected poster retains explicit destination, transport and duration
metadata. Website projections consume canonical offers, keeping every scoped
hotel/package/age fare in metadata. Calendar summary prices come from one
whole cheapest offer, never an adult price from one hotel plus child prices
from another. Unknown/conflicting fares cannot become exact bookable prices.
Unknown availability stays unconfirmed; explicit open and closed departure
statuses are preserved. Staff website content-edit protections remain intact.

## Audits and Measurement

- `npm run audit:trip-facts -- --summary`: read-only catalog summary; exit 1
  means factual errors were found, not that an audit secretly repaired them.
- Authenticated `GET /api/admin/trips?action=fact-audit`: read-only full audit.
- `npm run qa:accuracy:fixture`: executes invented interpreter/planner cases.
- `npm run qa:accuracy -- <options>`: scores private captured outputs offline.

See `chatbot-accuracy.md` for six-metric review and capture requirements.
No automatic repair guesses an intended fare, year or inclusive age boundary.
Staff must confirm ambiguous source facts. Model understanding, provider
availability and external data can still fail; zero errors are not promised.
