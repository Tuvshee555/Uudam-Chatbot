# Chatbot accuracy baseline

`scripts/chatbot-accuracy.ts` scores saved outputs offline. Its default scoring
path imports only the evaluation library and Node file reading. It never loads environment files,
connects to a database, calls an AI provider, invokes the webhook/demo endpoint,
or sends messages. Inputs are read-only; reports go to stdout. Package commands
are `npm run qa:accuracy -- <options>` and `npm run qa:accuracy:fixture`.

```powershell
node --import tsx scripts/chatbot-accuracy.ts --fixture
node --import tsx scripts/chatbot-accuracy.ts --fixture --split held_out --kind paraphrase
node --import tsx --test tests/chatbot-accuracy.test.ts
```

The built-in fixture contains invented travel questions and invented responses,
including deliberate failures and a provider outage. Its score tests the
evaluator, **not the current chatbot**. `--fixture-json` exports the invented
dataset/replay pair so the input format is inspectable. No real customer text,
identifiers, catalog exports or transcripts belong in committed fixtures.

## Metrics and denominators

All six metrics are independent. A turn can fail more than one. Each metric
reports `errors`, `evaluated`, `errorRate`, `notApplicable` and `unreviewed`.
Rates are fractions from 0 to 1, or `null` for an empty denominator.

| Metric | Reviewed error definition |
| --- | --- |
| `wrong_trip` | Selects or recommends a trip outside the acceptable labeled set. |
| `wrong_price` | Quotes a fare/total inconsistent with the frozen trip, date, passenger ages, currency or quantities. |
| `ignored_constraint` | Violates an explicit budget, destination, transport, date, duration or passenger requirement. |
| `incorrect_availability` | Makes an unsupported or incorrect departure/seat/booking-availability claim. Unknown seats are not confirmed seats. |
| `needless_clarification` | Asks for information already supplied by this conversation or unnecessary for the labeled answer. |
| `unanswered` | Leaves the requested information unanswered when an answer was expected, including empty output or unjustified handoff. Expected silence/handoff is not an error. |

`qualityScore = passed / scored`: a pass has no applicable metric failures.
All six metrics must be labeled or explicitly not applicable, and at least one
must be applicable, to include a turn in this denominator. Not-applicable
metrics never earn points. Partially labeled turns still contribute to known
per-metric counts but not the overall quality score.

`provider_failure` observations are excluded from all quality denominators and
reported separately. Use this status for a provider failure that prevents a
valid final output; a recovered retry with a valid answer is `ok`. Do not infer
provider failure from silence or customer-facing wording. Classify it from
captured execution evidence. A healthy silent response may be `unanswered`.
`harness_failure` also excludes the turn and makes `integrityValid` false.
Missing outputs and incomplete review are reported, never credited as passes.
Always report coverage and operational failures alongside quality.

`bySplit` and `byKind` give the same metrics for each subset. A conversation
passes only if every included turn is fully scored and passes. Group scoring
uses the same rule across paraphrase variants or related cases. Provider
failures therefore leave the conversation/group unscored. `--split` and
`--kind` select a subset; these aggregates refer only to the selected cases.

Exit codes: 0 means the inputs were scored, even if quality is poor; 1 means
harness failure or, with `--require-complete`, any missing, unreviewed or excluded
turn; 2 means invalid inputs/options. `--require-pass` additionally exits 1
unless every selected case is fully scored and passes. Empty quality
denominators produce `null`, never 100%.

## External Captures and Review

Keep private files outside the checkout (for example the allowed sibling
`../uudam-eval`) or in gitignored `tmp/`. The evaluator supports the following
versioned format; older replay formats need an explicit local conversion.
It does not execute a replay itself.

```typescript
type Dataset = {
  schemaVersion: 1;
  cases: Array<{
    id: string; groupId: string; conversationId: string; turn: number;
    split: "train" | "dev" | "held_out";
    kind: "single_turn" | "conversation" | "paraphrase";
    input: string;
    checks?: Partial<Record<Metric, Check | null>>;
  }>;
};
type Replay = {
  schemaVersion: 1;
  datasetDigest: string;
  provenance: "captured_replay";
  capture: {
    revision: string; // full 40-character Git SHA for the executed code
    asOf: string; // frozen evaluation clock, e.g. 2027-01-01T00:00:00.000Z
    catalogDigest: string; // SHA-256 of the frozen local catalog snapshot
    configurationDigest: string; // SHA-256 of nonsecret model/prompt settings
    sourceDigest?: string; // source fingerprint, including dirty code
  };
  observations: Array<{
    id: string; status: "ok" | "provider_failure" | "harness_failure";
    reply: string; action: "answer" | "clarify" | "handoff" | "silent";
  }>;
};
type Labels = {
  schemaVersion: 1; datasetDigest: string; replayDigest: string;
  reviewer: string;
  verdicts: Array<{ id: string; errors: Record<Metric, boolean | null> }>;
};
```

