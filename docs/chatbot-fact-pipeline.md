# Authoritative Trip Facts

## Request and Selection

`tripUnderstanding` proposes an interpretation. A valid catalog ID proves only
that a trip exists. `customerTripEvidence` first derives the permitted scope
from the customer's current name/link, an offered menu, a prior selection, or
the customer's recent concrete trip question. A generic assistant greeting or
a model-produced place/ID cannot grant scope. A current explicit destination
replaces old scope; a shared destination retains all matching alternatives.

`buildTripRequest` reconciles that proposal with independently parsed current
dates, windows, duration, transport, hotel and passenger age/count before
candidate validation or selection persistence. Explicit customer values win;
unspoken model options cannot become stored customer choices. Code applies
exact requirements; near matches are alternatives, not exact matches.

`fastPathRouting` retains an explicit selection in Redis for six hours, with a
bounded process fallback. A different trip resets date, hotel, package and
passenger context. Model failure can still use verified names, numbered
choices and narrowly recognized offer follow-ups. Greetings do not price an
old trip. A numeric answer to the immediately preceding trip menu retains the
original customer's question and constraints, so choosing a trip does not lose
the price or passenger question that caused the menu.

## Offers and Answers

`tripOffers` resolves one trip/date/hotel/package and each passenger fare.
Modern price groups override legacy groups, which override base summaries;
precise passenger bands override scalar compatibility summaries. Conflicts,
unknown fares and ambiguous age boundaries never become guessed totals.
Conditional discounts need confirmation; expired discounts do not apply.
Zero is free only when the data explicitly represents a free fare.

`tripAnswerPlan` builds factual sections and totals in code. It records required
topic and source-field coverage in `missingTopics` and `missingFacts`. A known
price cannot hide an unanswered inclusion, booking term, seat question or
unavailable weather report. Missing required facts produce a terminal handoff
plan without media. Known exclusions and explicit closed departures remain
valid factual answers; missing data never means a negative fact.

Required inclusion items, booking term keys and passenger fare categories are
kept separate from display preferences. Asking for full details can expand the
display, but cannot erase a requested subquestion or let another fare stand in
for an unknown requested category. Completeness checks always use the required
targets, even when presentation shows all known information.

`requestedFacts` preserves evidence-backed subquestions that broad topics cannot
answer. Hotel connectivity, facilities, room properties, location and rating
are separate requirements; the current catalog has no typed source for them, so
they hand off. Bounded extraction also catches these property families when the
model omits the subquestion, excluding words inside trip/hotel proper names.
Other unsupported subquestions depend on model extraction and are not claimed
to be exhaustively detected.

Ordinary identical
fares across departures can be answered without asking for a date. Real
date/hotel/package differences ask for the missing selection. Availability is
per departure; a closed date does not close a different open departure.

Live webhook and demo both use `tripAnswerRuntime` and `decideTripAnswer`.
They consume its explicit answered/clarify/handoff outcome instead of deriving
the outcome again from refusal phrases in the generated text. Weather comes from the
existing booking website report for the exact selected ID/date. Legacy and
model-generated replies pass the same final price/category/date/availability
verification. A canonical plan's computed totals use field coverage and a
matching selected trip ID, rather than a global approved-text escape.

The webhook freezes grounding evidence before routing. A fresh routed or stored
model selection cannot authorize its own answer. Current explicit identity
overrides stale history at the exit, and bullet formatting or multiple named
trips grants no permission. Deterministic catalog builders pass their result IDs
explicitly when they offer alternatives. Every production fast-path reply still
leaves through `deliverFastPathReply`.

Unsupported production questions create a durable staff lead, pause the bot and
send no customer reply. The demo displays its existing handoff explanation.
Delivery/persistence failures remain retryable. Realtime staff notification
requires an independently configured channel; storing a lead does not prove a
staff notification was sent.

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
- `npm run qa:conversations`: runs actual signed webhook conversations with
  persistent mocked SQL/history, real selection state, hostile model proposals
  and final prose, plus actual demo/webhook parity and delivery/persistence
  failure tests. All provider
  and messaging transports are mocked; unexpected network destinations fail.
- `npm run qa:accuracy -- <options>`: scores private captured outputs offline.

See `chatbot-accuracy.md` for six-metric review and capture requirements.
Both offline gates also run in `prebuild`, before Next.js compilation. A failed
gate stops `npm run build`, so the deployment build checks these contracts
before publishing. The live-catalog replay gate remains a separate read-only
review because it needs private database access and human decision review.
No automatic repair guesses an intended fare, year or inclusive age boundary.
Staff must confirm ambiguous source facts. Model understanding, provider
availability and external data can still fail; zero errors are not promised.

`webhook.trip_answer_decision` and suppressed-answer events are retained in the
existing bounded log store. Decision records include source, outcome, missing
field keys and a catalog fingerprint without customer message text. Logs carry
the deployment commit when the host provides a valid Git SHA. This separates a
new regression from an older retained conversation or an older deployment.
