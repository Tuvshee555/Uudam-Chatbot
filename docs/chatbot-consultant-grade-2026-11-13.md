# Consultant-grade date handling and root-cause repair (2026-11-13)

Status: **owner approved on 2026-11-13; committed and pushed to `main` (Vercel deploys on push).** Real customer text, the
thread export and the per-conversation review live outside the repo (`uudam-eval/audit-1113/`, public repo rule).

## 1. What was asked

The owner: stop fixing single messages; find why the same classes of basic mistake keep happening; make the bot behave
like a good consultant (when the asked date does not exist, offer the nearest real ones; keep the customer's other
requirements); learn from how human consultants answer, safely; keep the bot honest (no data, no answer).

## 2. Evidence

- **962 real customer conversations** (13 Sep to 13 Nov, Messenger, read from Meta's Page inbox so consultant and bot
  messages are both present; demo/test traffic excluded) were read in full by 23 reviewers, with 1,726 bot replies
  judged. 224 conversations were bot-only, 190 staff-only, 470 bot then staff.
- **Failure rate per 100 bot replies** (reviewers are models with uneven strictness; indicative, not a precise rate):
  13-30 Sep 39.6, 1-15 Oct 39.7, 16 Oct-2 Nov 32.3, 3-10 Nov 35.1, after the 11-11 17:04 release 39.6 (53 replies only).
  High and critical severity stays near 12 per 100. **The bot is not measurably better than in September**, although
  individual classes were fixed. The worst class in September (talking over a consultant) did fall after the
  10-31 consultant takeover.
- 5 read-only code investigations (wrong-topic classes, date handling, memory and learning, git history, website vs
  database), each with probes on the live catalogue. Reports: `uudam-eval/audit-1113/code-reports/`.
- Deployment mapping used Vercel's deployment list and `deploymentRevision` in `travel_error_logs`, not commit times.

## 2b. What the human consultants do (553 labelled practices; playbook outside the repo)

- **Best at unavailable dates**, the exact thing the owner asked for: a plain one-line "no", then the nearest real departures on
  both sides with price and seat state; they keep the customer's fixed constraint and vary the other axis; "full" is said as
  "full", not "no departure". This is now what the bot does for a date miss and a rejected date.
- Also strong: ask "when and how many" once; age bands per child; group intake for companies and classes; one follow-up that
  carries a new real fact; stop selling when the customer chose elsewhere; state terms before the deposit.
- **Humans are not perfect**: when staff answered first, the median first reply took 15 minutes but 33% waited over an hour; 59%
  of first replies held no readable answer (a link, greeting, voice note or image); 16% of staff messages are voice, which the
  bot cannot see; 18% of handoff or phone leads show no staff message afterwards (calls are not logged, so an upper bound).
- **Every sale evidenced in chat (about 27) was closed by a human.** The bot's contribution is the first minutes and the lead.
  Money levers (discounts, price locks, extra seats, contracts, documents) stay with staff; the bot hands them off.
- **Training**: fine-tuning is not justified (148 usable customer-to-consultant text pairs; 28% of consultant output is voice;
  the data teaches answering outside the catalogue, against the no-data rule). Order: playbook behaviours (58 testable
  `HB-nn`, 44 code / 10 prompt / 4 human) -> evaluation journeys -> dated, labelled consultant turns in the memory merge
  -> curated, de-identified exemplars retrieved by situation. Historical answers never override current prices or dates.
- **"The bot nearly sold while I slept"**: most likely one midnight chat where the customer pressed the order button after the
  bot confirmed date and price, then went quiet before leaving a phone. No sale is verified in any candidate. Two such night
  chats created **no lead** (a lead needs name and phone together), so staff learned of them 14-20 hours later. A naive
  "interest lead" would block the later phone lead (leads are deduplicated per kind), so this needs an owner decision.

## 3. Root causes (all reproduced; invented shapes in the journeys)

