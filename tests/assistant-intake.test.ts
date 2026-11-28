/**
 * The assistant taking stock of attached files the way a careful colleague would (owner,
 * 2026-11-21): every open decision asked at once as one dialog, a file that looks like a trip
 * already saved noticed before it is read as a new one, «Шинэ аялал нэмэх» offering the ways
 * in, and a photo for every program day from the agency's own photos of the same places.
 * Invented trips, places, files and prices only. No model, no network, no database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTripMenu, QUICK_ACTIONS } from "../src/components/admin/AssistantQuickActions";
import { AssistantAskDialog } from "../src/components/admin/AssistantAskDialog";
import { AssistantTab } from "../src/components/admin/AssistantTab";
import { attachmentRoute, dialogAnswer, instructionBody, isTextDocument, replyToMessage, wantsSavedTripCheck } from "../src/components/admin/assistantChatLogic";
import type { AssistantAskMsg, AssistantChatMessage } from "../src/components/admin/assistantChatTypes";
import type { AttachedFile } from "../src/lib/adminTypes";
import { similarSavedTrips } from "../src/lib/assistantAgent/fileMatch";
import { childBandOf, decisionsOf, documentFacts, freeInfantLine, handoffNote, proposalGaps, hasTugrugAmount, intakeNeeded, listGroupHeadings, packIntake, stockFilesOf, stockProblems, titleMatches, tripsNamedIn, unpackIntake } from "../src/lib/assistantAgent/intake";
import { buildPhotoLibrary, dayPlaces, pickLibraryPhotos, transitKey } from "../src/lib/tripPhotoLibrary";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, CLOUD, NOW, scriptedChat, toolResults, trip, TRIPS, VERSION } from "./helpers/agentFixtures";

applyTestEnv();

const noop = () => undefined;
const file = (name: string, mimeType = ""): AttachedFile => ({ id: name, name, mimeType, sizeBytes: 1000, file: {} as File });

const DIALOG: AssistantAskMsg = {
  id: "ask-1", role: "assistant", kind: "ask", text: "1) Шинэ аяллын ₮: …\n2) Тээвэр: …", options: [], allowCustom: true,
  answerTo: { id: "agent", question: "1) Шинэ аяллын ₮: …\n2) Тээвэр: …", instruction: "эдгээр файлыг оруулаад өг", memo: "гамма.docx = шинэ аялал" },
  questions: [
    { id: "q1", header: "Шинэ аяллын ₮", text: "«Гамма уулын аялал» файлд зөвхөн ланд үнэ (1450 юань) байна. Зарлах үнэ хэд вэ?", options: [
      { label: "Үнэгүйгээр нийтлэх", description: "Сайтад «Үнэ лавлах» гэж харагдана.", recommended: true, answer: "Шинэ аяллын ₮: Үнэгүйгээр нийтлэх — Сайтад «Үнэ лавлах» гэж харагдана." },
      { label: "Ноорог болгож хадгалах", description: "Үнэ тодортол сайтад гарахгүй.", answer: "Шинэ аяллын ₮: Ноорог болгож хадгалах — Үнэ тодортол сайтад гарахгүй." },
    ] },
    { id: "q2", header: "Тээвэр", text: "Файлд автобусаар буцна гэжээ. Аль нь вэ?", options: [
      { label: "Стандарт галт тэрэгний өдрүүд", description: "16:40-ийн галт тэргээр гарч, 09:20-д ирнэ.", recommended: true, answer: "Тээвэр: Стандарт галт тэрэгний өдрүүд — 16:40-ийн галт тэргээр гарч, 09:20-д ирнэ. [сонгосон аялал: «ГАММА» id:t-g]" },
      { label: "Файлд бичсэнээр", description: "Автобусаар буцна.", answer: "Тээвэр: Файлд бичсэнээр — Автобусаар буцна." },
    ] },
  ],
};

test("a dialog's answers travel as one numbered message; nothing is sent until every question has an answer", () => {
  assert.equal(dialogAnswer(DIALOG, {}), null);
  assert.equal(dialogAnswer(DIALOG, { q1: { option: 0 } }), null, "one question still open");
  assert.equal(dialogAnswer(DIALOG, { q1: { text: "   " }, q2: { option: 1 } }), null, "an empty «Өөр» is no answer");

  const answer = dialogAnswer(DIALOG, { q1: { text: " том хүн 1,590,000,  хүүхэд 1,390,000 " }, q2: { option: 0 } })!;
  assert.deepEqual(answer.answers, ["Шинэ аяллын ₮: том хүн 1,590,000, хүүхэд 1,390,000", DIALOG.questions![1].options[0].answer]);
  assert.equal(answer.instruction, `1) ${answer.answers[0]}\n2) ${answer.answers[1]}`);
  assert.equal(answer.shown, "Шинэ аяллын ₮: том хүн 1,590,000, хүүхэд 1,390,000\nТээвэр: Стандарт галт тэрэгний өдрүүд", "the thread prints the labels, never the trip tag");
  assert.deepEqual(answer.summary, [{ header: "Шинэ аяллын ₮", answer: "том хүн 1,590,000, хүүхэд 1,390,000" }, { header: "Тээвэр", answer: "Стандарт галт тэрэгний өдрүүд" }]);

  // What goes to the route: the question, the first instruction, the assistant's note and each answer.
  const body = instructionBody({ instruction: answer.instruction, sessionId: "s-1", answerTo: { ...DIALOG.answerTo!, answers: answer.answers } });
  assert.deepEqual(body.answer_to, { id: "agent", question: DIALOG.answerTo!.question, instruction: "эдгээр файлыг оруулаад өг", memo: "гамма.docx = шинэ аялал", answers: answer.answers });

  // And what comes from it: an ask with questions is a dialog message.
  const message = replyToMessage({ ok: true, ask: { text: DIALOG.text, options: [], allow_custom: true, questions: DIALOG.questions, answer_to: DIALOG.answerTo } }, { id: "m", sent: "x" }) as AssistantAskMsg;
  assert.equal(message.questions?.length, 2);
  assert.equal(message.answerTo?.memo, "гамма.docx = шинэ аялал");
});

test("the dialog shows a tab per question, each choice with what it does, the recommended one marked, and «Өөр»", () => {
  const html = renderToStaticMarkup(createElement(AssistantAskDialog, { message: DIALOG, busy: false, onSubmit: noop }));
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.ok(html.includes("Шинэ аяллын ₮") && html.includes("Тээвэр"));
  assert.ok(html.includes("Зарлах үнэ хэд вэ?"), "the first question is open");
  assert.ok(html.includes("Сайтад «Үнэ лавлах» гэж харагдана."), "a choice says what it does");
  assert.equal((html.match(/Санал болгож буй/g) || []).length, 1, "only the open question's recommended choice is on screen");
  assert.ok(html.includes(">Өөр<"), "his own answer is always possible");
  assert.ok(/<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Хариултуудыг илгээх/.test(html), "nothing can be sent before every question is answered");
  assert.ok(html.includes("0/2 хариулсан"));
  assert.equal(html.includes("id:t-g"), false, "a trip tag never reaches the screen");

  const answered = renderToStaticMarkup(createElement(AssistantAskDialog, {
    message: { ...DIALOG, answered: "✓", dialogAnswers: [{ header: "Шинэ аяллын ₮", answer: "Ноорог болгож хадгалах" }, { header: "Тээвэр", answer: "Файлд бичсэнээр" }] }, busy: false, onSubmit: noop,
  }));
  assert.ok(answered.includes("2 асуулт · хариулсан") && answered.includes("Файлд бичсэнээр"));
  assert.equal(answered.includes("Хариултуудыг илгээх"), false, "an answered dialog reads as history");

  // Inside the thread it replaces the one-question buttons.
  const tab = renderToStaticMarkup(createElement(AssistantTab, {
    messages: [{ id: "a", role: "admin", text: "эдгээр файлыг оруулаад өг" }, DIALOG] as AssistantChatMessage[], existingTrips: [], aiInput: "", setAiInput: noop, attachedFiles: [],
    onRemoveAttachedFile: noop, dragOver: false, setDragOver: noop, busy: false, busyLabel: "", busyProgress: null, applyBusyId: "", clarifyBusyId: "", onSend: noop,
    onChooseOption: noop, onQuickAction: noop, onEditTripPrice: noop, onNewTrip: noop, onApply: noop, onRollback: noop, onSubmitClarificationForm: noop,
    onCancelProposal: noop, onPickFile: noop, onDropFiles: noop, chatEndRef: createRef<HTMLDivElement>(), inputRef: createRef<HTMLTextAreaElement>(),
  }));
  assert.ok(tab.includes('aria-label="Туслахын асуултууд"') && tab.includes("Хариултуудыг илгээх"));
});

test("«Шинэ аялал нэмэх» asks how the trip comes in: a file, a pasted program, a web page, and the blank form last", () => {
  assert.match(QUICK_ACTIONS.find((entry) => entry.key === "new")!.body, /Файл, хуулсан текст, вэб холбоос эсвэл гараар/);
  const html = renderToStaticMarkup(createElement(NewTripMenu, { busy: false, onChoose: noop, onCancel: noop }));
  const order = ["Файл оруулах", "Хөтөлбөрийн текст буулгах", "Вэб хуудаснаас авах", "Гараар бөглөх"].map((label) => html.indexOf(label));
  assert.ok(order.every((at) => at > 0) && order.join() === [...order].sort((a, b) => a - b).join(), "the four ways, the form last");
  assert.ok(html.includes("Шинэ аяллаа яаж оруулах вэ?"));
});

test("several documents at once are a package for the assistant; one document is checked against the catalogue first", () => {
  const doc = file("program.doc");
  const docx = file("new-year.docx");
  const sheet = file("extras.xlsx");
  const photo = file("price.jpg", "image/jpeg");
  const zip = file("poster-messenger-split.zip");
  for (const name of ["a.doc", "a.DOCX", "a.pdf", "a.xlsx", "a.xls", "a.csv", "a.txt"]) assert.equal(isTextDocument(file(name)), true, name);
  for (const name of ["a.zip", "a.jpg", "a.pptx"]) assert.equal(isTextDocument(file(name)), false, name);

  const packed = attachmentRoute("эдгээрийг оруулаад өг", [doc, docx, sheet, photo]);
  assert.ok(packed.kind === "agent_files" && packed.reason === "package" && packed.files.length === 4, "two programs, a list and a photo: sorted out by the assistant");
  assert.ok(attachmentRoute("", [doc, sheet]).kind === "agent_files", "with no words too");
  assert.equal(attachmentRoute("эдгээр гурвыг шинэ аялал болгон нэм", [doc, docx, sheet]).kind, "files", "«шинэ аялал болгон нэм» stays with the reader");
  assert.equal(attachmentRoute("нэгийг нь шинэчил, нөгөөг нь шинэ аялал болгон нэм", [doc, docx]).kind, "agent_files", "new and update said together: a package to sort out");
  assert.equal(attachmentRoute("", [doc, zip]).kind, "files", "a file the assistant cannot read as text keeps the reader");
  assert.equal(attachmentRoute("", [doc, photo]).kind, "files", "a program and its price photo are one trip for the reader");

  assert.equal(wantsSavedTripCheck("", [doc]), true);
  assert.equal(wantsSavedTripCheck("энэ аяллыг нэм", [doc, photo]), true, "one document with its picture");
  assert.equal(wantsSavedTripCheck("шинэ аялал болгон нэм", [doc]), false, "he said it is new: no check");
  assert.equal(wantsSavedTripCheck("байгаа бол шинэчил, байхгүй бол шинэ аялал болгон нэм", [doc]), true, "he is not sure himself: checked");
  assert.equal(wantsSavedTripCheck("", [photo]), false, "a picture has no text to check");
  assert.equal(wantsSavedTripCheck("", [doc, docx]), false, "a package goes to the assistant anyway");
});

test("a document that looks like a saved trip is noticed by its title lines; a new destination is not", () => {
  const alpha = trip({ id: "t-a", route_name: "НОРВЕЛ – ЛУМИА ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ", duration_text: "7 өдөр 6 шөнө" });
  const old = trip({ id: "t-old", route_name: "НОРВЕЛ ЛУМИА ҮЗЛЭГТЭЙ АЯЛАЛ", status: "archived", duration_text: "9 өдөр 8 шөнө" });
  const other = trip({ id: "t-o", route_name: "ВЭЛМОР АРЛЫН АЯЛАЛ" });
  const draft = trip({ id: "t-d", route_name: "НОРВЕЛ – ЛУМИА ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ", status: "draft" });
  const document = "2098 оны НОРВЕЛ-ЛУМИА ХОТЫН ҮЗЛЭГТЭЙ АЯЛЛЫН ХӨТӨЛБӨР\nҮзвэр:\nНорвелийн музей\nӨдөр 1\tУлаанбаатар-Замын үүд";
  assert.deepEqual(similarSavedTrips(document, [other, old, draft, alpha]).map((match) => [match.trip_id, match.status, match.duration]), [
    ["t-a", "active", "7 өдөр 6 шөнө"], ["t-old", "archived", "9 өдөр 8 шөнө"],
  ], "the live trip first; a draft is nobody's saved trip yet");
  assert.deepEqual(similarSavedTrips("ТАРВИС ГОЛЫН АЯЛАЛ\n1-р өдөр: Улаанбаатар – Тарвис", [alpha, old, other]), []);
  assert.deepEqual(similarSavedTrips("", [alpha]), []);
});

const day = (n: number, title: string, photo?: string) => ({ day: n, title, description: `${title}.`, ...(photo ? { photo } : {}) });

test("the agency's own photos by place: a day takes the photo of the same place, each photo once, border days none", () => {
  assert.deepEqual(dayPlaces("ЗАМЫН ҮҮД – ЭРЭЭН – НОРВЕЛ"), ["норве"]);
  assert.deepEqual(dayPlaces("ЭРЭЭН – ЗАМЫН-ҮҮД"), []);
  assert.deepEqual(dayPlaces("Улаанбаатар хот"), []);
  const source = trip({ id: "t-src", route_name: "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ", extra: { photo_credits: { [`${CLOUD}/lumia.jpg`]: { title: "Lumia bridge", author: "Fixture", license: "CC BY 4.0" } }, itinerary_days: [
    day(1, "Улаанбаатар – Замын-Үүд"), day(2, "Замын-Үүд – Эрээн – Норвел", `${CLOUD}/norvel-1.jpg`), day(3, "Норвел – Лумиа", `${CLOUD}/lumia.jpg`),
    day(4, "Лумиа хот", `${CLOUD}/lumia-2.jpg`), day(5, "Эрээн – Замын-Үүд", `${CLOUD}/border.jpg`), day(6, "Норвел хот", "https://elsewhere.example/not-ours.jpg"),
  ] } });
  const draft = trip({ id: "t-dr", route_name: "ТАРВИС", status: "draft", extra: { itinerary_days: [day(1, "Тарвис гол", `${CLOUD}/tarvis.jpg`)] } });
  assert.deepEqual(["ЭРЭЭН – ЗАМЫН-ҮҮД", "Улаанбаатар хот", "УБ – Замын-Үүд", "Норвел хот"].map(transitKey), ["зү+эрээн", "уб", "уб+зү", ""]);
  const library = buildPhotoLibrary([draft, source]);
  assert.deepEqual(library.map((photo) => [photo.url.split("/").pop(), photo.places.join("+"), photo.transit || ""]), [
    ["norvel-1.jpg", "норве", ""], ["lumia.jpg", "норве+лумиа", ""], ["lumia-2.jpg", "лумиа", ""], ["border.jpg", "", "зү+эрээн"],
  ], "only our own hosted photos; a draft's are left out; a train day's photo is kept as that train day's");
  assert.equal(library[1].credit?.license, "CC BY 4.0", "a photo that carries a credit keeps it");

  const fresh = [day(1, "УЛААНБААТАР – ЗАМЫН ҮҮД"), day(2, "ЗАМЫН ҮҮД – ЭРЭЭН – НОРВЕЛ"), day(3, "НОРВЕЛ – ЛУМИА"), day(4, "ЛУМИА – ТАРВИС"), day(5, "ТАРВИС ГОЛ"), day(6, "ЭРЭЭН – ЗАМЫН-ҮҮД")];
  const picks = pickLibraryPhotos(library, fresh);
  assert.deepEqual(picks.map((pick) => [pick.day, pick.url.split("/").pop(), pick.from]), [
    [2, "norvel-1.jpg", "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ"], [3, "lumia.jpg", "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ"], [4, "lumia-2.jpg", "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ"], [6, "border.jpg", "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ"],
  ], "the day about exactly that place first; the border day takes the sister trip's border-day photo; a place and a train day we have no photo of stay empty");
  assert.deepEqual(pickLibraryPhotos(library, fresh, { exclude: [`${CLOUD}/norvel-1.jpg`] }).map((pick) => pick.day), [3, 4, 6], "a photo the trip already shows is not used again");
  assert.deepEqual(pickLibraryPhotos(library, [day(1, "ТАРВИС ГОЛ"), day(2, "ЭРЭЭН – ЗАМЫН-ҮҮД")]), [], "a trip to other places never borrows a train-day photo: it may show the other trip's destination");
  assert.deepEqual(pickLibraryPhotos(library, [day(1, "НОРВЕЛ ХОТ", `${CLOUD}/own.jpg`)]), [], "a day that has its photo keeps it");
  assert.deepEqual(pickLibraryPhotos(library, source.extra!.itinerary_days as never, { ownTripId: "t-src" }), [], "a trip is never its own source");
});

// Live 2026-11-25: a saved trip's train day had been given a mountain photo; the library then offered that mountain as
// the «УБ – Замын-Үүд» house photo of the next new trip, and so on (the library fed on its own wrong picks).
test("a place photo that ended up on a train or border day is never offered as a train-day photo", () => {
  const sister = trip({ id: "t-sis", route_name: "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ", extra: { itinerary_days: [
    day(1, "Улаанбаатар – Замын-Үүд", `${CLOUD}/lumia-peak.jpg`), day(2, "Норвел – Лумиа"), day(3, "Лумиа уул", `${CLOUD}/lumia-peak.jpg`),
    day(4, "Эрээн – Замын-Үүд", `${CLOUD}/border-gate.jpg`),
  ] } });
  const library = buildPhotoLibrary([sister]);
  // The new trip goes to the same towns but has no mountain day of its own.
  const fresh = [day(1, "УЛААНБААТАР – ЗАМЫН ҮҮД"), day(2, "НОРВЕЛ ХОТ"), day(3, "ЭРЭЭН – ЗАМЫН-ҮҮД")];
  const picks = pickLibraryPhotos(library, fresh);
  assert.ok(!picks.some((pick) => pick.day === 1), `the mountain is not a train-day photo: ${JSON.stringify(picks)}`);
  assert.deepEqual(picks.filter((pick) => pick.day === 3).map((pick) => pick.url.split("/").pop()), ["border-gate.jpg"], "a real border photo is still shared");
  // The mountain day of a trip that has one still gets it.
  const withPeak = pickLibraryPhotos(library, [day(1, "ЛУМИА УУЛ")]);
  assert.deepEqual(withPeak.map((pick) => pick.url.split("/").pop()), ["lumia-peak.jpg"]);
});

test("«өдөр бүрт зураг ол»: the assistant proposes a hosted photo for each empty day, with its credit, and says which days stay empty", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const bare = trip({ id: "t-bare", route_name: "ТУРШИЛТ – ЗУРАГГҮЙ АЯЛАЛ", departure_dates: ["2098-12-02"], extra: { itinerary_days: [day(1, "Улаанбаатар – Замын-Үүд"), day(2, "Норвел хот"), day(3, "Лумиа хот"), day(4, "Тарвис гол")] } });
  const asked: Array<{ id: string; web: boolean }> = [];
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-bare" } }],
    () => [{ name: "find_photos", args: { trip_id: "t-bare" } }],
    ({ messages }) => {
      const found = JSON.parse(toolResults(messages).at(-1)!);
      assert.deepEqual(found.photos, [
        { day: 2, new_url: `${CLOUD}/norvel-1.jpg`, from: "манай «НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ» аяллын зураг" },
        { day: 3, new_url: `${CLOUD}/found-lumia.jpg`, from: "Wikimedia Commons" },
      ]);
      assert.deepEqual(found.days_still_without_photo, [{ day: 1, title: "Улаанбаатар – Замын-Үүд" }, { day: 4, title: "Тарвис гол" }]);
      return [{ name: "propose_changes", args: { reply_text: "2, 3-р өдөрт зураг нэмнэ; 4-р өдөрт тохирох зураг олдсонгүй.", actions: [
        { action: "replace_photo", trip_id: "t-bare", day: 2, new_url: `${CLOUD}/norvel-1.jpg`, summary: "" },
        { action: "replace_photo", trip_id: "t-bare", day: 3, new_url: `${CLOUD}/found-lumia.jpg`, summary: "" },
        { action: "replace_photo", trip_id: "t-bare", day: 4, new_url: `${CLOUD}/invented.jpg`, summary: "" },
      ] } }];
    },
  ]);
  const result = await runAgent({
    instruction: "зураггүй аяллын өдөр бүрт зураг олж нэм", trips: [...TRIPS, bare], today: NOW,
    deps: agentDeps(script.chat, { findPhotos: async (target, _catalogue, options) => {
      asked.push({ id: target.id, web: options.web });
      return [{ day: 2, url: `${CLOUD}/norvel-1.jpg`, source: "house", from: "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ" },
        { day: 3, url: `${CLOUD}/found-lumia.jpg`, source: "web", credit: { title: "Lumia old town", author: "Fixture", license: "CC BY 4.0" } }];
    } }),
  });
  assert.deepEqual(asked, [{ id: "t-bare", web: false }]);
  assert.equal(result.outcome.kind, "proposal", JSON.stringify(result.outcome));
  const proposal = (result.outcome as unknown as { proposal: { actions: Array<Record<string, unknown>>; conflicts: string[] } }).proposal;
  assert.deepEqual(proposal.actions.map((action) => [action.action, action.day, String(action.new_url).split("/").pop(), action.expected_updated_at]), [
    ["replace_photo", 2, "norvel-1.jpg", VERSION], ["replace_photo", 3, "found-lumia.jpg", VERSION],
  ]);
  assert.deepEqual(proposal.actions[1].credit, { title: "Lumia old town", author: "Fixture", license: "CC BY 4.0" }, "a photo from the web keeps its author and licence");
  assert.equal(proposal.actions[0].credit, undefined);
  assert.ok(proposal.conflicts.some((line) => /манай сервер дээр байршаагүй/.test(line)), "a link the model made up is refused");
});

/* ---------------------------------------------------------------- */
/* Taking stock, enforced in code (intake.ts)                       */
/* ---------------------------------------------------------------- */

