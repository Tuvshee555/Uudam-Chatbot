/**
 * "… аяллын хөтөлбөрийг энэ файлаар шинэчил": a partner's updated program against the saved trip
 * (src/lib/assistantAgent/programCompare.ts, the compare_program tool, the day-rewrite guard).
 * The shape of the first real update (2026-11-21): the file changed the hotels of two days and
 * added two sentences to one; everything else was the same program in the partner's raw wording.
 * Invented trip, hotels and places only. Scripted model, no network, no database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, NOW, scriptedChat, toolResults, trip, VERSION } from "./helpers/agentFixtures";

applyTestEnv();

const SAVED_DAY_2 = "07:20 цагт Замын-Үүдэд ирж галт тэргнээс буугаад хил гарах унаанд сууна. Хоёр улсын хил гаалиар нэвтэрч Эрээн хотод ирээд өдрийн хоолоо өөрсдөө төлнө. Дараа нь аяллын автобусаар Норвел хот руу явж, буудалдаа байрлан оройн хоолоо идээд амарна.";
const SAVED_DAY_3 = "Үзлэгт орох хүмүүс өглөөний цай уухгүй, өлөн очно. Дараа нь Норвелийн музей үзэж, чөлөөт худалдаа хийнэ. Оройн хоолоо идээд буудалдаа амарна.";
const NORVEL = trip({
  id: "t-norvel", route_name: "ТУРШИЛТ – НОРВЕЛ ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ", duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-12-02"],
  hotel: "Галт тэрэг; Норвел: Old Inn/Лумиа; Эрээн: Border Hotel",
  extra: { itinerary_days: [
    { day: 1, title: "Улаанбаатар – Замын-Үүд", hotel: "Галт тэрэг", meals: { breakfast: false, lunch: false, dinner: false }, description: "УБ - Замын Үүд чиглэлийн галт тэрэг 16:40-д хөдлөх бөгөөд 1 цагийн өмнө галт тэрэгний буудал дээр цуглана." },
    { day: 2, title: "Эрээн – Норвел", hotel: "Old Inn/Лумиа", meals: { breakfast: false, lunch: false, dinner: true }, description: SAVED_DAY_2 },
    { day: 3, title: "Норвел хотын үзлэг", hotel: "Old Inn/Лумиа", meals: { breakfast: false, lunch: false, dinner: true }, description: SAVED_DAY_3 },
    { day: 4, title: "Норвел – Эрээн", hotel: "Border Hotel", meals: { breakfast: true, lunch: false, dinner: false }, description: "Өглөөний цайгаа уугаад автобусаар Эрээн хот руу хөдөлнө. Орой Эрээн хотод ирж буудалдаа амарна." },
    { day: 5, title: "Эрээн – Замын-Үүд", hotel: "Галт тэрэг", meals: { breakfast: true, lunch: false, dinner: false }, description: "Өглөөний цайгаа уугаад чөлөөтэй худалдаа хийнэ. 18:05 цагт Замын-Үүдээс Улаанбаатар чиглэлийн галт тэргэнд сууна." },
    { day: 6, title: "Улаанбаатар", hotel: "", meals: { breakfast: false, lunch: false, dinner: false }, description: "Өглөө 09:20 цагт Улаанбаатар хотод ирснээр аялал өндөрлөнө." },
  ] },
});

// The partner's file, in its own wording.
const FILE_DAYS = [
  { title: "Улаанбаатар-Замын үүд", hotel: "галт тэрэг", meals: { breakfast: false, lunch: false, dinner: false }, text: "16:40 цагт Улаанбаатарын галт тэрэгний өртөөнөөс Замын үүдийн чиглэлийн галт тэргэнд сууж хөдөлнө. Энэ өдөр галт тэргэнд хононо." },
  { title: "Эрээн-Норвел", hotel: "new inn /lumia", meals: { breakfast: null, lunch: null, dinner: true }, text: "07:20 цагт Замын үүдэд ирж галт тэрэгнээс бууж хил гарах унаанд сууж Эрээн хотруу явна. Хоёр улсын хил гаалиар нэвтэрч өдөр Эрээн хотод орж ирээд аялагчид өдрийн хоолоо өөрсдөө төлж иднэ. Үүний дараа аяллын автобусанд сууж Норвел хотруу явна. Норвел хотод очоод буудалдаа ороод орой хоолоо идээд амарна. 22:00 цагаас хойш хоол идэхгүй ус уухгүй хононо. Өглөө үзлэгтээ бэлдэнэ." },
  { title: "Норвел хотын үзлэг", hotel: "new inn/lumia", meals: { breakfast: true, lunch: null, dinner: true }, text: "Үзлэгт орох хүмүүс өглөөний цай уухгүй өлөн байх хэрэгтэй. Үүний дараа Норвелийн музей үзнэ. Дараа нь чөлөөтэй шоппин хийх боломжтой. Оройн хоолоо идээд буудалдаа орж амарна." },
  { title: "Норвел-Эрээн хот", hotel: "border hotel", meals: { breakfast: true, lunch: null, dinner: null }, text: "Өглөөний цайгаа уугаад Норвел хотоос автобусанд сууж Эрээн хотруу хөдөлнө. Орой Эрээн хотод ирээд буудалдаа орж амарна." },
  { title: "Эрээн хот-Замын үүд", hotel: "галт тэрэг", meals: { breakfast: true, lunch: null, dinner: null }, text: "Өглөөний цайгаа уугаад 13 цаг хүртэл чөлөөтэй худалдаа хийх боломжтой. 18:05 цагт Замын үүдээс галт тэргэнд суугаад Улаанбаатар хотруу хөдөлнө." },
  { title: "Улаанбаатар", hotel: "", meals: {}, text: "Өглөө 09:20 цагт Улаанбаатар хотод ирснээр аялал өндөрлөнө." },
];
const FILE_TEXT = FILE_DAYS.map((day, index) => `Өдөр ${index + 1}\t${day.title}\tБуудал: ${day.hotel}\n\t${day.text}`).join("\n");
const ADDED = "22:00 цагаас хойш хоол идэхгүй ус уухгүй хононо. Өглөө үзлэгтээ бэлдэнэ.";

test("the comparison names exactly what the file changed: two hotels, two new sentences, one meal; nothing else", async () => {
  const { compareProgram } = await import("../src/lib/assistantAgent/programCompare");
  const result = compareProgram(NORVEL, FILE_DAYS, FILE_TEXT);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.alignment, "file day N = saved day N");
  assert.deepEqual(result.days, [
    { saved_day: 2, file_day: 2, title: "Эрээн – Норвел", hotel: { saved: "Old Inn/Лумиа", file: "new inn /lumia", write: "New Inn/Lumia" },
      new_in_file: ["22:00 цагаас хойш хоол идэхгүй ус уухгүй хононо.", "Өглөө үзлэгтээ бэлдэнэ."] },
    { saved_day: 3, file_day: 3, title: "Норвел хотын үзлэг", hotel: { saved: "Old Inn/Лумиа", file: "new inn/lumia", write: "New Inn/Lumia" },
      meals_differ: [{ meal: "breakfast", saved: false, file: true }] },
  ]);
  assert.deepEqual(result.trip_hotel_line, { saved: "Галт тэрэг; Норвел: Old Inn/Лумиа; Эрээн: Border Hotel", write: "Галт тэрэг; Норвел: New Inn/Lumia; Эрээн: Border Hotel" });
  assert.deepEqual(result.unchanged_days, [1, 4, 5, 6], "the same program in the partner's wording is not a difference; the train days keep the house wording");
  assert.deepEqual([result.file_days_beyond_saved, result.saved_days_not_in_file, result.not_in_file_text], [[], [], []]);
  assert.match(result.apply, /Never replace saved sentences with the file's wording/);
});

test("a file that starts at the border lines up one day later; days the model did not copy from the file are refused", async () => {
  const { compareProgram } = await import("../src/lib/assistantAgent/programCompare");
  const fromBorder = compareProgram(NORVEL, FILE_DAYS.slice(1, 5), FILE_TEXT);
  assert.equal(fromBorder.ok, true);
  if (!fromBorder.ok) return;
  assert.match(fromBorder.alignment, /file day N = saved day N\+1/);
  assert.deepEqual(fromBorder.days.map((day) => [day.file_day, day.saved_day, day.hotel?.write ?? null]), [[1, 2, "New Inn/Lumia"], [2, 3, "New Inn/Lumia"]]);
  assert.deepEqual(fromBorder.saved_days_not_in_file, [], "the house's own train days around a border-to-border file are not a difference");

  const invented = compareProgram(NORVEL, FILE_DAYS.map((day) => ({ ...day, text: "Энэ өдөр аялагчид шинэ газар үзнэ, огт өөр хөтөлбөр." })), FILE_TEXT);
  assert.deepEqual(invented, { ok: false, reason: "file_days[].text must be copied from the attached file word for word (most of these days are not in the file's text)." });
  assert.equal(compareProgram(NORVEL, [FILE_DAYS[0]], FILE_TEXT).ok, false, "one day is not a program");
  assert.equal(compareProgram(trip({ id: "t-none", route_name: "ХӨТӨЛБӨРГҮЙ АЯЛАЛ" }), FILE_DAYS, FILE_TEXT).ok, false);
});

test("a day's saved wording is kept: adding a sentence passes, the file's raw text over it does not", async () => {
  const { rewritesSavedDay, cleanHotelName, hotelLineAfter, sentencesOf } = await import("../src/lib/assistantAgent/programCompare");
  // The trip's own hotel line follows the days: new names in place, a stay the program no longer has dropped.
  assert.equal(
    hotelLineAfter("Галт тэрэг; Норвел: Old Inn/Лумиа; Саун амралтын төв; Эрээн: Border/Лун", [
      { saved: "Old Inn/Лумиа", write: "New Inn/Lumia" }, { saved: "Саун амралтын төв", write: "New Inn/Lumia" }, { saved: "Border/Лун", write: "Border/Jin" },
    ]),
    "Галт тэрэг; Норвел: New Inn/Lumia; Эрээн: Border/Jin",
  );
  assert.equal(hotelLineAfter("Галт тэрэг; Норвел: Old Inn", [{ saved: "Another Inn", write: "New Inn" }]), "", "a line that names none of the changed hotels stays");
  assert.equal(hotelLineAfter("", [{ saved: "Old Inn", write: "New Inn" }]), "");
  assert.equal(rewritesSavedDay(SAVED_DAY_2, `${SAVED_DAY_2} ${ADDED}`), false);
  assert.equal(rewritesSavedDay(SAVED_DAY_2, SAVED_DAY_2.replace(" Дараа нь аяллын автобусаар Норвел хот руу явж, буудалдаа байрлан оройн хоолоо идээд амарна.", "")), false, "one sentence cut, the rest kept");
  assert.equal(rewritesSavedDay(SAVED_DAY_2, FILE_DAYS[1].text), true);
  assert.equal(rewritesSavedDay("Чөлөөт өдөр.", "Огт өөр өдөр, шинэ хөтөлбөр."), false, "a one-line day has no wording to protect");
  assert.equal(cleanHotelName(" oulian/ jintai "), "Oulian/Jintai");
  assert.equal(cleanHotelName("Галт тэрэг"), "Галт тэрэг");
  assert.deepEqual(sentencesOf("Өглөөний цай. 18.00 цагт хөдөлнө! Замдаа 4–5 цаг явна"), ["Өглөөний цай.", "18.00 цагт хөдөлнө!", "Замдаа 4–5 цаг явна"]);
});

async function run(instruction: string, steps: Parameters<typeof scriptedChat>[0], extra: Record<string, unknown> = {}) {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat(steps);
  const result = await runAgent({ instruction, trips: [NORVEL], today: NOW, deps: agentDeps(script.chat), documents: [{ name: "норвел-шинэ.doc", text: FILE_TEXT }], ...extra });
  return { ...result, script };
}
type Action = Record<string, unknown> & { action: string; trip_id: string; summary: string };
const actionsOf = (outcome: { kind: string }) => {
  assert.equal(outcome.kind, "proposal", JSON.stringify(outcome));
  return (outcome as unknown as { proposal: { actions: Action[] } }).proposal.actions;
};

test("the whole turn: compare first, the raw rewrite is sent back, the proposal keeps the saved text and changes only what differs", async () => {
  const result = await run("«ТУРШИЛТ – НОРВЕЛ ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ»-ын хөтөлбөрийг энэ файлаар шинэчил", [
    () => [{ name: "search_trips", args: { query: "Норвел хотын үзлэгтэй" } }],
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: FILE_DAYS } }],
    ({ messages }) => {
      const compared = JSON.parse(toolResults(messages).at(-1)!);
      assert.deepEqual(compared.days.map((day: { saved_day: number }) => day.saved_day), [2, 3]);
      // The model still pastes the file's text over day 2 and day 3.
      return [{ name: "propose_changes", args: { reply_text: "Шинэчиллээ.", actions: [
        { action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, description: FILE_DAYS[1].text, summary: "" },
        { action: "patch_itinerary_day", trip_id: "t-norvel", day: 3, description: FILE_DAYS[2].text, summary: "" },
      ] } }];
    },
    ({ messages }) => {
      const refused = JSON.parse(toolResults(messages).at(-1)!);
      assert.equal(refused.ok, false);
      assert.match(refused.refused, /2-р өдөр: хадгалсан тайлбарыг файлын үгээр бүхэлд нь солихгүй/);
      assert.match(refused.refused, /3-р өдөр: хадгалсан тайлбарыг файлын үгээр бүхэлд нь солихгүй/);
      return [{ name: "propose_changes", args: { reply_text: "2-р өдөрт хоёр өгүүлбэр нэмэгдэж, 2, 3-р өдрийн буудал New Inn/Lumia болно. 3-р өдрийн өглөөний цай файлд багтсан гэжээ. Бусад нь таарч байна.", actions: [
        { action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, hotel: "New Inn/Lumia", description: `${SAVED_DAY_2} ${ADDED}`, summary: "" },
        { action: "patch_itinerary_day", trip_id: "t-norvel", day: 3, hotel: "New Inn/Lumia", summary: "" },
        { action: "patch", trip_id: "t-norvel", fields: { hotel: "Галт тэрэг; Норвел: New Inn/Lumia; Эрээн: Border Hotel" }, summary: "" },
      ] } }];
    },
  ]);
  assert.deepEqual(result.tools, ["search_trips", "get_trip", "compare_program", "propose_changes", "propose_changes"]);
  const actions = actionsOf(result.outcome);
  assert.deepEqual(actions.map((action) => [action.action, action.day ?? null, action.hotel ?? (action.fields as { hotel?: string } | undefined)?.hotel ?? null]), [
    ["patch_itinerary_day", 2, "New Inn/Lumia"], ["patch_itinerary_day", 3, "New Inn/Lumia"], ["patch", null, "Галт тэрэг; Норвел: New Inn/Lumia; Эрээн: Border Hotel"],
  ]);
  assert.equal(actions[0].description, `${SAVED_DAY_2} ${ADDED}`);
  assert.equal(actions[1].description, undefined, "day 3 keeps its text: only the hotel changes");
  assert.ok(actions.every((action) => action.expected_updated_at === VERSION));
  // The meal the file states differently is left alone and said on the card by code, whatever the model wrote.
  const notes = (result.outcome as unknown as { proposal: { conflict_items: Array<{ type: string; text: string; severity: string }> } }).proposal.conflict_items.filter((item) => item.type === "program_compare_note");
  assert.deepEqual(notes.map((item) => [item.severity, item.text]), [["info", "«ТУРШИЛТ – НОРВЕЛ ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ» 3-р өдөр: файлд өглөөний цай багтсан гэжээ, хадгалсан нь багтаагүй — хоолыг өөрчлөөгүй. Өөрчлөх бол «3-р өдрийн өглөөний цай багтсан болго» гэж бичнэ үү."]]);
  assert.ok(actions.every((action) => action.meals === undefined), "no meal is changed");
});

test("the admin's own 'бүхэлд нь соль' lifts the guard; without a file the tool says so", async () => {
  const whole = await run("«ТУРШИЛТ – НОРВЕЛ ХОТЫН ҮЗЛЭГТЭЙ АЯЛАЛ»-ын 2-р өдрийн тайлбарыг энэ файлын үгээр бүхэлд нь соль", [
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }],
    () => [{ name: "propose_changes", args: { reply_text: "", actions: [{ action: "patch_itinerary_day", trip_id: "t-norvel", day: 2, description: FILE_DAYS[1].text, summary: "" }] } }],
  ]);
  assert.equal(actionsOf(whole.outcome)[0].description, FILE_DAYS[1].text);

  const typed = await run("норвел аяллын хөтөлбөрийг шинэчил", [
    () => [{ name: "get_trip", args: { trip_id: "t-norvel" } }],
    () => [{ name: "compare_program", args: { trip_id: "t-norvel", file_days: FILE_DAYS } }],
    ({ messages }) => {
      assert.match(JSON.parse(toolResults(messages).at(-1)!).error, /No file is attached/);
      return [{ name: "reply", args: { text: "Файлаа хавсаргана уу." } }];
    },
  ], { documents: [] });
  assert.equal(typed.outcome.kind, "note");
});