| # | Cause | Where | Class of failure it explains |
|---|---|---|---|
| 1 | A month and day typed `M,D` were not a date | `travelDates.ts` | a dated ask silently lost its date |
| 2 | The resolver's last line returned the best-scoring trip as "verified"; any extra word beside a shared city counted as a route word, so the ambiguity test was skipped (35 of 182 real city-plus-filler messages, 19%) | `travelFastPathsSearch.ts` | one trip answered for a city with several |
| 3 | A failed requirement ("by land?") was checked only against the trip on screen and reported as "none in this direction" | `tripUnderstanding.ts` | false negative claims |
| 4 | "Not then" replies listed each trip's soonest dates and never looked at the asked date | `travelFastPathsPricing.ts` | "no" with no useful alternative |
| 5 | Nothing recognised a rejected date; the same dates came back, or "system down" when the model was out | routing | a customer pushed away by the bot |
| 6 | The ended-trip notice ran before the open catalogue and matched one shared word | `travelFastPathsProgram.ts` | 18 of 44 live trip names answered "inactive" about another trip |
| 7 | A travel mode ("by land") counted as an unknown place when an ended trip's text held it | `placeCoverage.ts`, `placeLikeTokens.ts` | silence on every "<city> by land" question |
| 8 | Family ages typed with spaces dropped; "12 3 around" not a date | `tripRequest.ts`, `travelDates.ts` | the family's price was never given |

**Why the same mistakes keep returning** (git: 322 commits since 13 Sep): the same behaviour is decided in several
places and each fix closed one. At least 18 mechanisms decide "which trip", 19 templates say "none available", and 4
readers parse dates and disagree on the same spelling. Identity fixes per week have not fallen (2, 1, 3, 3, 5, 2, 1, 4,
7). The resolver line behind the 11-13 failure was named as a root cause on 10-02 and 10-06 and was never changed.
The suite passed throughout because assertions are single sentences, mocked models supplied the date the code is meant
to read, and invented catalogues give sibling trips names of equal length (which makes the near-tie check catch them).

## 4. What changed

- `travelDates.ts`: comma date (with unit guards: amounts, ages, counts, decimals are never dates); spaced month-day
  beside an "around" word; Latin "havitsa".
- `travelFastPathsSearch.ts`: only words some trip's name or alias holds can tell trips apart; a bare number and the
  postposition "руу" are neutral; the month-day matcher uses the one shared date parser.
- `tripIdentity.ts` + `tripUnderstanding.ts`: `directionTripsNamedIn`; an unmet requirement is re-checked on the
  customer's direction (this message, else the latest earlier one) and says plainly that such trips exist.
- `travelModeWords.ts` (new, leaf): one list of travel-mode words, shared by identity, unknown-place and place-coverage checks.
- `dateAlternatives.ts` (new): the real, bookable departures closest to the asked date or window, nearest first,
  labelled by distance; radius for wording `DATE_ALTERNATIVE_RADIUS_DAYS` (default 7); only close dates when any exist.
- `dateRejection.ts` (new): "date does not suit me" / "other date?" / "a bit earlier" / "later": drops the rejected date,
  offers the nearest other departures of the same kind in the same direction, no model call; when every other departure was
  already shown, or none exists, it is silence plus a typed staff lead (no data, no answer). A customer a consultant
  wrote to within 30 days is sold no other dates (silence plus a typed lead), as for date misses.
- `travelFastPathsProgram.ts` + both handlers: the ended-trip notice fires only when the open catalogue finds nothing.
- `tripRequest.ts`: space-separated ages read when their number equals the children counted; Latin "tom" after a count.
- `webhook.ts` and `demo.ts`: both handlers carry the date-rejection branch (demo parity); `scripts/conversation-gate.mjs`
  runs the three new test files so a broken journey blocks a deploy.

## 5. Results (all free: mocked model, no OpenAI call)

- New journeys, each failing on the old code: `destination-alternatives-journeys` (13), `archived-notice-journeys` (6),
  `customer-number-formats` (3), `review-fixes-journeys` (7). All four files run in the conversation gate. Two were mutation-checked (a test fails when its fix is removed); one regression guard
  (`a cancelled or full departure ...`) passes without the `dateIsOnSale` line because the harness path already strips closed
  dates, so that line is defence for the data shapes the audit found, not something the test isolates.
- **Real-catalogue measurement** (read-only snapshot, 54 shared place words x 12 neutral extra words = 648 probes):
  collapses to a single guessed trip **216 -> 17**; the 17 left are `<date> <city>` resolving to the one trip that departs that day.
  Ended-trip notice about another trip: **18 of 50 live trip names -> 0**.