const NORVEL = trip({ id: "t-norvel", route_name: "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", departure_dates: ["2098-12-02"], extra: { itinerary_days: [
  { day: 1, title: "Улаанбаатар – Норвел", description: "Норвел хотод ирж буудалдаа байрлана.", hotel: "Norvel Inn" },
  { day: 2, title: "Норвел – Лумиа", description: "Лумиа хотын хуучин хэсгээр алхана.", hotel: "Lumia Lodge" },
  { day: 3, title: "Буцах өдөр", description: "Өглөө Улаанбаатар руу буцна." },
] } });
const NORVEL_DOC = { name: "норвел-2099.doc", text: "НОРВЕЛ – ЛУМИА ХОТЫН АЯЛЛЫН ХӨТӨЛБӨР\nӨдөр 1\tУлаанбаатар – Норвел. Норвел хотод ирж буудалдаа байрлана. Буудал: Norvel Inn\nӨдөр 2\tНорвел – Лумиа. Лумиа хотын хуучин хэсгээр алхана. Буудал: Lumia Grand\nӨдөр 3\tБуцах өдөр. Өглөө Улаанбаатар руу буцна." };
const NORVEL_DAYS = [
  { title: "Улаанбаатар – Норвел", hotel: "Norvel Inn", text: "Норвел хотод ирж буудалдаа байрлана." },
  { title: "Норвел – Лумиа", hotel: "Lumia Grand", text: "Лумиа хотын хуучин хэсгээр алхана." },
  { title: "Буцах өдөр", hotel: "", text: "Өглөө Улаанбаатар руу буцна." },
];
const INTAKE_TRIPS = [...TRIPS, NORVEL];

