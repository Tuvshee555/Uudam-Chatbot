# Admin AI assistant ("AI туслах")

The "AI туслах" tab is where staff change the catalogue by talking. Since 2026-11-06 a typed
instruction goes to an agent (`src/lib/assistantAgent/`): the model looks trips up with read-only
tools, keeps every part of a message, reads pasted links, and ends with **one** of three replies.
Nothing it does is saved until the admin presses Save on the card, and every save can be undone.

## What it can do

Write the way you would tell a colleague, in Cyrillic or Latin-script Mongolian, several things in
one message. Trip names below are placeholders.

| Said | Card shows |
| --- | --- |
| «Аялал А» 12/2 дүүрсэн · цөөн суудалтай · нээ · энэ өдрийг түр хаа | that one departure day's state (`set_date_state`: full / low / open / paused) |
| «Аялал А» 12/2-ны үнийг 100 мянгаар нэм · 12/9 том хүн 2,590,000 болго | that one date's price, per passenger, before → after (`set_date_price`); other dates untouched; the poster's price table follows |
| бүх аяллын үнийг 100,000-аар нэм | one change per trip (`fare_change_all`); partner and non-tugrik trips are listed as skipped |
| «Аялал А» хүүхэд 300 мянгаар бага | child = adult − 300,000 |
| a-g idvehgui bolgooch · сайтаас нуу · харагдах болго | hide / show on the website and in the bot (`set_visibility`) — not archive |
| 3-р өдрийн хөтөлбөрийг «Чөлөөт өдөр» болго · 2-р өдрийн буудал … | that one program day only (`patch_itinerary_day`); the rest of the program stays |
| хүүхдийн насыг 2-11 болго · нярай 0-23 сар | age bands (`set_age_bands`) |
| photo attached + «3-р өдрийн зургийг энэ зургаар соль» · «2-р зургийг хас» | the exact photo swapped or removed (`replace_photo`), with both thumbnails |
| uudamtravel.mn trip link + «устга» | archive of the linked trip only (`delete` = archive, undoable) |
| partner / other website link + «манайд нэм» | the page is read and becomes the usual new-trip review card |
| 1/15, 1/22 гаралт нэм · 11/18-ыг хас | departure dates added or removed (a day already past is left out and said) |
| program file + ««Аялал А»-гийн хөтөлбөрийг энэ файлаар шинэчил» | only what the file really changed: a day's hotel, a sentence added to a day; the saved wording stays |
| price list file + «энэ жагсаалтыг «Аялал А», «Аялал Б» аялалд нэмэлт мэдээлэл болгож нэм» | one section added to each trip's description (`append_notes`); the card can unfold every line |
| schedule photo + ««Аялал В»-г сэргээ: том хүн …, хүүхэд …» | an archived trip live again: the coming dates, the typed fares, the age band, status |

When anything is not certain — which trip, which date, which photo, how much — it asks one
question with buttons (or asks you to type the amount). A typed answer while a question is open is
sent with that question (`answer_to`), so "12/2" or "5,590,000" is read as the answer. It never
guesses a trip, price, date, hotel or photo; a yuan / "land" price is never a selling price.

## On the page

- **Photos.** The agent gets an attachment only as a link — it can swap or remove a trip's photo
  with it, but cannot read what is in it. So images go to the agent (put on our Cloudinary first,
  `/api/admin/upload-image`, max 6) only for an explicit photo edit: a photo word (зураг, фото,
  photo) together with what to do (соль/солих, хас, replace, remove) or which photo (нүүр зураг,
  «3-р өдрийн», «2-р зураг», эхний зураг), and no reading words. Reading words — шинэ аялал,
  аялал нэм/үүсгэ, үнэ, прайс, жагсаалт, хүснэгт, постер, хөтөлбөр, огноо, унш — keep the file →
  trip reader, which reads the image («энэ зургаас шинэ аялал үүсгэ», «энэ зурган дээрх үнээр
  шинэчил»). Documents (PDF, Word, Excel, zip), images with no words, and anything unsure keep the
  file reader too (`isPhotoInstruction` in `assistantChatLogic.ts`).