Here `Metric` is one of the six names above. In reviewed `errors`, `true` means
the error occurred, `false` means it did not, and `null` means not applicable.
Review each output against its full preceding conversation and frozen catalog.
Unreviewed turns should have no verdict row; do not mark uncertainty as false
or not applicable. Reviewed rows must explicitly label all six metrics.
Reports distinguish `reviewed_labels`, `explicit_checks` and `mixed` assessment
and count `reviewedTurns` and `explicitCheckTurns` among healthy observed turns.

Generate digests using exported `accuracyDigest(value)` from
`src/lib/chatbotAccuracy.ts`. It hashes canonical JSON with sorted object keys;
array order matters. The replay must bind the dataset digest, and labels must
bind both dataset and replay digests. Changed inputs, outputs, statuses or
capture metadata invalidate old labels. Capture metadata is an audit record,
not proof that the supplied runner actually froze its clock or used that code.
For a dirty checkout, first capture the exact executed source separately and
record its fingerprint in the nonsecret configuration artifact.

```powershell
node --import tsx scripts/chatbot-accuracy.ts --dataset ../uudam-eval/accuracy-dataset.json --replay ../uudam-eval/accuracy-replay.json --labels ../uudam-eval/accuracy-labels.json --split held_out --require-complete
```

The JSON report contains aggregates and fingerprints, without raw questions,
replies, reviewer names or case/conversation identifiers. Parse errors also
omit input values and paths. Redirect private reports only to private storage
or `tmp/`. The tool does not copy private files into the repository.

For invented deterministic checks, `Check` accepts `allOf`, `anyOf`, `noneOf`
nonempty string arrays and an expected `action`. Text matching normalizes NFKC,
case and whitespace. A failed check counts as that metric's error. A null check
means not applicable; an absent check means unreviewed. An empty check is
rejected. Reviewed verdicts override checks for that output. These marker
checks are deliberately simple oracles, not semantic judgments: quoting an
amount or trip name alone does not prove an answer correct. Use reviewed labels
for nuanced constraints, pricing, availability and justified clarification.

## Reproducible Evaluation Protocol

1. Freeze the catalog, evaluation clock, source revision and nonsecret provider
   settings locally. Keep customer transcripts and snapshots outside Git.
2. Assign splits before tuning. Keep every conversation and all paraphrases of
   the same scenario in one `groupId` and split. The parser rejects a group or
   conversation crossing splits, duplicate case IDs and duplicate turn numbers.
   Preserve all context turns, including unlabeled ones, in the capture runner.
3. Create invented single-turn, conversation and paraphrase cases for committed
   fixtures. Independently review local real-chat cases; avoid using held-out
   labels to design routing fixes. If existing cases already influenced fixes,
   label them `dev`, not held out. Structural split checks cannot establish that
   a human has never seen a case.
4. Capture actual bot outputs in an isolated runner with a disposable local
   database and fake sender IDs. Block customer delivery, staff notifications,
   payment writes and other outbound services before importing application
   modules. Do not point a demo/webhook runner at production. Provider calls,
   if used by a separate runner, require their own explicitly controlled setup.
5. Review the resulting outputs and bind labels to their hashes. Score the same
   artifacts twice; reports should be byte-identical. Compare actual captures
   only with matching dataset, catalog, clock and settings. Report each metric,
   coverage and provider/harness failures. A rerun of an AI provider can vary
   even with identical settings; saved-output scoring is deterministic.

## Historical Reviewed Scores (Read-Only Inspection, 2026-10-02)

The allowed sibling `../uudam-eval` has 212 labeled turns. Its saved
`*.score.json` artifacts report the following **legacy** trip/intent correctness:

| Saved run | Passed / labeled | Legacy percentage |
| --- | --- | --- |
| production | 172 / 212 | 81.1% |
| rules-only | 187 / 212 | 88.2% |
| understand-v1 | 168 / 212 | 79.2% |
| understand-v2 | 190 / 212 | 89.6% |
| understand-v3 | 199 / 212 | 93.9% |
| understand-v4 | 197 / 212 | 92.9% |
| understand-v5 | 198 / 212 | 93.4% |
| current-v1 (invalid capture) | 64 / 212 | 30.2% |

`current-v1.log` contains 1,207 occurrences of `ECONNRESET` or `Connection
terminated`; its scorecard marks 148 turns silent. It cannot establish chatbot
accuracy. The inspected rules-only and understand-v1 through v5 logs have no
occurrences of those two database error markers. That narrow check does not
establish provider health or make these controlled comparisons.

The production scorecard lists 11 `wrong_trip`, 8 `brought_up_wrong_trip`,
2 `needless_which_trip`, 1 `asked_despite_context`, 7 `silent`, 5 `invented_a_fit`,
3 `no_trip_named`, 1 `handed_off`, 1 `leak` and 1 `other`. These are legacy
verdicts, not a trustworthy conversion into the six independent new metrics.

