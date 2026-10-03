# Conversation quality release

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
