# Offline conversation quality

This separate evaluator scores saved artifacts. It imports only Node crypto/file
reading and its own library: no environment loading, DB, provider, webhook,
production router or customer delivery. No package scripts were added.

```powershell
node --import tsx scripts/chatbot-quality.ts --fixture
node --import tsx scripts/chatbot-quality.ts --fixture-json
node --import tsx scripts/chatbot-quality.ts --dataset ../uudam-eval/quality-dataset.json --replay ../uudam-eval/quality-replay.json --labels ../uudam-eval/quality-labels.json --require-pass
node --import tsx --test tests/chatbot-quality.test.ts
npm run typecheck
```

The fixture questions, replies and annotations are entirely invented and include
deliberate failures. It tests this evaluator, not current chatbot quality. It
contains no human ratings, so `--fixture --require-pass` fails closed. Only
`--fixture-json` exports text, and it always exports the built-in invented pair;
it cannot be combined with external inputs.

## Concise private schema

The exported TypeScript types in `src/lib/chatbotQuality.ts` are authoritative.
All objects reject unknown fields; IDs must be unique within each artifact.

```typescript
type Dataset = {
  schemaVersion: 1;
  humanRequired: boolean; // explicit; use true for overall conversation quality
  cases: { id: string; input: string; request: "simple" | "detailed" }[];
};
type Replay = {
  schemaVersion: 1;
  datasetDigest: string;
  provenance: "invented_fixture" | "captured_replay";
  observations: {
    id: string;
    status: "ok" | "provider_failure" | "harness_failure";
    reply: string; // concatenate final customer-visible text messages in order
    latencyMs: number | null;
    unsolicitedMedia: number | null;
    delivery: "delivered" | "failed" | "unknown";
    annotations?: {
      repeatedContent?: boolean | null;
      irrelevantContent?: boolean | null;
    };
  }[];
};
type Labels = {
  schemaVersion: 1; datasetDigest: string; replayDigest: string;
  reviewer: string;
  ratings: {
    id: string; friendliness: number | null; helpfulness: number | null;
    reviewedErrors?: {
      cost?: boolean | null; privacy?: boolean | null;
      taskCompletion?: boolean | null; context?: boolean | null;
    };
  }[];
};
```

Keep private artifacts outside Git. Use `qualityDigest(value)` to hash canonical
JSON: object key order does not matter; array order does. Replay binds the entire
dataset; labels bind both entire dataset and replay. Any change to questions,
request class, human requirement, outputs, telemetry or annotations invalidates
old reviews. Unknown observation IDs and reviews without healthy observations
are rejected. Digests protect artifact consistency, not authenticity of a
capture or the identity of a human reviewer. This CLI never captures a bot run.

Classify simple versus detailed requests before scoring, using the full request
and preceding context. Preserve that context in private `input` for reviewers.
Record telemetry from execution evidence. Use `null` for unavailable latency or
media counts and `unknown` for unverified delivery, rather than inventing zeros.
Latency measures elapsed time from receiving the request to completing customer
delivery, including retries. Count each unsolicited attachment/image/video in the
final delivery; explicitly requested or expected media does not contribute.
For example, a welcome campaign may classify its expected attachment explicitly
in the private capture evidence and supply zero unsolicited items. The evaluator
does not infer that exemption from reply wording or campaign names. A recovered
provider retry with a valid final answer is `ok`; an outage preventing a valid
answer is `provider_failure`. Capture/tooling errors are `harness_failure`.
Use `failed` delivery for an actual unsuccessful final send.

## Metrics and review

| Metric | Failure rule |
| --- | --- |
| `length` | More than 500 Unicode code points for simple, 2000 for detailed. |
| `lines` | More than 6 physical lines for simple, 24 for detailed. |
| `repeatedContent` | Explicit annotation says unnecessary repeated material occurred. |
| `irrelevantContent` | Explicit annotation says unrelated material occurred. |
| `unsolicitedMedia` | Any unsolicited media item (allowance is zero). |
| `latency` | More than 10000 ms. |
| `delivery` | Execution evidence records final delivery failed. |

Budgets are fixed, inclusive thresholds, emitted as `policy` with an evaluator
version. Code points include whitespace; no trimming or language-dependent word
tokenizer is used. CRLF, LF and CR each separate physical lines; a trailing
separator adds a line, empty text has zero lines. This measures saved text, not
visual wrapping. Empty delivered replies are not automatically helpful; that
requires review. These budgets are an initial policy, not universal norms.

