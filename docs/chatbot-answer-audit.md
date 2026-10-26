# Chatbot question and answer audit

## Evidence

The read-only export covered all retained conversation rows at the start of this
review. After excluding demo/test conversation identifiers, it contained **558
customer conversations, 1,458 user rows and 1,254 assistant rows**. Demo/test
conversations were excluded from customer findings. Current catalog facts and
166 retained diagnostics were also inspected.

An offline pass checked every retained customer assistant row for trip grounding
and factual-verification signals. Recent flagged conversations and additional
recent conversations were read in context; this was not a manual rating of every
historical sentence. Current catalog comparisons can flag facts that changed
after a historical answer, and blank assistant rows can represent attachments.
Neither is automatically a customer-facing failure. Private transcripts and
detailed audit output remain in ignored `tmp/`, outside Git.

## Verified flaws fixed

- **Trip choice discarded the question.** Named numbered buttons now preserve
  the pending question's month and requested facts. A destination supplied after
  a calendar-only request retains that calendar constraint. A new date replaces
  the old one.
- **An ordinal follow-up repeated the selected trip.** A request for another
  displayed option's program resolves against the actual recent menu rows, with
  the same evidence checked at delivery. Missing/deleted entries, duplicate
  titles, numbering gaps and out-of-range indices cannot shift another trip into
  the requested slot. Calendar months and itinerary days are not menu ordinals;
  explicit trip names and shared trip links keep their precedence.
- **Category lists ignored exact departure dates.** Shared calendar constraints
  filter trips before display limits and filter the printed departure dates.
  Exact-date fares use that departure's canonical offer. Unsupported or missing
  requested departures hand off silently.
- **A valid catalog answer could be rejected against an empty router scope.**
  Deterministic catalog replies are verified against the canonical trips their
  builder explicitly listed, while model replies retain their conversation scope.
- **Age follow-ups lost or duplicated travelers.** Ages refine existing child or
  infant slots without discarding accompanying adults. Partial ages preserve
  unfilled slots. Explicit adult ages do not fill child slots. Invalid or
  ambiguous counts/ages hand off instead of pricing numeric suffixes or reusing
  an old party. Infant ages cannot become calendar months. Short Latin spellings
  of a month-end request retain their date window.
- **Fact checks mixed trips and packages.** Source-text exemptions and booking
  topics are checked within the named trip section. Fares and supplements respect
  package scope. Free/zero/small fares are checked, and an incorrect party total
  is rejected even if it equals a legitimate unit fare.
- **Reply cleanup damaged useful content.** URL paths and signatures survive
  formatting cleanup, including distinct case-sensitive links. Greeting removal
  keeps paragraphs containing facts. Repetition-preface cleanup keeps the answer
  and its conditions.
- **Reengagement text bypassed verification.** Editable returning-customer text
  now uses the shared delivery boundary. Wrong-trip or stale-fare text creates a
  durable handoff and preserves the inbound question. Accepted text is recorded
  in history; withheld text does not increment the sent counter.

## Verification and limits

Invented-data regressions cover the shared libraries and signed webhook turns,
including menu switching, calendar retention, accepted delivery and silent durable
handoff. Validation passed: **1,429 tests**, TypeScript, ESLint, production build,
deterministic accuracy/conversation gates and the required read-only historical
gate. ESLint reported five existing warnings in unchanged files; changed source
and regression tests passed scoped lint. The build used inert provider
credentials with customer databases disabled.

The historical gate printed 46 changes against its older saved baseline; each
was inspected. Those same changes were already present before this patch and
include current catalog status changes. Trip-less checks selected no trip, and
the catalog's generated answers passed the gate's factual checks. The baseline
was not accepted or rewritten. These results are not a historical accuracy rate.

No live model replay or customer sends were performed. These checks establish
the covered behavior, not a live-model accuracy percentage or a guarantee that
every future answer is flawless. Historical replies were not rewritten.

Retained diagnostics still report missing realtime staff-alert recipients. Leads
remain durable in the admin inbox; external alerts require the owner's intended
recipient configuration. This review does not invent that configuration.
