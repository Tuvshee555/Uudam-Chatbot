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
| 1/15, 1/22 гаралт нэм · 11/18-ыг хас | departure dates added or removed |

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