test("what a file's own text shows: a two-way price remark, a yuan-only cost, a border start, a priced list", () => {
  const schedule = documentFacts("Тарвис – Лумиа\n2098 оны 12 сарын хуваарь, үнэ\n№ | Гарах огноо | Ланд үнэ | Зарлах үнэ\n1 | 12/05 | 1410 юань | 1,250,000 төг\nЗарлах үнэ дээр + үзлэгийн 450 юань нэмэгдэнэ эсвэл үнэгүй үзлэг\n25 хүнтэй группын үнэ");
  assert.equal(schedule.tugrug, true);
  assert.deepEqual(schedule.remarks, ["Зарлах үнэ дээр + үзлэгийн 450 юань нэмэгдэнэ эсвэл үнэгүй үзлэг", "25 хүнтэй группын үнэ"], "the title line is no remark");
  assert.equal(schedule.remarkTwoWays, true);
  const program = documentFacts("Шинэ жилийн тусгай аялал\nАялал: Эрээнээс эхлээд замын үүдэд дуусна.\nЛанд үнэ: Том хүн-1500¥\nӨдөр 1\tЭрээн – Тарвис\nӨдөр 2\tТарвис гол\nӨдөр 3\tТарвис – Эрээн");
  assert.deepEqual([program.days, program.tugrug, program.yuan, program.borderLine], [3, false, true, "Аялал: Эрээнээс эхлээд замын үүдэд дуусна."]);
  assert.equal(documentFacts("1-р өдөр: Тарвис\n2-р өдөр: Тарвис – Эрээн. Автобусаар буцна").borderLine, "2-р өдөр: Тарвис – Эрээн. Автобусаар буцна", "a bus home counts too");
  assert.equal(documentFacts("# Sheet1\nЗүрх | 180 | 心脏\nТолгой | 640 | 头部\nЭлэг | 95 | 肝").pricedRows, 3);
  assert.equal(hasTugrugAmount("том хүн 1.2 сая"), true);
  assert.equal(hasTugrugAmount("2098 он, 1450 юань, 12/05"), false, "a year, a yuan cost and a date are no tugrug price");
});