- **Real-traffic regression replay** (2,121 distinct real customer messages of the last 60 days, one catalogue snapshot,
  production code vs this code, no AI, `uudam-eval/audit-1113/replay-decisions.mjs`): 52 resolver decisions change (2.5%):
  30 single guessed trip -> "which one?", 16 list -> a different list, 5 question -> one trip (all read: 3 of them the same
  single trip or a correct narrowing such as "direct" -> the direct-flight trip), 1 single trip -> a different single trip
  (the intended Beijing fix). 10 date/party parses change, all improvements (e.g. "10,31 нд ... 8 хүн" was unread; "4 tom hvn"
  was empty). The replay caught a flaw in an intermediate version of the route-word filter (short filler words matched inside
  longer name words and collapsed a long family message to one trip); it is fixed and has a journey.
- **Before/after conversations** on one invented catalogue, production vs this code (`uudam-eval/audit-1113/ba-OLD.txt`,
  `ba-NEW.txt`): the Beijing shape (city 3 trips -> the trip that departs that day; "ground trip?" no longer denied; a rejected
  date no longer repeated), a date with no departure (silence -> the 3 nearest real dates, nearest first, 1 day before, 2 and 5
  after), "<city> by land" (silence -> the answer), an open trip's name typed in full (wrongly "inactive" -> its card), a
  family's ages typed with spaces (ages read), "around" a date typed with a space (read). The first version of the
  date-rejection reply listed a date as "0 days after" and, when every other departure was already shown, fell through to the
  model; both found by this comparison and fixed (nothing real to offer is now silence plus a staff lead).
- **Independent adversarial review** of the whole change set (3 lenses: correctness, customer-facing Mongolian copy, impact on
  callers; each finding then reproduced or refuted by a separate skeptic, with the same probe run on production code):
  30 findings, **26 confirmed, 4 refuted**; 10 of the confirmed were regressions against production. All the high and medium
  ones are fixed and tested: the inflected word "аялалд" ("on the trip") made a shared city collapse to one guessed trip; the
  rejection detector took "next departure?", conditionals, refund questions and times of day for rejections; a rejection that
  names its date ("2/19 тохирохгүй") was answered by confirming that date as open; the focus trip's own next date was then
  answered "no departure"; a second "another date?" re-offered the first; a "ground trip on <date>" reply listed a flight;
  "1" under the nearest-dates reply meant the first trip in catalogue order, not the first shown; an ended trip typed in full
  got its open sibling's card; "2 сарын 3,10" produced a phantom March 10; two journeys passed without the guard they named.
  Left open on purpose (low): a typo in the one distinguishing place word makes a single-trip answer a question (safer, not
  wrong); a return date inside a price label mis-narrows "<city> 1 сарын 3" (exists in production); the "no trip" opening
  line is worded company-wide though it checks the trips in scope; a longer price question about an ended trip is answered
  with its open sibling's card by the earlier answer-plan step.
- `npx tsc --noEmit`: clean. `npm run qa:conversations`: 634 tests, 0 fail, 3 todo (before: 605 with the same 3 todo).
  Full `npm test`: 3,156 tests, 0 fail, 3 todo.