- **Progress.** While the agent works the thread shows «Ойлгож байна…», «Аяллыг шалгаж байна…»,
  «Холбоосыг уншиж байна…» (when there is a link). Under each reply a small line says how it was
  made («AI туслах · аялал хайсан · аяллыг шалгасан», or «Энгийн горим» when the model was not
  available and the code-side brain read one change only).
- **The card** says every change in plain Mongolian (date + passenger for a price, «Сайтаас нуух»,
  «3-р өдөр …», age bands, photo before → after). Refused parts, plan warnings, skipped trips and
  fare notes are listed plainly under «Анхаарах» / «Алгассан аялал» / «Туслахын тэмдэглэл».
- **Save** waits up to 200 s (the route runs up to 180 s; many trips save one after another). Save
  is locked from the moment the request goes out until a definite answer (`saveLockedUntil`, kept
  with the thread). With no answer the card says, in amber and tagged «Тодорхойгүй», that it is
  unknown whether the change was saved — never «Хадгалагдсангүй», which is only for a refusal that
  left nothing saved — and Save stays off until the server has certainly stopped (the card says
  until when); pressing it again then reports «Өмнө нь хадгалагдсан байна» instead of saving twice.
  A proposal with no stored request is never saved again after an unknown outcome (check
  «Аяллууд», send the instruction again if needed). A proposal older than 24 hours is refused
  (409 `proposal_expired`) with a plain message and a «Дахин илгээх» button.