Repetition/relevance are scored only when annotated, never inferred through
semantic heuristics. `true` means an error, `false` explicitly means no error,
`null` explicitly means not applicable, and absence means unreviewed. Annotators
must compare the response to the complete preceding conversation: useful
confirmation is not needless repetition, and relevant advice is not unrelated
content. Keep uncertain flags absent; do not turn uncertainty into false/null.

Friendliness and helpfulness are **human ratings only**, integers 1 through 5.
A reviewer must inspect the final output in context and explicitly supply each
rating. A null or absent row remains unreviewed; null never means not applicable.
Use 1 for very poor, 2 poor, 3 mixed/adequate, 4 good, 5 excellent. Friendliness
covers respectful, warm, appropriately toned wording; helpfulness covers whether
the reply advances the user's request with usable information. Ratings >=4 pass.
No heuristic, fixture or missing review can claim either quality automatically.
`humanAssessment: supplied_explicit_review` means labels were supplied, not that
all ratings are complete; consult `humanRatings` coverage for each dimension.

With `humanRequired: false`, overall scoring covers objective metrics and any
supplied optional reviewed errors;
optional human ratings are still reported separately. Do not present that score
as reviewed friendliness/helpfulness. With `true`, both ratings must be reviewed
before a turn enters the overall score. Labels never override objective failures.

Optional `reviewedErrors` use the same explicit error convention: true is a
reviewed failure, false a reviewed pass, null explicitly not applicable, and
absence unreviewed. The `reviewedChecks` aggregates always show coverage, even
when no checks were supplied. Supplied failures block an overall pass even with
`humanRequired: false`; omitted optional checks do not require review or earn
credit. These checks never substitute for required friendliness/helpfulness.

| Reviewed dimension | Evidence the human must inspect |
| --- | --- |
| `cost` | Measured execution cost including retries versus a predefined budget, with currency and scope explicit in private evidence. |
| `privacy` | Disclosure or use of private information beyond the intended recipient/task authorization. |
| `taskCompletion` | Whether the requested result/action was completed, or a justified necessary next step was given. |
| `context` | Whether prior selections, constraints and already supplied information were retained and used correctly. |

These are reviewed error flags, not inferred subjective scores. Preserve their
supporting evidence in the digest-bound private dataset input/replay before
review. The compact schema does not capture provider usage, prices, numeric cost
totals or billing records automatically; no cost measurement or budget compliance
is claimed without the explicit review. Nor does a text-only capture prove an
external action completed or that all privacy-sensitive logs were inspected.
Leave a dimension unreviewed when its supporting evidence is unavailable.

## Aggregates and exits

Reports contain counts, rates, fixed policy and fingerprints only: no questions,
replies, IDs, reviewer names, paths or per-case rows. CLI errors also omit all
input values and paths, including JSON parser messages. Inputs are read-only;
only stdout/stderr are written. Store reports privately as well.

Each metric reports errors/evaluated, an error rate (fraction or null with zero
denominator), unreviewed and not-applicable counts. N/a never earns credit.
`qualityScore = passed / scored`; a scored turn has every required metric known,
and a pass has no failures. Partially reviewed healthy turns still contribute
known per-metric results, but cannot pass or enter the
overall score. `failed` counts fully scored failures only.
`observedFailures` counts each case once if it has a known required/optional
review failure or a provider, harness or delivery failure, even with incomplete
review. Missing observations are reported separately, not as observed failures.

`qualityCoverage = scored / total`. Missing observations, provider failures,
harness failures and delivery failures have separate counts and never enter the
quality denominator. Delivery's own metric includes healthy observations with
failed sends so operational errors stay visible; other metrics/human ratings
exclude failed sends. `unreviewed` counts remaining healthy turns with incomplete
required evidence. `complete` requires every dataset case scored. A harness
failure makes `integrityValid` false. Always read coverage and operational
failures alongside quality; a 100% score at low coverage is not a full pass.

Exit 0 means valid scoring, even with poor/incomplete results. Exit 1 means a
harness failure, or incomplete coverage with `--require-complete`, or any
incomplete/failed case with `--require-pass`. Required but missing human review
therefore fails `--require-pass`. Every provider, harness or failed delivery also
blocks `--require-pass`, regardless of supplied passing ratings or quality
coverage. Exit 2 means invalid inputs/options, including
stale digest bindings. All modes are offline. Saved-artifact scoring is
deterministic; no real conversations were captured or evaluated by this change.
