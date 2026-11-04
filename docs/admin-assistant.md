# Admin AI assistant — how it decides

The "AI туслах" tab is where staff change the catalogue by talking. Since 2026-11-04 a typed
instruction is understood in code first (`src/lib/assistantBrain.ts`) and only reaches the model
when the code does not know what to do. This is what makes it behave like a colleague who knows
the business, rather than a form that guesses.

## One instruction, one of four replies

`generateAssistantReply` (`src/lib/assistantReply.ts`) reads the whole catalogue (archived trips
included) and runs `think()`:

| Reply | When | What the admin sees |
| --- | --- | --- |
| **proposal** | the trip and the change are both exact | the proposal card: before → after, Save / Болих, rollback after saving |
| **ask** | the trip, the day or the amount is missing or shared by several trips | one question with tappable choices (trip names with their status and next departure, the trip's real departure days with their current state, or a free field for an amount) |
| **note** | nothing would change (the value is already so) | one plain line |
| **defer** | the words are not one of the known edits | the model is asked, with the owner's rules and the likely trips in full |

A tapped choice sends the original instruction back with a tag the server reads in code
(`[аялал: «name» trip_id=…]`, `[огноо: YYYY-MM-DD]`), so the model is never asked to interpret an
answer the admin already gave.

## What the brain understands

Mongolian and the usual Latin spellings. Trip names may be loose: aliases, Latin, a place word,
the last trip of the conversation ("бас 12/28-ийг…").

| Said | Done |
| --- | --- |
| «Trip» 12/27 дүүрсэн / цөөн суудал / нээ | that one departure day's state on the website and in the bot (`set_date_state`); the trip itself is untouched |
| «Trip» бүх өдөр дүүрсэн | every coming day; days already in that state are skipped and listed |
| «Trip» дүүрсэн (no day) | asks which day, offering the trip's real days and their current state, plus «Бүх өдөр» |
| том хүн 4,290,000 / хүүхэд 3,990,000 / нярай үнэгүй | base fares and every dated price row and passenger tier (`src/lib/tripFareChange.ts`); a row with two child age tiers is left for the editor and said so |
| хүүхэд 300k бага | child = adult − 300,000 |
| бүх үнэ +100k | every priced fare shifts; a free fare stays free |
| цуцал / түр зогсоо / идэвхжүүл | status; a trip already in that state is a note |
| устга / архивла | archive (`delete` action: hidden from the website and the bot, record kept, rollback restores it) |
| үлдсэн суудал 5 / нийт 30 суудал | seats |
| хоолгүй / хоол багтсан | meals |
| нэрийг «…» болго | rename; the old name stays as an alias so the bot still finds it |
| 12/30 гаралт нэм / 12/27-г хас | the day joins or leaves the trip's list and the price row of its nearest date (`src/lib/tripScheduleChange.ts`) |
| буудал: A эсвэл B | hotel |

Two trips that share the typed word (every «Хайнан» trip) are never decided by the customer
matcher's weights: a word that belongs to one trip alone, or a typed date that is a departure of
exactly one of them, decides; otherwise the assistant asks.

## The owner's rules

`src/lib/assistantHouseRules.ts` holds them in Mongolian; they go into every model prompt for a
typed instruction and are enforced in code where possible (`tripTransitDays.ts`,
`tripPriceRules.ts`, `tripFareChange.ts`, `tripCategorization.ts`). In short: a new trip is a new
record; prices are the source's tugrug selling price, never yuan or a "land" price, no +100k on
new trips; infant 0–23 months, child from 2; no invented dates; the standard Ulaanbaatar train
days for land, land+flight and cruise trips, none for a flight that already starts and ends in
Ulaanbaatar; hotels "A эсвэл B"; flight trips in the website's "шууд нислэгтэй аялал" category;
names in capitals with " – "; real credited photos on program days only; one day's seats are that
day's state, not the trip's; when unsure, ask with choices.

## Model proposals still get the same care

A model action that names its trip (`match`) is bound in code (`bindActionTargets`): one clear
trip gets the id; several become a structured question (`proposal.questions`) whose tap answers
it without another model call (`applyTripChoice` in `reviseAIRequest`). The model may use
`set_date_state` and `delete` and may return `questions` itself.

## Checks

```bash
node --import tsx --test tests/assistant-brain.test.ts tests/assistant-reply-route.test.ts tests/assistant-ask-ui.test.ts
npm run typecheck && npm run lint && npm test
```

Trip names in tests and this file are invented; never write a real trip, place or price into
code or docs.