`../uudam-eval/score.mjs` queries the current trip catalog and judges mostly
named-trip/intent behavior. Its price heuristic searches numbers in serialized
trip data and accepts multiples/sums; it excludes price findings from its
pass/fail score. All saved scorecards show zero price issues under that limited
heuristic. This does not establish zero wrong prices, constraint errors or
availability errors. Neither provider-failure exclusion nor held-out provenance
is represented by these saved scores.

The existing repo `replay-real-conversations.mjs` loads live conversations and
sends requests to a demo endpoint; `golden-questions.mjs` builds smoke questions
from the live catalog. Neither was run for this baseline. The sibling replay
uses a local clone and outbound interception, but its scorer still depends on
catalog data available when scoring. These tools are useful context, not
dependencies of this offline evaluator.

No new real-chat/provider replay or improvement was scored as part of this implementation.
The historical figures remain descriptive artifacts; new six-metric accuracy
requires an actual isolated capture and a review under the protocol above.

## Executed Invented Pipeline Baseline

```powershell
node --import tsx scripts/chatbot-accuracy.ts --pipeline-fixture --require-pass
node --import tsx scripts/chatbot-accuracy.ts --pipeline-json
```

`--pipeline-fixture` (also accepted as `--pipeline`) runs the current
`buildUnderstandingPrompt`, `interpretUnderstanding` and `buildTripAnswerPlan`
functions on an invented five-trip catalog, with the evaluation clock fixed to
`2026-10-02T04:00:00.000Z`. It scores their actual generated replies against
independent factual marker/action checks. It does not substitute expected
answers. A null answer plan is captured as a healthy silent output and scored
as unanswered when an answer was expected.

Model JSON is injected, so this evaluates the pure interpreter/planner segment,
including request parsing, requirement filtering, offer resolution and reply
rendering. It does not evaluate an AI model's natural-language understanding,
the stateful production router, final reply verification, weather providers,
webhook delivery or live catalog correctness. The adapter creates a route only
from the interpreted trip ID and carries the generated offer selection and
assistant reply forward in its local conversation. All runtime cases are
`dev`, not claimed to be independent held-out examples.

Replay provenance is `invented_pipeline`. Capture metadata includes the Git
revision, catalog/configuration hashes and a `sourceDigest` over the current
`src/lib` source, evaluator runner sources and package lock. This captures
dirty parent changes rather than relying only on HEAD. A source change during
capture or mutation of the invented catalog rejects the run. In a fresh process,
unchanged source and inputs produce identical reports. Provider calls, DB
connections and delivery functions are never invoked by this runner.

The ordinary external JSON scoring report stays aggregate-only. The runtime
fixture report additionally includes `caseResults` with invented questions,
actual replies, actions, pass/fail and metric errors. `--pipeline-json` exports
the invented dataset, generated observations and interpreter/planner traces;
those observations can be rescored through the same offline evaluator.
External input flags cannot be combined with either runtime mode.

Executed on 2026-10-02: **10/10 cases passed**, with complete coverage, zero
provider/harness failures, and these applicable metric counts:

| Metric | Errors / evaluated |
| --- | --- |
| wrong_trip | 0 / 10 |
| wrong_price | 0 / 8 |
| ignored_constraint | 0 / 7 |
| incorrect_availability | 0 / 3 |
| needless_clarification | 0 / 10 |
| unanswered | 0 / 10 |

| Executed case | Observed result | Verdict |
| --- | --- | --- |
| direct-multi-topic | Dec 17; adult 1,200,000, child 900,000; 8 days; direct flight; seats remain unconfirmed | Pass |
| duration-narrows-model-picks | Interpreter retains only the 8-day trip and drops an unknown model key; planner quotes its fares | Pass |
| transport-narrows-model-picks | Interpreter retains the direct-flight trip over the land trip; planner states direct transport | Pass |
| date-hotel-passenger-total | Dec 20, Nerith House B; adult 3,000,000 x 2 + child 2,000,000 = 8,000,000 | Pass |
| closed-departure | Dec 22 departure is sold out; no bookable fare offered | Pass |
| unknown-seats | Dec 23 is scheduled; seat count deferred to an adviser | Pass |
| conversation-offer | Generated selection retains Dec 20 and Nerith House B | Pass |
| conversation-total | Follow-up supplies passengers only; retained date/hotel yields 8,000,000 without another selection question | Pass |
| fare-paraphrase-latin | Injected model pick leads to actual adult 1,200,000 / child 900,000 response | Pass |
| fare-paraphrase-cyrillic | Same actual fare response for the alternate invented phrasing | Pass |

This is an executed deterministic component baseline on invented cases, not a
100% customer-accuracy claim or evidence of a production improvement.

## Integration Verification

The intermediate date-routing, solo-fare, legacy passenger-tier and website
projection failures were repaired during integration. Calendar-routing tests
freeze their evaluation clock rather than depending on the machine's current
month. Existing solo fares and legacy tiers remain covered; new canonical
offer tests also cover years, hotels, packages, age bands and discounts.

Run `npm run typecheck`, `npm run lint`, `npm run test` and `npm run build`
against the final checkout. Synthetic component checks and a successful build
do not substitute for an isolated, reviewed real-chat replay.
