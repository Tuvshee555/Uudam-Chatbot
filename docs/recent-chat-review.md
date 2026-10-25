# Recent customer-chat review

## Evidence and scope

The review read the complete stored user/assistant history in a rolling 72-hour
window: **33 customer conversations, 146 rows**. A separate **13 demo conversations,
38 rows** were excluded from customer findings. Earlier context was loaded for
recent customers when available. The review also inspected 112 persisted diagnostic
records, five new leads, and the current catalog.

These are stored rows, not unique inbound events or confirmed customer delivery.
Some repeated inbound rows were retries. Messages omitted by the old paused-chat
path cannot be reconstructed from the database. Private transcripts, catalog
exports and detailed diagnostics remain in ignored `tmp/`, outside Git.

## Findings addressed

- **Replies failed repeatedly at the delivery boundary.** There were 39 recorded
  Messenger text-length rejections across two customer conversations. Verified
  long answers now travel as ordered messages within the transport limit, with
  every source character retained. Buttons attach to the last part. Event-scoped
  receipts resume an interrupted unchanged reply after its accepted prefix;
  a new customer event can request the same answer again. Redis receipts survive
  reconnects, and unavailable receipt storage fails before sending a prefix.
- **Requested dates disappeared from destination lists.** Routing and list
  presentation now share month, range and alternative-day constraints. Filters
  run before display limits. A fully named trip cannot be replaced by a sibling
  merely because the sibling departs on the requested day. Unavailable or
  unsupported calendar constraints produce a silent staff handoff. An unknown
  new destination cannot borrow the previous trip just because its month fits.
- **Passenger follow-ups discarded the selected month.** Selection retains the
  calendar scope across passenger and hotel turns; a newly supplied exact date
  replaces it. Date menus are no longer printed twice in one answer.
- **Package and total pricing could mix incompatible offers.** Documented package
  labels constrain hotel choices and fare cards. Party totals use canonical
  departure, package and age-specific fares, and require the choices needed to
  establish a total. Stale scalar summaries cannot override dated source fares.
- **A request to start from a city was treated as a destination request.** The
  schema has no authoritative itinerary-origin field. Such requests now hand off
  silently instead of offering tours that merely visit that city.
- **Configured replies bypassed the shared answer boundary.** Contact, quick-info,
  legacy, graph and booking-collection text replies now pass through the shared
  delivery boundary. Booking history records the delivered presentation once;
  a withheld completion cannot be marked confirmed, and send failures remain
  retryable.
  Configured trip facts are verified against the catalog. A withheld graph reply
  also stops later text, media, actions and AI continuation.
- **Staff could lose follow-up evidence while the bot was paused.** Customer text
  and attachment links are retained before pause checks, with failed storage
  remaining retryable. Automated extraction and replies remain paused.
  Reengagement contact messages also respect customer, page and staff pauses.
- **Business contact requests unnecessarily collected customer phone numbers.**
  They now return the saved business contact facts. Missing saved contact facts
  result in a silent handoff.

## Verification

Invented-data regressions exercise signed webhook requests, interrupted multipart
sends and event replay, Redis receipts, paused-chat persistence, configured
wrong-trip/wrong-fare replies, calendar scope, package choices and canonical totals.
Validation passed: **1,392 tests**, TypeScript, ESLint, the production build,
the deterministic accuracy/conversation build gates, and the required historical
conversation gate. ESLint reported five pre-existing warnings outside this
change; the changed implementation and new tests passed scoped lint without
warnings.

The historical gate reviewed 1,047 distinct retained questions against its saved
baseline. All 43 printed decision changes were inspected; these include catalog
status changes since the older baseline. Its trip-less checks selected no trip,
and its generated catalog answers passed factual verification. Historical
grounding flags are review signals, not measured new-system accuracy.

## Remaining operational limits

- Five leads were persisted while realtime staff notifications had no configured
  recipient channel. The admin Leads inbox remains the durable queue. Enabling
  external alerts requires the intended staff recipient configuration.
- This review made no live model calls or customer sends, and did not rewrite
  catalog facts. Passing fixtures do not establish a live-model accuracy rate.
- Multipart receipts resume an unchanged answer. Regenerating a different answer,
  receipt expiry, or a crash between provider acceptance and receipt persistence
  can still cause repeated text. In-memory receipts do not survive process exit.
- Historical missing messages and past delivery failures are not repaired by
  changing code. API acceptance does not establish that a customer read a reply.