test("when the files must be taken stock of: a package, a page check, or «энэ файлаар шинэчил» with no trip named", () => {
  const needed = (words: string, documents = 1, extra: Partial<Parameters<typeof intakeNeeded>[0]> = {}) => intakeNeeded({ documents, words, flagged: false, named: tripsNamedIn(words, INTAKE_TRIPS).length, answering: false, revising: false, ...extra });
  assert.deepEqual(tripsNamedIn("аяллын хөтөлбөрийг энэ файлаар шинэчил", INTAKE_TRIPS), [], "generic words name no trip");
  assert.deepEqual(tripsNamedIn("норвел лумиагийн хөтөлбөрийг шинэчил", INTAKE_TRIPS).map((entry) => entry.id), ["t-norvel"]);
  assert.deepEqual(tripsNamedIn("alfa-гийн хөтөлбөр", INTAKE_TRIPS).map((entry) => entry.id), ["t-alpha"], "an alias names its trip");
  assert.equal(needed("аяллын хөтөлбөрийг энэ файлаар шинэчил"), true);
  assert.equal(needed("норвел лумиагийн хөтөлбөрийг энэ файлаар шинэчил"), false, "he named the trip: his words decide");
  assert.equal(needed("энэ файлыг уншаад зөв эсэхийг хэл"), false, "a question about a file changes nothing");
  assert.equal(needed("энэ хоёрыг оруулаад өг", 2), true);
  assert.equal(needed("", 1, { flagged: true }), true, "the page found the file looks like a saved trip");
  assert.equal(needed("эдгээрийг шинээр оруул", 2), false, "only new trips: the reader's job");
  assert.equal(needed("энэ хоёрыг оруулаад өг", 2, { answering: true }), false);
});

