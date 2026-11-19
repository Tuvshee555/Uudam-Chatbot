/**
 * From the admin's assistant chats of 2026-11-14..19 (scripted model, no network; invented trips):
 * a tapped option on a one-trip question stays on that trip; «ноорог» lists draft trips;
 * «бүрэн засварлах линк» is the admin editor of the trip.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { ALPHA, BETA, NOW, TRIPS, agentDeps, scriptedChat, toolResults } from "./helpers/agentFixtures";

applyTestEnv();

async function run(instruction: string, steps: Parameters<typeof scriptedChat>[0]) {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat(steps);
  return runAgent({ instruction, trips: TRIPS, today: NOW, deps: agentDeps(script.chat) });
}

type Ask = { ask: { options: Array<{ label: string; answer: string; hint?: string }> } };

test("a question about one trip: every option carries that trip, so the tap cannot drift to another", async () => {
  const result = await run("альфа аяллын хүүхдийн үнийг 1,890,000 болго", [
    () => [{ name: "search_trips", args: { query: "альфа" } }],
    () => [{ name: "get_trip", args: { trip_id: "t-alpha" } }],
    () => [{ name: "ask_user", args: { question: "Хүүхдийн аль ангиллын үнийг өөрчлөх вэ?", options: [
      { label: "Ортой", answer: "12/2, 12/9-ний хүүхэд ортой ангиллын үнийг 1,890,000₮ болго." },
      { label: "Оргүй", answer: "12/2, 12/9-ний хүүхэд оргүй ангиллын үнийг 1,890,000₮ болго." },
    ] } }],
  ]);
  assert.equal(result.outcome.kind, "ask");
  const { options } = (result.outcome as unknown as Ask).ask;
  for (const option of options) assert.match(option.answer, /\[сонгосон аялал: «ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ» id:t-alpha\]/);
});

test("a «which trip?» question keeps each option's own trip and never stamps one trip on all", async () => {
  const result = await run("12/2-ны аялал", [
    () => [{ name: "get_trip", args: { trip_id: "t-alpha" } }],
    () => [{ name: "ask_user", args: { question: "Аль аяллыг хэлж байна вэ?", options: [
      { label: "Альфа", answer: "«ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ»" },
      { label: "Бета", answer: "«БЕТА НУУРЫН АЯЛАЛ»" },
    ] } }],
  ]);
  const { options } = (result.outcome as unknown as Ask).ask;
  assert.ok(options.every((option) => !/id:t-alpha/.test(option.answer)), JSON.stringify(options));
});

test("«ноорог» lists draft trips, alone or narrowed by the rest of the words", async () => {
  const { searchTrips } = await import("../src/lib/assistantAgent/readTools");
  const trips = [...TRIPS, { ...BETA, id: "t-beta-draft", route_name: "БЕТА ДАЛАЙН АЯЛАЛ", status: "draft" as const }, { ...ALPHA, id: "t-alpha-draft", route_name: "АЛЬФА ШИНЭ АЯЛАЛ", status: "draft" as const }];
  const ids = (input: Parameters<typeof searchTrips>[1]) => searchTrips(trips, input, NOW).results.map((entry) => entry.trip_id).sort();
  assert.deepEqual(ids({ query: "ноорогт байгаа бүх аяллыг" }), ["t-alpha-draft", "t-beta-draft"]);
  assert.deepEqual(ids({ query: "", status: "draft" }), ["t-alpha-draft", "t-beta-draft"]);
  assert.deepEqual(ids({ query: "ноорогт байгаа бета" }), ["t-beta-draft"]);
  assert.match(String(searchTrips(TRIPS, { query: "ноорог" }, NOW).note), /ноорог төлөвтэй аялал олдсонгүй/);
});

test("«бүрэн засварлах линк» is the admin editor of the trip, for any status", async () => {
  const { adminEditorUrl, tripDetailView } = await import("../src/lib/assistantAgent/readTools");
  assert.equal(adminEditorUrl("t-alpha").endsWith("/admin?edit=t-alpha#trips"), true);
  const view = tripDetailView({ ...ALPHA, status: "draft" }, NOW, null);
  assert.equal(view.admin_editor_url.endsWith("/admin?edit=t-alpha#trips"), true);
  // The agent reads it from get_trip.
  const result = await run("альфа аяллын бүрэн засварлах линк", [
    () => [{ name: "get_trip", args: { trip_id: "t-alpha" } }],
    ({ messages }) => {
      const detail = JSON.parse(toolResults(messages).at(-1)!);
      assert.match(detail.admin_editor_url, /\/admin\?edit=t-alpha#trips$/);
      return [{ name: "reply", args: { text: `Засварлах линк: ${detail.admin_editor_url}` } }];
    },
  ]);
  assert.equal(result.outcome.kind, "note");
});
