import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { CollectState } from "../src/lib/bookingCollect";

// bookingCollect.ts transitively imports redisState.ts, which calls getEnv()
// eagerly at module load — env vars must be set before that import resolves.
let mod: typeof import("../src/lib/bookingCollect");
let flow: typeof import("../src/lib/bookingCollectFlow");

before(async () => {
  applyTestEnv();
  mod = await import("../src/lib/bookingCollect");
  flow = await import("../src/lib/bookingCollectFlow");
});

const TRIP = "Альфа- Зэт газар нислэг хосолсон аялал";

test("the flow starts at the contact step and pre-fills the trip being discussed", () => {
  const state = mod.startCollectState("Захиалах", TRIP);
  assert.equal(state.step, "phone");
  assert.equal(state.trip, TRIP);
  const prompt = mod.promptForStep(state.step, state);
  assert.match(prompt, /Нэр, утасны дугаараа бичнэ үү/);
  assert.ok(prompt.includes(`«${TRIP}»`));
  // The catalogue link still goes out with the very first question.
  assert.match(prompt, /https:\/\/uudam-booking-web\.vercel\.app/);
});

test("name and phone in one message complete the booking when the trip is known", () => {
  const state = mod.startCollectState("Захиалах", TRIP);
  const result = mod.advanceCollectState(state, "Болормаа 99112233", "99112233");
  assert.equal(result.kind, "done");
  if (result.kind !== "done") return;
  assert.equal(result.state.name, "Болормаа");
  assert.equal(result.state.phone, "99112233");
  assert.equal(result.state.trip, TRIP);
});

test("a name alone is kept and the phone is asked for by name", () => {
  const state = mod.startCollectState("Захиалах", TRIP);
  const result = mod.advanceCollectState(state, "Бат", "");
  assert.equal(result.kind, "ask");
  if (result.kind !== "ask") return;
  assert.equal(result.state.name, "Бат");
  assert.match(result.prompt, /Баярлалаа, Бат!.*утасны дугаараа/);
  const done = mod.advanceCollectState(result.state, "99112233", "99112233");
  assert.equal(done.kind, "done");
});

test("without a known trip the flow asks which one after the phone", () => {
  const state = mod.startCollectState("Захиалах");
  const result = mod.advanceCollectState(state, "99112233", "99112233");
  assert.equal(result.kind, "ask");
  if (result.kind !== "ask") return;
  assert.equal(result.state.step, "trip");
  const done = mod.advanceCollectState(result.state, "Альфа аялал", "");
  assert.equal(done.kind, "done");
  if (done.kind === "done") assert.equal(done.state.trip, "Альфа аялал");
});

test("questions and button taps are NOT taken as a name or phone (replayed 2026-09-11 / 07-29 chats)", () => {
  // Real customers answered the booking question with these; the old flow
  // stored them as name → phone → trip and replied "oor aylal hari, мэдээллийг
  // хүлээн авлаа. Манай ажилтан bi zet ... дугаарт удахгүй холбогдоно".
  for (const text of [
    "oor aylal hari",
    "bi zet aylalin medeelel hariya",
    "бүх аяллын мэдээлэл авья",
    "Хөтөлбөр үзэх",
    "Зөвлөхтэй холбогдох",
    "2. Альфа- Зэт ...",
    "үнэ хэд вэ?",
    "za bolchloo",
  ]) {
    const state = mod.startCollectState("Захиалах", TRIP);
    assert.equal(mod.advanceCollectState(state, text, "").kind, "abandon", text);
  }
});

test("a trip or destination typed at the name step is not a name", () => {
  const state = mod.startCollectState("Захиалах");
  const result = mod.advanceCollectState(state, "Зэт Альфа", "", { looksLikeTrip: () => true });
  assert.equal(result.kind, "abandon");
});

test("looksLikePersonName accepts real names and rejects requests", () => {
  for (const name of ["Бат", "Б. Болор", "Nomin Bat", "Сайнбаяр", "Сараа", "Энхтуяа"]) {
    assert.ok(mod.looksLikePersonName(name), name);
  }
  for (const text of ["hi", "за", "тиймээ юу", "Medeelel avay", "99112233", "үнэ?", "a b c d"]) {
    assert.ok(!mod.looksLikePersonName(text), text);
  }
});

test("advanceCollectState is a no-op once the flow is done", () => {
  const done: CollectState = {
    step: "done",
    name: "Бат",
    phone: "99112233",
    trip: "Альфа",
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const next = mod.advanceCollectState(done, "дахиад нэг зүйл бичлээ", "");
  assert.deepEqual(next, { kind: "done", state: done });
});

test("buildLeadContext includes only the fields that were actually collected", () => {
  const partial: CollectState = {
    step: "phone",
    name: "Бат",
    phone: "",
    trip: "",
    originalMessage: "Захиалга авмаар байна",
    startedAt: Date.now(),
  };
  const context = mod.buildLeadContext(partial);
  assert.match(context, /Нэр: Бат/);
  assert.doesNotMatch(context, /Утас:/);
  assert.doesNotMatch(context, /Хүссэн аялал:/);
  assert.match(context, /Анхны мессеж: Захиалга авмаар байна/);
});

test("buildCompletionMessage names the trip and the number staff will call", () => {
  const state: CollectState = {
    step: "done",
    name: "Бат",
    phone: "99112233",
    trip: TRIP,
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const msg = mod.buildCompletionMessage(state);
  assert.match(msg, /^Бат, баярлалаа!/);
  assert.ok(msg.includes(`«${TRIP}»`));
  assert.match(msg, /99112233 дугаарт/);
  const anonymous = mod.buildCompletionMessage({ ...state, name: "", trip: "" });
  assert.match(anonymous, /^Баярлалаа! Захиалгын хүсэлтийг хүлээн авлаа/);
});

test("isBareBookingRequest recognises a repeated 'book it' but not a new question", () => {
  for (const text of ["Захиалах", "zahialga hiie", "захиалга өгмөөр байна", "Захиалъя"]) {
    assert.ok(flow.isBareBookingRequest(text), text);
  }
  for (const text of ["Зэт аялал захиалах уу", "захиалга хийхэд урьдчилгаа хэд вэ"]) {
    assert.ok(!flow.isBareBookingRequest(text), text);
  }
});