test("the stock-taking is checked: every file once, trips the catalogue has, one trip for a program", () => {
  const byId = new Map(INTAKE_TRIPS.map((entry) => [entry.id, entry]));
  const documents = [NORVEL_DOC, { name: "жагсаалт.xlsx", text: "a | 1" }];
  assert.match((stockFilesOf([{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-norvel"] }], documents, byId) as { error: string }).error, /Missing: "жагсаалт\.xlsx"/);
  assert.match((stockFilesOf([{ file: "өөр.doc", kind: "other" }], documents, byId) as { error: string }).error, /is not an attached file/);
  assert.match((stockFilesOf([{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-norvel", "t-alpha"] }, { file: "жагсаалт.xlsx", kind: "other" }], documents, byId) as { error: string }).error, /exactly ONE saved trip/);
  assert.match((stockFilesOf([{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-nowhere"] }, { file: "жагсаалт.xlsx", kind: "other" }], documents, byId) as { error: string }).error, /not in the catalogue/);
  const ok = stockFilesOf([{ file: "НОРВЕЛ-2099.DOC", kind: "saved_program", trip_ids: ["t-norvel"] }, { file: "жагсаалт.xlsx", kind: "extra_info", trip_ids: ["t-norvel", "t-alpha"] }], documents, byId);
  assert.deepEqual(ok, { files: [{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-norvel"] }, { file: "жагсаалт.xlsx", kind: "extra_info", trip_ids: ["t-norvel", "t-alpha"] }] });

  // Packed with the questions, read back with his answers — only where it still fits the files and the catalogue.
  const asked = [{ topic: "saved_or_new" as const, header: "Аялал байна", file: "норвел-2099.doc", trip_id: "t-norvel" }, { topic: "other" as const, header: "Тодруулга" }];
  const packed = packIntake({ files: (ok as { files: never[] }).files, asked });
  assert.deepEqual(unpackIntake(packed, documents, byId)?.asked, asked);
  assert.equal(unpackIntake(packed, [NORVEL_DOC], byId), null, "a file gone since: the old stock-taking is not trusted");
  assert.equal(unpackIntake("{not json", documents, byId), null);
  assert.deepEqual(decisionsOf(asked, ["Аялал байна: Одоо байгааг шинэчлэх — Зөвхөн … [сонгосон аялал: «НОРВЕЛ» id:t-norvel]", "Тодруулга: 12/5-наас"]).map((entry) => [entry.choice, entry.text]), [["update", "Одоо байгааг шинэчлэх"], ["said", "12/5-наас"]]);
});

test("«аяллын хөтөлбөрийг энэ файлаар шинэчил» about a trip that is live: the assistant says which trip it is and asks before changing it", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat([
    () => [{ name: "search_trips", args: { query: "Норвел Лумиа" } }],
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: NORVEL_DAYS } }],
    // Straight to a proposal: sent back to say what the file is.
    () => [{ name: "propose_changes", args: { reply_text: "2-р өдрийн буудал солигдоно.", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "Lumia Grand", summary: "" }] } }],
    () => [{ name: "take_stock", args: { files: [{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-norvel"] }] } }],
    ({ messages }) => {
      const stock = JSON.parse(toolResults(messages).at(-1)!);
      assert.equal(stock.must_ask.length, 1);
      assert.equal(stock.must_ask[0].topic, "saved_or_new");
      assert.match(stock.must_ask[0].why, /LIVE on the site/);
      // Proposes again anyway: sent back to ask.
      return [{ name: "propose_changes", args: { reply_text: "2-р өдрийн буудал солигдоно.", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "Lumia Grand", summary: "" }] } }];
    },
    ({ messages }) => {
      assert.match(JSON.parse(toolResults(messages).at(-1)!).not_done, /These decisions are the admin's/);
      return [{ name: "ask_user", args: { questions: [{ topic: "saved_or_new", file: "норвел-2099.doc", header: "Аялал байна", question: "«НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ» сайтад идэвхтэй байна (3 өдөр 2 шөнө). Файлд 2-р өдрийн буудал өөр (Lumia Grand). Энэ файлаар юу хийх вэ?", options: [{ label: "Тийм", description: "" }] }] } }];
    },
  ]);
  const result = await runAgent({ instruction: "аяллын хөтөлбөрийг энэ файлаар шинэчил", trips: INTAKE_TRIPS, documents: [NORVEL_DOC], today: NOW, deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "ask", JSON.stringify(result.outcome));
  const ask = (result.outcome as unknown as { ask: { questions: Array<{ header: string; text: string; options: Array<{ label: string; recommended?: boolean; answer: string }> }>; intake: string } }).ask;
  assert.equal(ask.questions.length, 1);
  assert.match(ask.questions[0].text, /сайтад идэвхтэй байна/);
  assert.deepEqual(ask.questions[0].options.map((option) => `${option.recommended ? "*" : ""}${option.label}`), ["*Одоо байгааг шинэчлэх", "Шинэ аялал болгон нэмэх"]);
  assert.match(ask.questions[0].options[0].answer, /\[сонгосон аялал: «НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ» id:t-norvel\]$/, "the answer names the trip it is about");

  // He chooses to update it: the next turn opens that trip, compares again and proposes only the real difference.
  const answers = [ask.questions[0].options[0].answer];
  const next = scriptedChat([
    ({ messages }) => {
      assert.match(String(messages[1].content), /Аяллын дэлгэрэнгүй \(get_trip-ийн хариу/);
      // A patch with no comparison of this turn: sent back.
      return [{ name: "propose_changes", args: { reply_text: "", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "Lumia Grand", summary: "" }] } }];
    },
    ({ messages }) => {
      assert.match(JSON.parse(toolResults(messages).at(-1)!).missing.join(" "), /compare_program \{trip_id: "t-norvel"\} first/);
      return [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: NORVEL_DAYS } }];
    },
    ({ messages }) => {
      const compared = JSON.parse(toolResults(messages).at(-1)!);
      assert.deepEqual(compared.days.map((entry: { saved_day: number; hotel?: { write: string } }) => [entry.saved_day, entry.hotel?.write]), [[2, "Lumia Grand"]], "the same hotel written alike is no change");
      return [{ name: "propose_changes", args: { reply_text: "2-р өдрийн буудал солигдоно; бусад нь таарч байна.", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "Lumia Grand", summary: "" }] } }];
    },
  ]);
  const second = await runAgent({ instruction: `1) ${answers[0]}`, trips: INTAKE_TRIPS, documents: [NORVEL_DOC], today: NOW, deps: agentDeps(next.chat),
    answerTo: { id: "agent", question: "1) Аялал байна: …", instruction: "аяллын хөтөлбөрийг энэ файлаар шинэчил", answers, intake: ask.intake } });
  assert.equal(second.outcome.kind, "proposal", JSON.stringify(second.outcome));
  const proposal = (second.outcome as unknown as { proposal: { actions: Array<Record<string, unknown>>; conflicts: string[] } }).proposal;
  assert.deepEqual(proposal.actions.map((action) => [action.action, action.trip_id, action.day, action.hotel]), [["patch_itinerary_day", "t-norvel", 2, "Lumia Grand"]]);
  assert.ok(!proposal.conflicts.some((line) => /тулгаж амжаагүй/.test(line)));
});

test("a model that will not ask: after two reminders the system asks the open decisions itself", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const propose = () => [{ name: "propose_changes", args: { reply_text: "", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "Lumia Grand", summary: "" }] } }];
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }, { name: "search_trips", args: { query: "Норвел" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: NORVEL_DAYS } }],
    () => [{ name: "take_stock", args: { files: [{ file: "норвел-2099.doc", kind: "saved_program", trip_ids: ["t-norvel"] }] } }],
    propose, propose, propose,
  ]);
  const result = await runAgent({ instruction: "энэ файлаар шинэчил", trips: INTAKE_TRIPS, documents: [NORVEL_DOC], today: NOW, deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "ask", JSON.stringify(result.outcome));
  const question = (result.outcome as unknown as { ask: { questions: Array<{ header: string; text: string; options: Array<{ label: string }> }> } }).ask.questions[0];
  assert.equal(question.header, "Аялал байна");
  assert.match(question.text, /«НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ» аялал бүртгэлд аль хэдийн байна \(идэвхтэй, 3 өдөр 2 шөнө\)/);
  assert.deepEqual(question.options.map((option) => option.label), ["Одоо байгааг шинэчлэх", "Шинэ аялал болгон нэмэх"]);
});

test("an archived trip brought back from its files: sent back until it has its status and a coming date; a price still missing is said on the card", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const TARVIS = trip({ id: "t-tarvis", route_name: "ТАРВИС ГОЛЫН АЯЛАЛ", status: "archived", adult_price: null as unknown as number, child_price: null as unknown as number, departure_dates: ["2098-10-04"],
    extra: { archived_reason: "all_departure_dates_passed", itinerary_days: [{ day: 1, title: "Тарвис гол", description: "Голын эрэг дагуу алхана." }, { day: 2, title: "Буцах өдөр", description: "Өглөө буцна." }] } });
  const program = { name: "тарвис.doc", text: "ТАРВИС ГОЛЫН АЯЛАЛ\nӨдөр 1\tТарвис гол. Голын эрэг дагуу алхана.\nӨдөр 2\tБуцах өдөр. Өглөө буцна." };
  const schedule = { name: "тарвис-хуваарь.jpg", text: "Тарвис голын аялал\n№ | Гарах огноо | Зарлах үнэ\n1 | 12/05 | 1,250,000 төг\n2 | 12/12 | 1,250,000 төг" };
  const days = [{ title: "Тарвис гол", hotel: "", text: "Голын эрэг дагуу алхана." }, { title: "Буцах өдөр", hotel: "", text: "Өглөө буцна." }];
  const dates = { action: "change_dates", trip_id: "t-tarvis", add_dates: ["2098-12-05", "2098-12-12"], summary: "" };
  const live = { action: "patch", trip_id: "t-tarvis", fields: { status: "active" }, summary: "" };
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-tarvis" } }, { name: "search_trips", args: { query: "Тарвис" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-tarvis", file_days: days } }],
    () => [{ name: "take_stock", args: { files: [{ file: "тарвис.doc", kind: "saved_program", trip_ids: ["t-tarvis"] }, { file: "тарвис-хуваарь.jpg", kind: "schedule", trip_ids: ["t-tarvis"] }] } }],
    ({ messages }) => {
      assert.deepEqual(JSON.parse(toolResults(messages).at(-1)!).must_ask, [], "the trip is named, the schedule has its tugrug price: nothing to ask");
      return [{ name: "propose_changes", args: { reply_text: "Сэргээнэ.", actions: [dates] } }];
    },
    ({ messages }) => {
      assert.match(JSON.parse(toolResults(messages).at(-1)!).missing[0], /is archived and the admin wants it active/);
      return [{ name: "propose_changes", args: { reply_text: "Сэргээнэ.", actions: [live] } }];
    },
    ({ messages }) => {
      const missing = JSON.parse(toolResults(messages).at(-1)!).missing.join(" ");
      assert.match(missing, /goes live with no coming departure/);
      assert.match(missing, /has no saved price/);
      return [{ name: "propose_changes", args: { reply_text: "Сэргээнэ.", actions: [dates, live] } }];
    },
  ]);
  const result = await runAgent({ instruction: "тарвис голын аяллыг эдгээр файлаар сэргээж идэвхтэй болго", trips: [...TRIPS, TARVIS], documents: [program, schedule], today: NOW, deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "proposal", JSON.stringify(result.outcome));
  const proposal = (result.outcome as unknown as { proposal: { conflicts: string[] } }).proposal;
  assert.ok(proposal.conflicts.includes("«ТАРВИС ГОЛЫН АЯЛАЛ»-д үнэ алга — том хүн, хүүхдийн үнийг нэмнэ үү."), JSON.stringify(proposal.conflicts));
  assert.ok(!proposal.conflicts.some((line) => /ирэх гаралтгүйгээр/.test(line)), "the dates came in the end");
});

test("the stock-taking is checked against the files' own titles: the live copy, the same length, a program is no list, a schedule goes with its program", () => {
  const live = trip({ id: "t-sela-live", route_name: "СЕЛА – ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ", duration_text: "5 өдөр 4 шөнө" });
  const old = trip({ id: "t-sela-old", route_name: "СЕЛА ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ", status: "archived", duration_text: "5 өдөр 4 шөнө" });
  const long = trip({ id: "t-sela-long", route_name: "СЕЛА ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ", status: "archived", duration_text: "8 өдөр 7 шөнө" });
  const plain = trip({ id: "t-sela-plain", route_name: "СЕЛА – ВАРНО", duration_text: "5 өдөр 4 шөнө" });
  const trips = [plain, long, old, live];
  const byId = new Map(trips.map((entry) => [entry.id, entry]));
  const program = { name: "села.doc", text: "СЕЛА – ВАРНО ҮЗЛЭГТЭЙ АЯЛЛЫН ХӨТӨЛБӨР\nӨдөр 1\tСела\nӨдөр 2\tВарно\nӨдөр 3\tҮзлэг\nӨдөр 4\tВарно\nӨдөр 5\tБуцна" };
  const photo = { name: "села-үнэ.jpg", text: "Села – Варно үзлэгтэй аялал\n12/05 | 1,250,000 төг" };
  const documents = [program, photo];
  assert.deepEqual(titleMatches(program.text, trips).map((entry) => [entry.trip.id, entry.shared]), [["t-sela-live", 3], ["t-sela-long", 3], ["t-sela-old", 3], ["t-sela-plain", 2]], "most shared words first, the live trip first among equals");
  const check = (programTrip: string, photoTrip: string, compared: string[] = [programTrip], kind: "saved_program" | "extra_info" = "saved_program") => stockProblems([
    { file: "села.doc", kind, trip_ids: [programTrip] }, { file: "села-үнэ.jpg", kind: "schedule", trip_ids: [photoTrip] },
  ], { documents, trips, byId, compared: new Set(compared) });
  assert.deepEqual(check("t-sela-live", "t-sela-live"), []);
  assert.match(check("t-sela-old", "t-sela-old").join(" "), /«СЕЛА – ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ» \(trip_id t-sela-live, active, 5 өдөр 4 шөнө\) is LIVE and matches this file as well/);
  assert.match(check("t-sela-long", "t-sela-long").join(" "), /has 5 program days; «СЕЛА ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ» is 8 өдөр 7 шөнө/);
  assert.match(check("t-sela-plain", "t-sela-live").join(" "), /its title matches .* better than «СЕЛА – ВАРНО»/);
  assert.match(check("t-sela-live", "t-sela-live", []).join(" "), /call compare_program \{trip_id: "t-sela-live"\} first/);
  assert.match(check("t-sela-live", "t-sela-old").join(" "), /"села-үнэ\.jpg" is the schedule of the same trip as its program file: «СЕЛА – ВАРНО ҮЗЛЭГТЭЙ АЯЛАЛ» \(trip_id t-sela-live\)/);
  assert.match(stockProblems([{ file: "села.doc", kind: "extra_info", trip_ids: ["t-sela-live"] }, { file: "села-үнэ.jpg", kind: "other", trip_ids: [] }], { documents, trips, byId, compared: new Set() }).join(" "),
    /"села\.doc" is a day-by-day program \(5 days\), not extra_info/);
});

test("a list sent with programs goes to the trips of those programs; a fare the file writes as free for the youngest reaches the reader as a free infant fare", () => {
  const checkup = trip({ id: "t-mira-check", route_name: "МИРА – ОЛВЕН ҮЗЛЭГТЭЙ АЯЛАЛ", duration_text: "2 өдөр 1 шөнө" });
  const plain = trip({ id: "t-mira-plain", route_name: "МИРА – ОЛВЕН АЯЛАЛ", duration_text: "2 өдөр 1 шөнө" });
  const trips = [checkup, plain];
  const byId = new Map(trips.map((entry) => [entry.id, entry]));
  const documents = [{ name: "мира.doc", text: "МИРА – ОЛВЕН ҮЗЛЭГТЭЙ АЯЛАЛ\nӨдөр 1\tМира\nӨдөр 2\tОлвен" }, { name: "нэмэлт.xlsx", text: "Зүрх | 180\nТолгой | 640\nЭлэг | 95" }];
  const problems = stockProblems([{ file: "мира.doc", kind: "saved_program", trip_ids: ["t-mira-check"] }, { file: "нэмэлт.xlsx", kind: "extra_info", trip_ids: ["t-mira-check", "t-mira-plain"] }],
    { documents, trips, byId, compared: new Set(["t-mira-check"]) });
  assert.deepEqual(problems, ["\"нэмэлт.xlsx\" names «МИРА – ОЛВЕН АЯЛАЛ» (trip_id t-mira-plain), but the attached programs and schedules belong to «МИРА – ОЛВЕН ҮЗЛЭГТЭЙ АЯЛАЛ» (trip_id t-mira-check). Use those trips, unless the list is really for that other trip as well."]);

  const file = "Шинэ жилийн аялал\nЛанд үнэ: Том хүн-1500¥\n2088-2095 он хүүхэд- 1200¥\n2096-2098 он хүүхэд-үнэгүй";
  assert.equal(freeInfantLine(file, NOW), "Нярай (2096–2098 онд төрсөн): үнэгүй (файлд «2096-2098 он хүүхэд-үнэгүй»).");
  assert.equal(freeInfantLine("Нярай үнэгүй, зөвхөн такс", NOW), "Нярай: үнэгүй (файлд «Нярай үнэгүй, зөвхөн такс»).");
  assert.equal(freeInfantLine("2088-2095 он хүүхэд үнэгүй", NOW), "", "an older child band is no infant");
  assert.equal(freeInfantLine("Хоол үнэгүй", NOW), "");
  const decisions = decisionsOf([{ topic: "selling_price", header: "Шинэ жил ₮", file: "шинэ.docx" }], ["Шинэ жил ₮: том хүн 1,590,000, хүүхэд 1,390,000"]);
  assert.equal(handoffNote(["шинэ.docx"], decisions, "оруулаад өг", file, NOW),
    "Шинэ аялал болгон нэм.\nЗарах үнэ: том хүн 1,590,000, хүүхэд 1,390,000\nНярай (2096–2098 онд төрсөн): үнэгүй (файлд «2096-2098 он хүүхэд-үнэгүй»).");
  const own = decisionsOf([{ topic: "selling_price", header: "Шинэ жил ₮", file: "шинэ.docx" }], ["Шинэ жил ₮: том хүн 1,590,000, хүүхэд 1,390,000, нярай 300,000"]);
  assert.doesNotMatch(handoffNote(["шинэ.docx"], own, "оруулаад өг", file, NOW), /үнэгүй/, "his own infant fare wins");
});

test("a schedule's child band goes on the trip with its fares, and a group heading glued to its first item becomes its own line", async () => {
  assert.deepEqual(childBandOf("№ | Гарах огноо | Ланд үнэ том хүн | Ланд үнэ хүүхэд 2-11 нас оргүй | Зарлах үнэ хүүхэд"), { range: "2-11", text: "2-11 нас, ор эзлэхгүй" });
  assert.deepEqual(childBandOf("Хүүхэд (3–12 нас): 990,000"), { range: "3-12", text: "3-12 нас" });
  assert.equal(childBandOf("Том хүн 1,250,000"), null);

  const saved = trip({ id: "t-vela", route_name: "ВЕЛА НУУРЫН АЯЛАЛ", status: "archived", departure_dates: [], extra: { age_rules: { child: "2-12 нас" } } });
  const intake = { files: [{ file: "вела.jpg", kind: "schedule" as const, trip_ids: ["t-vela"] }], asked: [] };
  const context = { documents: [{ name: "вела.jpg", text: "Вела нуурын аялал\n№ | Гарах огноо | Зарлах үнэ том хүн | Зарлах үнэ хүүхэд 2-11 нас оргүй\n1 | 12/05 | 1,250,000 | 990,000" }], byId: new Map([[saved.id, saved]]), adminWords: "вела нуурын аяллыг сэргээ", answered: true };
  const actions = [
    { action: "patch", trip_id: "t-vela", fields: { status: "active" } },
    { action: "change_dates", trip_id: "t-vela", add_dates: ["2098-12-05"] },
    { action: "fare_change_all", trip_ids: ["t-vela"], change: { adult: { set: 1_250_000 }, child: { set: 990_000 } } },
  ];
  const gaps = proposalGaps({ intake, decisions: [], actions, context, compared: new Set(), now: NOW });
  assert.deepEqual(gaps.map((gap) => gap.admin), ["«ВЕЛА НУУРЫН АЯЛАЛ»: файлд хүүхдийн нас «2-11 нас, ор эзлэхгүй» гэж байна — насны ангилалд оруулаагүй."]);
  assert.match(gaps[0].model, /set_age_bands \{trip_id: "t-vela", bands: \{child: "2-11 нас, ор эзлэхгүй"\}\}/);
  assert.deepEqual(proposalGaps({ intake, decisions: [], actions: [...actions, { action: "set_age_bands", trip_id: "t-vela" }], context, compared: new Set(), now: NOW }), [], "restored with dates, fares and the band: complete");

  const { notesSectionText } = await import("../src/lib/tripNotesAppend");
  assert.equal(notesSectionText("Эмэгтэйчүүдийн шинжилгээ: TCT шинжилгээ: 170 юань\nЭлэгний шинжилгээ 13 төрөлт: 90 юань\nЦусны ерөнхий шинжилгээ: 30 юань"),
    "Эмэгтэйчүүдийн шинжилгээ:\nTCT шинжилгээ: 170 юань\nЭлэгний шинжилгээ 13 төрөлт: 90 юань\nЦусны ерөнхий шинжилгээ: 30 юань");
});

test("an answer about an attached program names the saved trip it was compared with and says it is live", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const same = NORVEL_DAYS.map((entry, index) => (index === 1 ? { ...entry, hotel: "Lumia Lodge" } : entry));
  const script = scriptedChat([
    () => [{ name: "search_trips", args: { query: "Норвел Лумиа" } }],
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: same } }],
    () => [{ name: "reply", args: { text: "Файлын хөтөлбөр бүртгэлтэй таарч байна, өөрчлөх зүйл алга." } }],
  ]);
  const result = await runAgent({ instruction: "аяллын хөтөлбөрийг энэ файлаар шинэчил", trips: INTAKE_TRIPS, documents: [NORVEL_DOC], today: NOW, deps: agentDeps(script.chat) });
  assert.deepEqual(result.outcome, { kind: "note", reason: "reply", text: "Файлын хөтөлбөр бүртгэлтэй таарч байна, өөрчлөх зүйл алга.\n\nТулгасан аялал: «НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ» (сайтад идэвхтэй, 3 өдөр 2 шөнө)." });
});