- **Pre-push standards (owner's AGENTS.md), run once on the final code:**
  - `npm run qa:live` (live catalogue read-only, real model, nothing sent): 14 journeys, 50 turns, **0 fact issues**, 2 silent
    turns (both `human_takeover`, silent by design); 57 model calls, about **$0.16**. One run only.
  - `npm run gate` (read-only, no AI): exit 0; trip-less sentences that picked a trip **0/25**; the bot's own answers rejected
    by its checker **0/305**; 203 real-message decisions differ from the stale 11-04 baseline (about 184 were already
    catalogue drift on 11-12; the replay above isolates this change: 48). The baseline was NOT re-saved (`--save` needs the
    drift judged; do it separately).
- Not measured: the 207-case benchmark (`uudam-eval/audit-1113/synthesis/benchmark.json`, 64 unseen paraphrases) has no
  automatic judge; its invented-data version (`benchmark-shapes.md`) is the source for the next round of journeys.

## 6. Still open (priority order)

1. **Staff-owned chats and hand-back.** Consultant text never reaches the bot's history; only 2 conversations were ever
   released with «Ботод буцаах» while 294 are held until released, so a released customer would meet a bot that
   contradicts what staff settled. Needs a dated "consultant said, not current data" line in the memory merge.
2. **One negative-claim checker** for the 19 "none available" templates (scope = the claim's own wording).
3. **One date reader** that also returns date-like text it could not read, so an unread date can never become a
   single-trip answer or a "no departure" claim.
4. **Stale seats**: the bot said a date was open that staff called full the next day; the sync of per-date availability.
5. Guide/transport-only wishes ("хөтөч" read as "хот") asked for a city five times; catalogue codes typed as `A/02`
   mapped to the wrong trip; the identical sold-out text sent to different questions; a Page greeting read as a consultant
   message silenced the bot for one customer; "I don't know this" notices that left no lead.
6. **Data (client, admin):** transport type on 5 trips; a trip whose own dates are all cancelled shows an empty schedule
   while price cards sell website-only dates; one trip sells a date with no price; sold-out dates answered "no departure"
   instead of "full". See `code-reports/website-db-consistency.md`.
7. ~~Mimic Myself is ON with a tone pool that is about 40% URLs and dates.~~ Turned OFF on 2026-11-13 (see 9).

## 7. Owner decisions

1. ~~Approve a push to `main` (it deploys).~~ Approved and pushed on 2026-11-13 (a930229).
2. ~~Mimic Myself: off, or digit/URL-filtered.~~ Off (owner left the call to us; see 9).
3. Whether a customer a consultant wrote to within 30 days is also sold nearest dates (today: no, silence plus lead).
4. Radius for "close" dates (default 7 days either side; `DATE_ALTERNATIVE_RADIUS_DAYS`).

## 8. Deploy and rollback

Deployed by pushing `main`; the Vercel prebuild runs preflight, the accuracy fixture and the conversation gate. Watch
`webhook.date_alternatives_total`, `webhook.date_not_scheduled_total` and `travel_error_logs` (`webhook.inbound_outcome`
silent reasons `no_data:date_alternatives_none`, `no_data:date_alternatives`) for 48 h; read the first real conversations
that hit the new replies. Rollback: `git revert` the commit and push, or promote the previous deployment in Vercel.
`DATE_ALTERNATIVE_RADIUS_DAYS` is the only new switch; the date-rejection branch has no flag (revert to remove it).

## 9. Follow-up the same day (owner: "you decide")

- **Mimic Myself: OFF in production** (`travel_bot_settings.extra.mimic_myself_enabled = false`; the other settings
  were kept; settings are read per message, so it applied to the next one). Its example pool taught the bot to copy
  links and dates from old chats, which is exactly the stale-fact failure this work removes.
- **"Interest" lead when a customer presses «Захиалах» but gives no phone: not built.** The Leads tab is not read
  (461 leads, none opened), the follow-up of 2026-11-12 already asks for the phone, and one durable lead per kind
  means an early interest lead would block the later lead that carries the phone. Revisit only with a separate lead
  kind and an admin view staff actually use.
- **Decision-gate baseline re-saved** after reading its differences. Reading them found one more bug class, fixed in
  the next commit: ordinary words in client-written trip titles picked that trip. The deployed code answered 22 real
  plain greetings ("Өдрийн мэнд", "Оройн мэнд") as the one checkup trip whose title holds "мэндийн", "боломжгүй /
  боломжтой" as the trip whose title holds "боломжын", and "the full programme" as the "бүтэн биеийн" trip. The words
  are now generic route words. On 2,121 real messages: 55 decisions change, all read (34 one-trip guesses and 16 lists
  become "no trip", 5 Hainan lists lose the unrelated rows). Tried and rejected: "a lone negative-score match is no
  trip" (it dropped 14 correct romanised picks).
- Checks for that commit: tsc clean; `npm test` 3,158 tests, 0 failed; `qa:conversations` 636, 0 failed; `npm run
  gate` 0/25 trip-less picks, 0/305 own answers rejected; `qa:live` once: 14 journeys, 50 turns, 0 fact issues,
  61 calls, about $0.15.
- First 27 minutes on production after a930229: no customer messages arrived (0 outcomes, 0 errors), so the new
  replies are not yet proven on real traffic.
