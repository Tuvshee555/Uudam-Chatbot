import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { CollectState } from "../src/lib/bookingCollect";

// bookingCollect.ts transitively imports redisState.ts, which calls getEnv()
// eagerly at module load — env vars must be set before that import resolves.
let advanceCollectState: typeof import("../src/lib/bookingCollect").advanceCollectState;
let buildCompletionMessage: typeof import("../src/lib/bookingCollect").buildCompletionMessage;
let buildLeadContext: typeof import("../src/lib/bookingCollect").buildLeadContext;
let promptForStep: typeof import("../src/lib/bookingCollect").promptForStep;
let startCollectState: typeof import("../src/lib/bookingCollect").startCollectState;

before(async () => {
  applyTestEnv();
  const mod = await import("../src/lib/bookingCollect");
  advanceCollectState = mod.advanceCollectState;
  buildCompletionMessage = mod.buildCompletionMessage;
  buildLeadContext = mod.buildLeadContext;
  promptForStep = mod.promptForStep;
  startCollectState = mod.startCollectState;
});

test("startCollectState begins at the name step with empty fields", () => {
  const state = startCollectState("Сайн байна уу, захиалга хийе гэсэн юм");
  assert.equal(state.step, "name");
  assert.equal(state.name, "");
  assert.equal(state.phone, "");
  assert.equal(state.trip, "");
  assert.equal(state.originalMessage, "Сайн байна уу, захиалга хийе гэсэн юм");
});

test("promptForStep returns the right question per step, and nothing for done", () => {
  assert.match(promptForStep("name"), /нэрээ бичнэ/);
  assert.match(promptForStep("phone"), /утасны дугаараа/);
  assert.match(promptForStep("trip"), /аялалд бүртгүүлэх/);
  assert.equal(promptForStep("done"), "");
});

test("advanceCollectState walks name -> phone -> trip -> done in order", () => {
  let state = startCollectState("test");
  state = advanceCollectState(state, "Бат");
  assert.equal(state.step, "phone");
  assert.equal(state.name, "Бат");

  state = advanceCollectState(state, "99112233");
  assert.equal(state.step, "trip");
  assert.equal(state.phone, "99112233");

  state = advanceCollectState(state, "Бали аялал");
  assert.equal(state.step, "done");
  assert.equal(state.trip, "Бали аялал");
});

test("advanceCollectState is a no-op once the flow is done", () => {
  const done: CollectState = {
    step: "done",
    name: "Бат",
    phone: "99112233",
    trip: "Бали",
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const next = advanceCollectState(done, "дахиад нэг зүйл бичлээ");
  assert.deepEqual(next, done);
});

test("advanceCollectState truncates each field to its cap so a giant paste can't blow up storage", () => {
  let state = startCollectState("test");
  state = advanceCollectState(state, "a".repeat(500));
  assert.equal(state.name.length, 100);

  state = advanceCollectState(state, "1".repeat(500));
  assert.equal(state.phone.length, 40);

  state = advanceCollectState(state, "b".repeat(500));
  assert.equal(state.trip.length, 200);
});

test("advanceCollectState trims surrounding whitespace before storing", () => {
  let state = startCollectState("test");
  state = advanceCollectState(state, "   Бат   ");
  assert.equal(state.name, "Бат");
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
  const context = buildLeadContext(partial);
  assert.match(context, /Нэр: Бат/);
  assert.doesNotMatch(context, /Утас:/);
  assert.doesNotMatch(context, /Хүссэн аялал:/);
  assert.match(context, /Анхны мессеж: Захиалга авмаар байна/);
});

test("buildLeadContext includes every field once all three are collected", () => {
  const full: CollectState = {
    step: "done",
    name: "Бат",
    phone: "99112233",
    trip: "Бали аялал",
    originalMessage: "Захиалга авмаар байна",
    startedAt: Date.now(),
  };
  const context = buildLeadContext(full);
  assert.match(context, /Нэр: Бат/);
  assert.match(context, /Утас: 99112233/);
  assert.match(context, /Хүссэн аялал: Бали аялал/);
});

test("buildCompletionMessage falls back to 'Та' when no name was captured", () => {
  const state: CollectState = {
    step: "done",
    name: "",
    phone: "99112233",
    trip: "Бали",
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const msg = buildCompletionMessage(state);
  assert.match(msg, /^Та,/);
  assert.match(msg, /99112233 дугаарт/);
});

test("buildCompletionMessage uses the captured name and phone when present", () => {
  const state: CollectState = {
    step: "done",
    name: "Бат",
    phone: "99112233",
    trip: "Бали",
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const msg = buildCompletionMessage(state);
  assert.match(msg, /^Бат,/);
  assert.match(msg, /99112233 дугаарт/);
});

test("buildCompletionMessage omits the phone clause entirely when no phone was captured", () => {
  const state: CollectState = {
    step: "done",
    name: "Бат",
    phone: "",
    trip: "",
    originalMessage: "test",
    startedAt: Date.now(),
  };
  const msg = buildCompletionMessage(state);
  assert.doesNotMatch(msg, /дугаарт/);
});