test("«нярай (… онд төрсөн) үнэгүй»: a proposal without the fare is sent back once, and the band keeps only what he wrote", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const band = { action: "set_age_bands", trip_id: "t-beta", bands: { infant: "0-23 сар, 2096–2098 онд төрсөн" }, summary: "" };
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-beta" } }],
    () => [{ name: "propose_changes", args: { reply_text: "Нярайг үнэгүй болгоно.", actions: [band] } }],
    ({ messages }) => {
      assert.match(JSON.parse(toolResults(messages).at(-1)!).not_done, /also sets a price/);
      return [{ name: "propose_changes", args: { reply_text: "Нярайг үнэгүй болгоно.", actions: [band, { action: "fare_change_all", trip_ids: ["t-beta"], change: { infant: { set: 0 } }, summary: "" }] } }];
    },
  ]);
  const result = await runAgent({ instruction: "бета нуурын аяллын нярай (2096–2098 онд төрсөн) үнэгүй", trips: TRIPS, today: NOW, deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "proposal", JSON.stringify(result.outcome));
  const actions = (result.outcome as unknown as { proposal: { actions: Array<Record<string, unknown>> } }).proposal.actions;
  const bands = actions.find((action) => action.action === "set_age_bands")!;
  assert.equal(bands.infant, "2096–2098 онд төрсөн", "«0-23 сар» was the model's own: dropped");
  assert.ok(actions.some((action) => (action.fields as { infant_price?: unknown } | undefined)?.infant_price === 0), JSON.stringify(actions));
});