- **The conversation** keeps its session id and visible thread in `sessionStorage`, so a reload
  keeps both (for 6 hours, like the server's memory of the last 12 turns). «Шинэ яриа» starts over.
  A card whose save was still running at the reload comes back as «Тодорхойгүй» with Save off
  until the server has certainly stopped — the reload cannot send the same proposal a second time.

Code: `src/components/admin/useAssistantChat.ts` (send / answer / photos / thread),
`assistantChatLogic.ts` (pure rules), `ProposalCard.tsx` with `actionView` in
`src/lib/adminProposalUtils.ts` (card lines from `describeChange`), `useProposalActions.ts` +
`applyOutcome` in `src/lib/adminProposalApply.ts` (save / undo).

## Files about trips already saved (2026-11-21)

Until this date every document became a NEW trip. Now a file sent with words about a saved trip
goes to the agent as text (rule 13 of the prompt), and the agent proposes exact edits of that trip.

- **Which words.** A restore («сэргээ», «идэвхжүүл»), added information («нэмэлт мэдээлэл»,
  «тайлбарт нэм», «… аялалд … нэм»), «одоо байгаа / хадгалсан аялал», a named program
  («хөтөлбөрийг шинэчил»), or a plain «шинэчил» with a document and no price word
  (`isSavedTripInstruction` in `assistantChatLogic.ts`). «Шинэ аялал болгон нэм», a bare file, a
  photo with «үнийг шинэчил» and a price list keep the file reader, as before. A same-name note on
  a new-trip card says how to update the saved trip instead.
- **How the file is read.** Each file goes to `POST /api/admin/file-text` and comes back as plain
  text: Word (.docx and the old .doc, read on the server by `word-extractor`), Excel (one line per
  row), PDF, text; a picture is transcribed by one vision call. At most 6 files, 24,000 characters
  each. The text is fenced as data in the agent's message; a file gives no orders.
- **An updated program.** The agent reads the file's days and calls `compare_program`; the code
  (`assistantAgent/programCompare.ts`) works out what differs: each day's hotel, sentences one
  side has and the other lacks, meals. A changed hotel and an added sentence are proposed; meals
  the file states differently are only said on the card. A day patch that throws the saved wording
  away is refused (`rewritesSavedDay`) unless the admin wrote «бүхэлд нь соль».
- **Extra information.** `append_notes {trip_ids, heading, text}` adds one named section to each
  trip's description and keeps the rest (`tripNotesAppend.ts`); saved again under the same heading
  it replaces that section. Every number in it must stand in the admin's message, in a file or in
  a description he opened. The website shows a section headed «Нэмэлт шинжилгээ – хүсвэл нэмж
  хийх зүйлс (…)» as its own «Нэмэлт» tab of a check-up trip.
- **Two saved trips with one name.** The search shows each one's length and why an archived one
  left; the one whose length the admin said is meant, else the only live one, else he is asked
  (`twinProblem` in `assistantAgent/actions.ts`).
- **The answer to a question about a file** (typed or tapped) carries the file's text again.

The new-trip reader also learned three things that day: a price, date or name typed beside the
file is evidence and wins over the file (it used to be deleted as "not in the file"); «галт
тэрэгтэй» in the note replaces a partner's "by bus back to Ulaanbaatar" with the standard train
return (`withoutBusReturn`); and a theme line plus a route line make the name together.

## Several files at once: taking stock, then one dialog of questions (2026-11-22)

The owner wanted the assistant to work like Claude did by hand on 2026-11-21: understand every
file first, ask every open decision at once — a tab per question, each choice with what it does,
one recommended, «Өөр» to type his own answer — and then do all of it.

- **When.** Two or more documents, a single document the page found to look like a saved trip, or
  «…энэ файлаар шинэчил» with no trip named (`intakeNeeded` in `assistantAgent/intake.ts`). Not
  when he only says the files are a new trip, asks a question about a file, or answers a question.
- **take_stock.** Before it may ask or propose, the model says what every file is: `saved_program`,
  `new_trip`, `schedule`, `extra_info` or `other`, with its trip. The answer is checked in code
  (`stockProblems`): every file once, a program compared first, the trip whose name shares the most
  of the file's title words (then the same number of days, then the live one), a schedule on the
  same trip as its program, a list for the trips of the programs sent with it. Wrong → sent back
  (the third answer is taken). The real package of 2026-11-21 went from 3 files on the wrong trip
  to all 5 right.
- **must_ask.** The code then names the decisions that are the admin's alone (`mustAsk`): update a
  saved trip or add another (also when he wrote «шинэчил» but the trip is live and unnamed — "this
  trip is already on the site"), a new trip's selling price when the file has only yuan, the
  transport when a program starts at the border or comes back by bus, how to show a priced list,
  and a price remark that reads two ways. The model asks them in ONE `ask_user {questions[]}`; any
  it leaves out are added in the system's own words, and a model that proposes instead is sent
  back twice, then the system asks itself.
- **Same choices every time.** Update/new, selling price («Ноорог болгож хадгалах» or type the
  price — never "publish without a price", which save refuses), transport («Стандарт галт тэрэгний
  өдрүүд» recommended / «Файлд бичсэнээр»), a priced list («Үнэтэй нь жагсаах» recommended /
  «Зөвхөн нэрсийг» / «Нэмэхгүй») are written by `fixedChoices`; a price remark keeps the model's
  readings plus «Одоохондоо хөндөхгүй».
- **His answers.** The page shows the dialog (`AssistantAskDialog.tsx`) and sends all answers in
  one message with the stock-taking echoed back (`answer_to.intake`). The next turn reads them as
  decisions (`decisionsOf`), opens the trips straight away and gets the work per file
  (`todoLines`). Its proposal is checked (`proposalGaps`): every saved program compared, an archived
  trip he wants live gets its status, a coming date, a price and the child band the schedule
  writes, a priced list keeps every row. Missing parts are sent back, then said on the card.
- **New trips** among the files are handed to the new-trip reader by the system itself, each with
  a note holding only his decisions about THAT trip (price, transport) and a free infant fare the
  file states (a birth-year child band marked «үнэгүй» → «Нярай … үнэгүй»).
- **«Шинэ аялал нэмэх»** no longer opens the blank form: it asks how the trip comes in — a file, a
  pasted program, a web page, or the form (last).
- **Photos.** `find_photos` gives every empty program day a photo: first the agency's own photos
  of the same places (`tripPhotoLibrary.ts`; a train or border day takes the train-day photo of a
  trip to the same places), then Wikimedia with `web: true`. New trips from the reader get the
  same house photos first.

Checked on a replay of the real 2026-11-21 package against the catalogue as it was before
(`scripts/assistant-intake-replay.ts`; config with the real files outside git in `uudam-eval/assistant-walk/replay-1121.json`): the
dialog asked the same four questions Claude asked, and with the owner's real answers the proposal
matched what was saved by hand (the archived check-up trip restored with the coming dates and
fares, the live one's four hotels and one sentence, the 54-item list on both, the new trip's file to
the reader with its price, train days and free infant). The age band was the one miss; it is now a checked gap.

In the real tab on 2026-11-22: a program of a live check-up trip with one hotel changed, sent with «аяллын хөтөлбөрийг энэ файлаар шинэчил», got the question ««…» бүртгэлд аль хэдийн идэвхтэй байна (сайтад нийтлэгдсэн) … 3, 4-р өдрийн буудал … өөрчлөгдөнө. Юу хийх вэ?»; the same file unchanged got "nothing to change" with the trip and its status named. The new trip of 2026-11-21 got a house photo on each of its six empty days and its infant fare set free (with the birth years as the band) through the tab. Two guards came from that run: a message that sets a price but whose proposal changes no fare is sent back once (the model had dropped «үнэгүй» when rewriting a refused proposal), and an age band keeps only the numbers the admin or his file wrote (it had added «0-23 сар»).

Polish of 2026-11-22: a priced list must keep the file's own groups (`listGroupHeadings`: a row with no price above priced rows) — a flat list is sent back with the headings to write, so the site shows each group as a block; a list line's typing slips are fixed in code («8төрөлт» → «8 төрөлт», «BБамбай» → «Бамбай»; capital codes like «СА199» stay); a long tab name is cut between words; a price question always names its trip; and a card replacing a day's photo says «Ачаалж байна…» until the trip is loaded instead of «Зураггүй».

## Cost and time per instruction (gpt-4.1)

| Kind | Rounds | Cost | Time |
| --- | --- | --- | --- |
| tapped option, trip link + one change | 1 | ~$0.02 | 3-6 s |
| trip name + one change | ~3 | $0.03-0.04 | 8-15 s |
| several changes in one message | 4-5 | $0.05-0.07 | 15-25 s |
| partner page → new trip | 1-2 + file reader | ~$0.04 + ~$0.07 | 40-60 s |
| small talk («сайн уу», «за»), tapped brain option | 0 | $0 | instant |

`AI_DAILY_BUDGET_USD` (default $20) stops model calls for the day; the code-side brain then still
does exact single edits («Энгийн горим»). Tests never call the model.

## Safety

- Every change is a proposal the admin reviews; nothing is written by the model.
- Every save carries the trip version it was built on (`expected_updated_at`): if someone else
  changed the trip meanwhile, the save is refused instead of overwriting their edit. Every save can
  be undone («Буцаах»), and undo restores only what that save changed.
- Delete = archive (hidden, record and photos kept, restorable).
- Partner-synced trips (`extra.partner_sync.source_url`) refuse hand price, date and per-date
  edits — the 30-minute sync would undo them; photos, program text and visibility are fine.
- Text from web pages and files is data, never instructions; a page is read only when its link is
  in the admin's own message, and only our own hosted photos are stored.
- No data → no answer: the assistant says what is missing instead of inventing it.

## The owner's rules

`src/lib/assistantHouseRules.ts` holds them in Mongolian; they go into every prompt and are enforced
in code where possible (`tripTransitDays.ts`, `tripPriceRules.ts`, `tripFareChange.ts`,
`tripCategorization.ts`). In short: a new trip is a new record; prices are the source's tugrug
selling price, never yuan or a "land" price; infant 0–23 months, child from 2; no invented dates;
hotels "A эсвэл B"; one day's seats are that day's state, not the trip's; when unsure, ask.

## Checks

```bash
node --import tsx --test tests/assistant-chat-logic-ui.test.ts tests/assistant-proposal-card-ui.test.ts tests/assistant-ask-ui.test.ts
node --import tsx --test tests/assistant-agent.test.ts tests/assistant-change-apply.test.ts tests/assistant-reply-route.test.ts
npx tsc --noEmit -p . && node scripts/run-tests.mjs
```

Trip names in tests and this file are invented; never write a real trip, place or price into
code or docs.
