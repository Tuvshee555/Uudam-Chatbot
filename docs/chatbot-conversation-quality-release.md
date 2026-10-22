# Conversation quality release

## Retained-history review and hardening

The review scanned all 24,155 retained conversation rows. Of these, 2,478 rows
belonged to 504 non-demo conversation keys; 21,677 rows belonged to demo
sessions. These populations must be reported separately. Stored assistant
messages, attachment-only rows, a last unanswered turn, and automated detector
flags do not establish customer delivery or an answer-quality percentage.
Flagged and recent conversations received focused review; this is not a claim
that every historical answer received a human rating.

Verified defects fixed in this release:

- A date-only follow-up after a destination list could be interpreted as a
  numbered choice or matched against an unrelated destination. The offered or
  selected trips now retain ownership of that date question. An unsupported
  date stays silent and creates a staff handoff.
- Named trip sections could borrow a sibling trip's fare or departure date,
  while a grouped date could leak into the next section. Verification now
  scopes these facts to the current section and checks direct-flight claims
  even when the trip is named on that line.
- Photo-only mode could create a missing-media handoff after successfully
  sending a brochure, require a PDF before offering a real website link, or
  record failed photos as sent. Successful content no longer creates a false
  handoff; accepted photos alone enter history, and complete send failure is
  retryable.
- A failed lead insert could be swallowed before pausing or confirming a
  handoff. Handoff and booking paths now require a persisted or existing open
  lead first. Booking state survives persistence and send failures, and a
  completed confirmation is retained when finishing a pause needs a retry.
  Unavailable exit grounding also retries rather than sending unchecked text.
- A phone bundled with a question no longer pauses the customer before their
  answer is successfully delivered. Explicit operator and phone-only requests
  retain their inbound history and use the shared response boundary.

The overview now reads actual schema fields instead of requesting a nonexistent
lead trip-name field and reporting database failure as a successful set of
zeros. It presents agency-local daily activity, unresolved CRM requests, recent
system issues, a staff-notification configuration warning, and recorded
questions. Demo sessions are excluded from customer activity. Core read failure
returns an unavailable response; optional sections remain explicitly unknown.
Refresh failure preserves the last snapshot with an error, and expired login
clears it. Booking requests are not labeled completed bookings, and recorded
replies are not labeled confirmed customer delivery.

The read-only catalog audit flags one archived, unpublished record whose two
source-documented starting-point options share a date without distinct package
IDs. Both adult/child fare pairs match the stored poster and its saved versions;
neither fare should be replaced or deleted. The options need explicit identity
before reactivation. Historical age/date warnings remain review findings; this
release does not overwrite live fares. Existing staff-notification configuration
also requires a recipient channel before external alerts can be delivered; the
Leads screen remains the durable queue.

Regression coverage includes signed webhook requests, failed persistence and
delivery followed by replay of the same event, grounding-read failure, scoped
date follow-ups, per-trip factual verification, photo outcomes, timezone
boundaries, absent analytics data, and authentication. The overview was also
checked on desktop and mobile with isolated invented data.

## What is enforced

- Shared response presentation for the live code/AI paths and demo. The prompt
  reads the same policy as the deterministic planner. One relevant emoji at
  most, no repeated greetings, and no routine phone request after an information
  question. A requested callback/booking can still ask once for contact details.
- Adult/child/infant unit-fare questions are separate from party-total questions.
  Code retains offer qualifications, age bands, ranges and totals. No arbitrary
  final-string truncation or second model rewrite of verified prices.
- Meal/ticket questions select relevant inclusion/exclusion facts. Deposit,
  visa, document and cancellation questions select the requested terms. Missing
  facts are never guessed. Existing silent staff handoff behavior is preserved.
- Compact date/hotel menus disclose remaining options. Explicit full-list and
  full day-by-day requests retain the full answer; compact programs prefer the
  published trip page. Dates respect the requested month/date range.
- Repeated customer questions receive the answer again. Event retry deduplication
  is independent of reply-text equality.
- Trip media require an explicit request. Default galleries use at most three
  photos, explicitly requested full galleries at most five. Clarifications and
  suppressed primary replies cannot trigger arbitrary media. Delivery history
  records successful photo sends, not attempted ones.
- Pending queues reject overflow without evicting accepted messages, retain a
  head until processing succeeds, and store no access token. Credentials are
  resolved from server configuration during processing. Event checkpoints and
  duplicate recovery avoid replaying a completed initial answer merely because
  a later queued message failed. Queue tests cover memory and mocked Redis.

## Measurement and review

`npm run qa:baseline` exports a private read-only seven-day conversation sample
to ignored `tmp/`. It neither sends messages nor calls the demo endpoint or a
model. Stored assistant rows do not prove successful customer delivery.

`npm run qa:quality -- --dataset <private-json> --replay <private-json> --labels
<private-json> --require-pass` evaluates saved evidence. Friendliness/helpfulness
require explicit human review. Missing review or execution telemetry stays
unreviewed, never an invented passing score. Optional reviewed dimensions cover
context, task completion, privacy and measured cost. See `chatbot-quality.md`.

The normal test suite covers the response policy and queue/media behavior. CI
also runs the deterministic interpreter/planner accuracy fixture. Its catalog
and injected model JSON are invented; passing is not a live-model benchmark.

Runtime diagnostics record generated reply characters/lines and generation
latency, plus transport/media attempt outcomes. API acceptance is not proof the
customer read a message. No raw customer text/identifier is used as a metric tag.

## Limits that must not be hidden

- The catalog audit still needs staff confirmation of ambiguous ages/fares.
  Code cannot discover the agency's intended values by guessing. This release
  does not rewrite live trip, website or poster pricing data.
- A representative baseline is not a scored before/after replay. Human-reviewed
  expected answers and held-out conversations remain necessary before claiming
  an accuracy, tone or booking-completion improvement percentage.
- Platform/page-scoped history migration and durable delivery bookkeeping are
  not part of this change. Existing raw-sender history compatibility needs a
  coordinated migration with the admin inbox and customer memory, not a local
  key rename. Network/crash windows can still prevent exactly-once delivery.
- Redis queues now retain unacknowledged jobs without an expiry. Operators must
  monitor depth/age; recovery occurs on webhook retries or subsequent traffic,
  not through a newly installed background scheduler. Legacy queues may retain
  their previous expiry until first updated. Memory queues are not durable
  across process restarts.
- New analytics data is minimized separately; private conversation history and
  previously stored analytics require an explicit retention/privacy review.
  No historical customer records are deleted by this release.
- No model swap, fine-tuning, new LLM, automatic GitHub editor or AI-generated
  permanent factual override was introduced.