test("a priced list keeps the file's own groups: a flat list is sent back with the headings, and the file's typing slips are fixed", async () => {
  const sheet = [
    "# Sheet1",
    "测试加项单",
    "心脏检查 / Зүрхний шинжилгээ | 价格",
    "心电图 / Зүрхний бичлэг | 40 | 说明",
    "心脏彩超 / Зүрхний ЭХО | 180 | 说明",
    "超声科检查Хэт авиан шинжилгээ",
    "肝胆彩超 / Элэг цөсний ЭХО | 90 | 说明",
    "甲状腺彩超 / Бамбайн ЭХО | 100 | 说明",
    "放射科CT（不含片） / 价格",
    "胸部CT / Цээжний CT | 260 | 说明",
    "头颅CT / Толгойн CT | 260 | 说明",
  ].join("\n");
  assert.deepEqual(listGroupHeadings(sheet), ["心脏检查 / Зүрхний шинжилгээ", "超声科检查Хэт авиан шинжилгээ", "放射科CT（不含片）"], "the title above the first group is no group");

  const checkup = trip({ id: "t-mira-check", route_name: "МИРА – ОЛВЕН ҮЗЛЭГТЭЙ АЯЛАЛ" });
  const intake = { files: [{ file: "нэмэлт.xlsx", kind: "extra_info" as const, trip_ids: ["t-mira-check"] }], asked: [] };
  const context = { documents: [{ name: "нэмэлт.xlsx", text: sheet }], byId: new Map([[checkup.id, checkup]]), adminWords: "нэмэлт мэдээлэл болгож нэм", answered: true };
  const flat = "Зүрхний бичлэг: 40 юань\nЗүрхний ЭХО: 180 юань\nЭлэг цөсний ЭХО: 90 юань\nБамбайн ЭХО: 100 юань\nЦээжний CT: 260 юань\nТолгойн CT: 260 юань";
  const gaps = proposalGaps({ intake, decisions: [], actions: [{ action: "append_notes", trip_id: "t-mira-check", text: flat }], context, compared: new Set(), now: NOW });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].model, /has 0 group headings, but "нэмэлт\.xlsx" sorts its items under 3: «心脏检查 \/ Зүрхний шинжилгээ», «超声科检查Хэт авиан шинжилгээ», «放射科CT（不含片）»/);
  assert.equal(gaps[0].admin, "«МИРА – ОЛВЕН ҮЗЛЭГТЭЙ АЯЛАЛ»: жагсаалтын бүлгийн гарчгууд (3) орхигдсон — бүлэг бүрийн гарчгийг нэмэхийг дахин хүснэ үү.");
  const grouped = `Зүрхний шинжилгээ:\nЗүрхний бичлэг: 40 юань\nЗүрхний ЭХО: 180 юань\n\nХэт авиан шинжилгээ:\nЭлэг цөсний ЭХО: 90 юань\nБамбайн ЭХО: 100 юань\n\nCT шинжилгээ:\nЦээжний CT: 260 юань\nТолгойн CT: 260 юань`;
  assert.deepEqual(proposalGaps({ intake, decisions: [], actions: [{ action: "append_notes", trip_id: "t-mira-check", text: grouped }], context, compared: new Set(), now: NOW }), []);

  const { notesSectionText } = await import("../src/lib/tripNotesAppend");
  assert.equal(notesSectionText("Элэгний шинжилгээ 8төрөлт: 70 юань\nЗүрхний ферментүүд4 төрөлт: 44 юань\nBБамбай булчирхай 3 төрөлт: 150 юань\nНүүрс усны эсрэгтөрөгч 199 /СА199/: 120 юань\nС14 амьсгалын тест: 100 юань\nХүзүүний нугасны (C2–C7) завсар: 260 юань"),
    "Элэгний шинжилгээ 8 төрөлт: 70 юань\nЗүрхний ферментүүд 4 төрөлт: 44 юань\nБамбай булчирхай 3 төрөлт: 150 юань\nНүүрс усны эсрэгтөрөгч 199 /СА199/: 120 юань\nС14 амьсгалын тест: 100 юань\nХүзүүний нугасны (C2–C7) завсар: 260 юань");
});

test("a long tab name is cut between words, and a price question always names its trip", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const schedule = { name: "норвел-үнэ.jpg", text: "Норвел – Лумиа хотын аялал\n№ | Гарах огноо | Зарлах үнэ\n1 | 12/05 | 1,250,000 төг\nЗарлах үнэ дээр + үзлэгийн 450 юань нэмэгдэнэ эсвэл үнэгүй үзлэг" };
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }, { name: "search_trips", args: { query: "Норвел" } }],
    () => [{ name: "take_stock", args: { files: [{ file: "норвел-үнэ.jpg", kind: "schedule", trip_ids: ["t-norvel"] }] } }],
    () => [{ name: "ask_user", args: { questions: [{ topic: "price_remark", file: "норвел-үнэ.jpg", header: "Норвел лумиа хотын аяллын үнийн тайлбар", question: "Зарлах үнэ дээр + үзлэгийн 450 юань нэмэгдэнэ эсвэл үнэгүй үзлэг гэжээ. Яаж мэдээлэх вэ?", options: [{ label: "450 юань тусдаа", description: "" }] }] } }],
  ]);
  const result = await runAgent({ instruction: "энэ хуваарийг оруулаад өг", trips: INTAKE_TRIPS, documents: [schedule], intake: true, today: NOW, deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "ask", JSON.stringify(result.outcome));
  const question = (result.outcome as unknown as { ask: { questions: Array<{ header: string; text: string; options: Array<{ label: string }> }> } }).ask.questions[0];
  assert.equal(question.header, "Норвел лумиа хотын аяллын");
  assert.match(question.text, /^«НОРВЕЛ – ЛУМИА ХОТЫН АЯЛАЛ»: Зарлах үнэ дээр/);
  assert.deepEqual(question.options.map((option) => option.label), ["450 юань тусдаа", "Одоохондоо хөндөхгүй"]);
});
